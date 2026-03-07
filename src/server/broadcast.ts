/**
 * Broadcast loop — periodic dashboard state broadcasting.
 * Handles credit tracking, economy updates, faction polling.
 * Extracted from v2 index.ts (L1793-2011).
 */

import type { BotManager } from "../bot/bot-manager";
import type { Commander } from "../commander/commander";
import type { EconomyEngine } from "../commander/economy-engine";
import type { Galaxy } from "../core/galaxy";
import type { DB } from "../data/db";
import type { SocialChatMessage, SocialForumThread, SocialDM, FactionState, FactionMember, FactionFacility, OpenOrder, BrainDecisionStats } from "../types/protocol";
import { creditHistory, activityLog } from "../data/schema";
import { lt } from "drizzle-orm";
import type { TrainingLogger } from "../data/training-logger";
import { ChatIntelligence } from "../commander/chat-intelligence";
import { broadcast, getClientCount } from "./server";
import { promoteFactionMembers } from "../fleet/faction-manager";

export interface BroadcastDeps {
  botManager: BotManager;
  commander: Commander;
  economy: EconomyEngine;
  galaxy: Galaxy;
  db: DB;
  startTime: number;
  trainingLogger?: TrainingLogger;
}

const TICK_INTERVAL_MS = 3_000;
const SNAPSHOT_INTERVAL_TICKS = 10; // 30s
const CREDIT_HISTORY_INTERVAL_TICKS = 10; // 30s

// Cached 24h financial totals (refreshed from DB every 30s)
let cached24hTotals = { revenue: 0, cost: 0, profit: 0 };

// Module-level caches for faction data (shared between broadcast loop and pollFactionState)
let cachedFactionStorage: Array<{ itemId: string; itemName: string; quantity: number }> | null = null;
let cachedFactionCredits: number | null = null;
let cachedFacilities: FactionFacility[] | null = null;
let cachedFactionOrders: OpenOrder[] = [];
let factionDebugLogged = false;

/** Per-bot credit snapshots for rate calculation */
interface CreditSnapshot {
  timestamp: number;
  credits: number;
}

/**
 * Start the periodic broadcast loop. Returns a cleanup function.
 */
export function startBroadcastLoop(deps: BroadcastDeps): () => void {
  let tick = 0;
  const lastCredits = new Map<string, number>();
  const botSnapshots = new Map<string, CreditSnapshot[]>();
  const promotedBots = new Set<string>();
  const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
  let cachedOrders: OpenOrder[] = [];
  let lastSocialChatTick = 0;
  const SOCIAL_CHAT_INTERVAL_TICKS = 100; // ~5 minutes between faction chat messages

  // Chat intelligence — reads and learns from global/faction chat (shared with Commander)
  const botNames = deps.botManager.getAllBots().map(b => b.username);
  const memStore = deps.commander.getMemoryStore();
  const chatIntel = new ChatIntelligence(memStore, botNames);
  deps.commander.setChatIntelligence(chatIntel);

  const timer = setInterval(() => {
    tick++;

    const fleet = deps.botManager.getFleetStatus();

    // ── Credit Tracking ──
    // Use the Commander's economy engine so revenue/costs appear in economy_update
    const ecoTracker = deps.commander.getEconomy();
    for (const bot of fleet.bots) {
      if (bot.status !== "running") continue;
      const prev = lastCredits.get(bot.botId);
      if (prev !== undefined) {
        const delta = bot.credits - prev;
        if (delta > 0) {
          ecoTracker.recordRevenue(delta);
        } else if (delta < 0) {
          ecoTracker.recordCost(Math.abs(delta));
        }
      }
      lastCredits.set(bot.botId, bot.credits);

      // Periodic snapshots for CPH calculation
      if (tick % SNAPSHOT_INTERVAL_TICKS === 0) {
        const snaps = botSnapshots.get(bot.botId) ?? [];
        snaps.push({ timestamp: Date.now(), credits: bot.credits });

        // Prune old snapshots
        const cutoff = Date.now() - RATE_WINDOW_MS;
        const pruned = snaps.filter(s => s.timestamp > cutoff);
        botSnapshots.set(bot.botId, pruned);
      }
    }

    // Credit history to DB (every 30s)
    if (tick % CREDIT_HISTORY_INTERVAL_TICKS === 0) {
      deps.db.insert(creditHistory)
        .values({
          timestamp: Date.now(),
          totalCredits: fleet.totalCredits,
          activeBots: fleet.activeBots,
        })
        .run();
    }

    // ── Maintenance Tasks ──

    // Promote faction members (every 60s)
    if (tick % 20 === 0) {
      promoteFactionMembers(deps.botManager, promotedBots).catch(err => {
        console.log(`[Broadcast] Promotion check failed: ${err instanceof Error ? err.message : err}`);
      });
    }

    // Prune old activity logs (every 30 min — keep last 24h)
    if (tick % 600 === 0) {
      try {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        deps.db.delete(activityLog).where(lt(activityLog.timestamp, cutoff)).run();
      } catch { /* non-critical */ }
    }

    // ── Dashboard Broadcasts ──
    if (getClientCount() === 0) return;

    // Fleet update (every 3s) — use full BotSummary (not FleetBotInfo) for dashboard
    const botSummaries = deps.botManager.getSummaries().map(b => {
      const snaps = botSnapshots.get(b.id) ?? [];
      let creditsPerHour = 0;
      if (snaps.length >= 4) {
        const oldest = snaps[0];
        const elapsed = Date.now() - oldest.timestamp;
        if (elapsed > 0) {
          creditsPerHour = Math.round(((b.credits - oldest.credits) / elapsed) * 3_600_000);
        }
      }
      return { ...b, creditsPerHour };
    });

    broadcast({
      type: "fleet_update",
      bots: botSummaries,
    });

    // Stats update (every 6s)
    if (tick % 2 === 0) {
      const totalCph = botSummaries.reduce((s, b) => s + (b.creditsPerHour ?? 0), 0);
      broadcast({
        type: "stats_update",
        stats: {
          totalCredits: fleet.totalCredits,
          creditsPerHour: totalCph,
          activeBots: fleet.activeBots,
          totalBots: fleet.bots.length,
          uptime: Date.now() - deps.startTime,
          apiCallsToday: { mutations: 0, queries: 0 },
        },
      });
    }

    // Commander decision + economy + brain health (every 15s)
    if (tick % 5 === 0) {
      const decision = deps.commander.getLastDecision();
      if (decision) {
        broadcast({
          type: "commander_decision",
          decision,
        });
      }

      // Brain health
      const healthList = deps.commander.getBrainHealths();
      if (healthList.length > 0) {
        broadcast({
          type: "brain_health_update",
          brains: healthList.map(h => ({
            name: h.name,
            available: h.available,
            avgLatencyMs: h.avgLatencyMs,
            successRate: h.successRate,
            lastError: h.lastError ?? null,
            totalCalls: 0,
          })),
        });
      }

      // Brain decision stats (LLM vs scoring breakdown)
      if (deps.trainingLogger) {
        const decisionStats = deps.trainingLogger.getBrainDecisionStats();
        const shadowStats = deps.trainingLogger.getShadowStats();
        broadcast({
          type: "brain_decision_stats",
          stats: {
            ...decisionStats,
            shadowStats: shadowStats.totalComparisons > 0
              ? { totalComparisons: shadowStats.totalComparisons, avgAgreementRate: shadowStats.avgAgreementRate }
              : null,
          },
        });
      }

      // Memory update
      const memStore = deps.commander.getMemoryStore();
      if (memStore) {
        broadcast({
          type: "memory_update",
          memories: memStore.getAll().map((m) => ({
            key: m.key,
            fact: m.fact,
            importance: m.importance,
            updatedAt: m.updatedAt,
          })),
        });
      }

      // Stuck bots update
      const stuckBots = deps.commander.getStuckBots();
      broadcast({
        type: "stuck_bots_update",
        stuckBots,
      });

      const ecoEngine = deps.commander.getEconomy();
      if (ecoEngine) {
        const snap = ecoEngine.analyze(fleet);
        broadcast({
          type: "economy_update",
          economy: {
            deficits: snap.deficits.map(d => ({
              itemId: d.itemId,
              itemName: d.itemId.replace(/_/g, " "),
              demandPerHour: d.demandPerHour,
              supplyPerHour: d.supplyPerHour,
              shortfall: d.shortfall,
              priority: d.priority,
            })),
            surpluses: snap.surpluses.map(s => ({
              itemId: s.itemId,
              itemName: s.itemId.replace(/_/g, " "),
              excessPerHour: s.excessPerHour,
              stationId: s.stationId,
              stationName: s.stationId,
              currentStock: s.currentStock,
            })),
            openOrders: [...cachedOrders, ...cachedFactionOrders],
            totalRevenue24h: cached24hTotals.revenue,
            totalCosts24h: cached24hTotals.cost,
            netProfit24h: cached24hTotals.profit,
          },
        });
      }
    }

    // Galaxy update (every 30s, only if dirty)
    if (tick % 10 === 0 && deps.galaxy.dirty) {
      broadcast({
        type: "galaxy_update",
        systems: deps.galaxy.toSummaries(),
      });
      deps.galaxy.dirty = false;
    }

    // Faction state polling (every 60s)
    if (tick % 20 === 0) {
      pollFactionState(deps).catch(() => {});
    }

    // Auto-diplomacy: accept peace proposals (every 5 minutes)
    if (tick % 100 === 0) {
      handleAutoDiplomacy(deps).catch(() => {});
    }

    // Faction bulletin board update (every 10 minutes)
    if (tick % 200 === 0) {
      updateFactionBulletinBoard(deps).catch(() => {});
    }

    // Faction missions for missing materials (every 10 minutes)
    if (tick % 200 === 5) {
      postFactionMissionsForDeficits(deps).catch(() => {});
    }

    // Open orders polling (every 30s)
    if (tick % 10 === 0) {
      pollOpenOrders(deps).then(orders => {
        cachedOrders = orders;
      }).catch(() => {});

      // Refresh 24h financial totals from DB (persists across restarts)
      if (deps.trainingLogger) {
        try { cached24hTotals = deps.trainingLogger.get24hFinancialTotals(); } catch { /* non-critical */ }
      }
    }

    // Social feed polling (every 30s — uses bot API queries)
    if (tick % 10 === 0) {
      pollSocialFeed(deps).catch(() => {});
    }

    // Chat intelligence: read + analyze + reply (~every 30s for reading, ~5min for status posting)
    if (tick % 10 === 0) {
      chatIntel.updateBotNames(deps.botManager.getAllBots().map(b => b.username));
      readAndRespondToChat(deps, chatIntel).catch(() => {});
    }
    if (tick - lastSocialChatTick >= SOCIAL_CHAT_INTERVAL_TICKS) {
      lastSocialChatTick = tick;
      postFactionChatUpdate(deps).catch(() => {});
    }

  }, TICK_INTERVAL_MS);

  return () => clearInterval(timer);
}

/** Poll faction info + storage and broadcast to dashboard */
async function pollFactionState(deps: BroadcastDeps): Promise<void> {
  if (getClientCount() === 0) return;

  const bots = deps.botManager.getAllBots();
  const readyBots = bots.filter(b => (b.status === "running" || b.status === "ready") && b.api);
  if (readyBots.length === 0) return;

  // Prefer a docked bot — viewFactionStorage requires docking
  const dockedBot = readyBots.find(b => b.player?.dockedAtBase);
  const readyBot = dockedBot ?? readyBots[0];
  const api = readyBot.api!;
  const fleetConfig = deps.botManager.fleetConfig;

  try {
    // Storage requires docking; faction_info and faction_rooms work anywhere
    const isDocked = !!readyBot.player?.dockedAtBase;
    const [factionInfo, storageFull, factionRooms, intelStatus, tradeIntelStatus, factionMissions, factionOrders] = await Promise.all([
      api.factionInfo().catch((e: unknown) => {
        console.log(`[Broadcast] factionInfo() failed: ${e instanceof Error ? e.message : e}`);
        return null;
      }),
      isDocked
        ? api.viewFactionStorageFull().catch((e: unknown) => {
            console.log(`[Broadcast] Faction storage fetch failed: ${e instanceof Error ? e.message : e}`);
            return null;
          })
        : Promise.resolve(null),
      // faction_rooms doesn't require docking — always try
      api.factionRooms().catch((e: unknown) => {
        console.log(`[Broadcast] Faction rooms fetch failed: ${e instanceof Error ? e.message : e}`);
        return [];
      }),
      api.factionIntelStatus().catch(() => null),
      api.factionTradeIntelStatus().catch(() => null),
      api.factionListMissions().catch(() => []),
      // Note: faction orders are polled via pollOpenOrders() on the quartermaster bot
      // viewOrders() returns personal orders, not faction orders — don't duplicate here
      Promise.resolve([]),
    ]);

    if (!factionInfo) {
      console.log(`[Broadcast] factionInfo() returned null — bot may not be in a faction`);
      return;
    }

    const info = factionInfo as Record<string, unknown>;

    // Debug: log faction_info keys once to understand API response shape
    if (!factionDebugLogged) {
      factionDebugLogged = true;
      console.log(`[Broadcast] faction_info keys: ${Object.keys(info).join(", ")}`);
      console.log(`[Broadcast] faction rooms: ${factionRooms.length} room(s) ${JSON.stringify(factionRooms).slice(0, 300)}`);
      if (isDocked) {
        console.log(`[Broadcast] faction storage: ${storageFull ? `${storageFull.items.length} items, ${storageFull.credits} credits` : "null"}`);
      } else {
        console.log(`[Broadcast] Bot not docked — skipped storage fetch (rooms fetched independently)`);
      }
    }

    const factionId = String(info.faction_id ?? info.id ?? "");
    if (!factionId) return;

    // Parse members
    const rawMembers = (info.members ?? []) as Array<Record<string, unknown>>;
    const members: FactionMember[] = rawMembers.map(m => ({
      playerId: String(m.player_id ?? m.playerId ?? ""),
      username: String(m.username ?? m.name ?? ""),
      role: String(m.role ?? "member"),
      online: Boolean(m.online ?? m.is_online ?? false),
      lastSeen: m.last_seen ? String(m.last_seen) : null,
    }));

    // Parse facilities — from faction_rooms API, faction_info fallback, then cache
    let facilities: FactionFacility[];
    if (factionRooms.length > 0) {
      facilities = factionRooms.map(f => ({
        id: String(f.id ?? f.room_id ?? ""),
        name: String(f.name ?? f.room_name ?? "Unknown"),
        type: String(f.type ?? f.room_type ?? "room"),
        systemId: String(f.system_id ?? f.systemId ?? f.system ?? ""),
        systemName: String(f.system_name ?? f.systemName ?? ""),
        status: String(f.status ?? "active"),
      }));
      cachedFacilities = facilities;
    } else {
      // Try faction_info fields, then cache
      const infoFacilities = (info.facilities ?? info.rooms ?? info.stations ?? []) as Array<Record<string, unknown>>;
      if (infoFacilities.length > 0) {
        facilities = infoFacilities.map(f => ({
          id: String(f.id ?? f.facility_id ?? f.room_id ?? ""),
          name: String(f.name ?? f.room_name ?? "Unknown"),
          type: String(f.type ?? f.facility_type ?? f.room_type ?? "room"),
          systemId: String(f.system_id ?? f.systemId ?? f.system ?? ""),
          systemName: String(f.system_name ?? f.systemName ?? ""),
          status: String(f.status ?? "active"),
        }));
        cachedFacilities = facilities;
      } else {
        facilities = cachedFacilities ?? [];
      }
    }

    // Parse allies/enemies
    const rawAllies = (info.allies ?? []) as Array<Record<string, unknown>>;
    const allies = rawAllies.map(a => ({
      factionId: String(a.faction_id ?? a.factionId ?? a.id ?? ""),
      name: String(a.name ?? a.faction_name ?? ""),
    }));

    const rawEnemies = (info.enemies ?? info.wars ?? []) as Array<Record<string, unknown>>;
    const enemies = rawEnemies.map(e => ({
      factionId: String(e.faction_id ?? e.factionId ?? e.id ?? ""),
      name: String(e.name ?? e.faction_name ?? ""),
    }));

    // Build storage items — use fresh data if available, otherwise use cache
    let storageItems: Array<{ itemId: string; itemName: string; quantity: number }>;
    let factionCredits: number;

    if (storageFull) {
      storageItems = [];
      for (const item of storageFull.items) {
        if (item.quantity > 0) {
          const itemName = storageFull.itemNames.get(item.itemId)
            ?? item.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
          storageItems.push({ itemId: item.itemId, itemName, quantity: item.quantity });
        }
      }
      storageItems.sort((a, b) => b.quantity - a.quantity);
      factionCredits = storageFull.credits;
      // Update cache
      cachedFactionStorage = storageItems;
      cachedFactionCredits = factionCredits;
    } else {
      // Use cached data if no docked bot available
      storageItems = cachedFactionStorage ?? [];
      factionCredits = cachedFactionCredits
        ?? Number(info.credits ?? info.treasury ?? info.faction_credits ?? 0);
    }

    const faction: FactionState = {
      id: factionId,
      name: String(info.name ?? info.faction_name ?? ""),
      tag: String(info.tag ?? info.ticker ?? ""),
      credits: factionCredits,
      memberCount: members.length || Number(info.member_count ?? info.memberCount ?? 0),
      members,
      storage: storageItems,
      facilities,
      allies,
      enemies,
      commanderAware: fleetConfig.defaultStorageMode === "faction_deposit",
      storageMode: fleetConfig.defaultStorageMode ?? "sell",
      intelCoverage: intelStatus
        ? { systemsSubmitted: Number((intelStatus as Record<string, unknown>).systems_submitted ?? (intelStatus as Record<string, unknown>).systemsSubmitted ?? 0), totalSystems: Number((intelStatus as Record<string, unknown>).total_systems ?? (intelStatus as Record<string, unknown>).totalSystems ?? 0) }
        : null,
      tradeIntelCoverage: tradeIntelStatus
        ? { stationsSubmitted: Number((tradeIntelStatus as Record<string, unknown>).stations_submitted ?? (tradeIntelStatus as Record<string, unknown>).stationsSubmitted ?? 0), totalStations: Number((tradeIntelStatus as Record<string, unknown>).total_stations ?? (tradeIntelStatus as Record<string, unknown>).totalStations ?? 0) }
        : null,
      orders: (factionOrders as Array<Record<string, unknown>>).map(o => ({
        id: String(o.id ?? o.order_id ?? ""),
        type: (String(o.type ?? o.order_type ?? "sell") as "buy" | "sell"),
        itemId: String(o.itemId ?? o.item_id ?? ""),
        itemName: String(o.itemName ?? o.item_name ?? String(o.itemId ?? o.item_id ?? "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())),
        quantity: Number(o.quantity ?? 0),
        filled: Number(o.quantity ?? 0) - Number(o.remaining ?? o.quantity ?? 0),
        priceEach: Number(o.priceEach ?? o.price_each ?? o.price ?? 0),
        stationName: String(o.stationName ?? o.station_name ?? o.stationId ?? o.station_id ?? ""),
      })),
      missions: factionMissions.map(m => ({
        id: String(m.id ?? m.template_id ?? m.mission_id ?? ""),
        title: String(m.title ?? m.name ?? "Unknown Mission"),
        description: String(m.description ?? m.desc ?? ""),
        type: String(m.type ?? m.mission_type ?? "delivery"),
        status: String(m.status ?? "active"),
        createdAt: String(m.created_at ?? m.createdAt ?? new Date().toISOString()),
      })),
    };

    // Cache faction orders as OpenOrder[] for economy tab
    cachedFactionOrders = (faction.orders ?? []).map(o => ({
      id: `faction_${o.id}`,
      type: o.type,
      itemId: o.itemId,
      itemName: o.itemName,
      quantity: o.quantity,
      filled: o.filled,
      priceEach: o.priceEach,
      total: o.priceEach * o.quantity,
      stationId: "",
      stationName: o.stationName,
      createdAt: "",
      botId: "Faction",
      owner: "faction" as const,
    }));

    broadcast({ type: "faction_update", faction });
  } catch (err) {
    console.log(`[Broadcast] Faction poll failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Poll chat history and forum threads using a ready bot's API */
async function pollSocialFeed(deps: BroadcastDeps): Promise<void> {
  if (getClientCount() === 0) return;

  const bots = deps.botManager.getAllBots();
  const readyBot = bots.find(b => (b.status === "running" || b.status === "ready") && b.api);
  if (!readyBot?.api) return;

  const botUsernames = new Set(bots.map(b => b.username.toLowerCase()));

  // Fetch chat from multiple channels in parallel
  try {
    const channels = ["system", "faction", "local"] as const;
    const chatResults = await Promise.allSettled(
      channels.map(ch => readyBot.api!.getChatHistory(ch, 30))
    );

    const allMessages: SocialChatMessage[] = [];
    for (const result of chatResults) {
      if (result.status === "fulfilled") {
        for (const msg of result.value) {
          allMessages.push({
            ...msg,
            isOwnBot: botUsernames.has(msg.username.toLowerCase()),
          });
        }
      }
    }

    // Sort by timestamp desc, deduplicate by id
    const seen = new Set<string>();
    const deduped = allMessages
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .slice(0, 50);

    broadcast({ type: "social_chat_update", messages: deduped });
  } catch {
    // Chat polling failure is non-critical
  }

  // Fetch forum threads
  try {
    const threads = await readyBot.api!.forumList();
    const forumData: SocialForumThread[] = threads.slice(0, 20).map(t => ({
      ...t,
      isOwnBot: botUsernames.has(t.author.toLowerCase()),
    }));
    broadcast({ type: "social_forum_update", threads: forumData });
  } catch {
    // Forum polling failure is non-critical
  }

  // Fetch DMs for each bot (private channel)
  try {
    const allDMs: SocialDM[] = [];
    const readyBots = bots.filter(b => (b.status === "running" || b.status === "ready") && b.api);

    // Fetch DMs from up to 5 bots in parallel to avoid hammering the API
    const dmBots = readyBots.slice(0, 5);
    const dmResults = await Promise.allSettled(
      dmBots.map(b => b.api!.getChatHistory("private", 20))
    );

    for (let i = 0; i < dmResults.length; i++) {
      const result = dmResults[i];
      if (result.status !== "fulfilled") continue;
      const bot = dmBots[i];

      for (const msg of result.value) {
        const isFromBot = botUsernames.has(msg.username.toLowerCase());
        allDMs.push({
          id: msg.id,
          fromPlayer: msg.playerId,
          fromUsername: msg.username,
          toPlayer: isFromBot ? "" : bot.id,
          toUsername: isFromBot ? "" : bot.username,
          content: msg.content,
          timestamp: msg.timestamp,
          direction: isFromBot ? "outgoing" : "incoming",
          botUsername: bot.username,
        });
      }
    }

    // Deduplicate and sort
    const seen = new Set<string>();
    const dedupedDMs = allDMs
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .filter(m => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .slice(0, 100);

    if (dedupedDMs.length > 0) {
      broadcast({ type: "social_dm_update", messages: dedupedDMs });
    }
  } catch {
    // DM polling failure is non-critical
  }
}

/** Read global and faction chat, extract intel, and reply to interesting messages */
async function readAndRespondToChat(deps: BroadcastDeps, chatIntel: ChatIntelligence): Promise<void> {
  const bots = deps.botManager.getAllBots();
  const readyBot = bots.find(b => (b.status === "running" || b.status === "ready") && b.api);
  if (!readyBot?.api) return;

  // Read from both channels
  for (const channel of ["system", "faction"] as const) {
    try {
      const intel = await chatIntel.readAndAnalyze(readyBot.api, channel);
      if (intel.length > 0) {
        const trades = intel.filter(i => i.type === "trade_offer").length;
        const warnings = intel.filter(i => i.type === "warning").length;
        if (trades > 0 || warnings > 0) {
          console.log(`[ChatIntel] ${channel}: ${trades} trade offer(s), ${warnings} warning(s) detected`);
        }
      }
    } catch {
      // Chat read failure is non-critical
    }
  }

  // Send any queued replies (one per tick, rate limited internally)
  if (chatIntel.pendingReplyCount > 0) {
    try {
      const sent = await chatIntel.sendReplies(readyBot.api);
      if (sent > 0) {
        console.log(`[ChatIntel] Sent ${sent} reply(s) to chat`);
      }
    } catch {
      // Reply failure is non-critical
    }
  }
}

/** Post relevant intel to global chat: buy/sell orders, missions, pirate warnings, ore requests */
async function postFactionChatUpdate(deps: BroadcastDeps): Promise<void> {
  const bots = deps.botManager.getAllBots();
  const activeBots = bots.filter(b => b.status === "running" && b.api);
  if (activeBots.length === 0) return;

  const poster = activeBots[Math.floor(Math.random() * activeBots.length)];
  if (!poster.api) return;

  const fleet = deps.botManager.getFleetStatus();
  const ecoEngine = deps.commander.getEconomy();
  const candidates: string[] = [];

  // 1. Advertise active sell orders (items we have for sale)
  if (cachedFactionStorage && cachedFactionStorage.length > 0) {
    const sellable = cachedFactionStorage
      .filter(i => !i.itemId.startsWith("ore_") && i.quantity >= 5)
      .sort((a, b) => b.quantity - a.quantity);
    if (sellable.length > 0) {
      const top = sellable.slice(0, 2);
      const items = top.map(i => `${i.quantity}x ${i.itemName}`).join(", ");
      candidates.push(`Selling: ${items}. Check our market orders or DM to trade.`);
    }
  }

  // 2. Advertise material needs (ore/materials we're short on)
  if (ecoEngine) {
    const snap = ecoEngine.analyze(fleet);
    const critical = snap.deficits.filter(d => d.priority === "critical" && d.shortfall > 5);
    if (critical.length > 0) {
      const need = critical[0];
      const itemName = need.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      candidates.push(`Looking to buy ${itemName}. Anyone know where to find it? We pay well.`);
    }

    // Also ask about ore locations if storage is low
    const oreInStorage = cachedFactionStorage
      ?.filter(i => i.itemId.startsWith("ore_"))
      .reduce((sum, i) => sum + i.quantity, 0) ?? 0;
    if (oreInStorage < 10) {
      candidates.push(`Running low on ore. Any good asteroid belts nearby? Looking to trade for raw materials.`);
    }
  }

  // 3. Announce faction missions (if any were posted recently)
  try {
    const missions = await poster.api.factionListMissions();
    const recent = missions.filter(m => {
      const created = new Date(String(m.created_at ?? m.createdAt ?? "")).getTime();
      return Date.now() - created < 30 * 60_000; // Last 30 min
    });
    if (recent.length > 0) {
      const m = recent[0];
      candidates.push(`Faction mission available: ${String(m.title ?? m.name ?? "Delivery needed")}. Rewards offered!`);
    }
  } catch { /* missions not available */ }

  // 4. Pirate/combat warnings from chat intel
  const memStore = deps.commander.getMemoryStore();
  if (memStore) {
    const warnings = memStore.getAll().filter(m => m.key.startsWith("chat_warning_"));
    if (warnings.length > 0) {
      const latest = warnings[warnings.length - 1];
      // Only relay if recent (last 15 min)
      const age = Date.now() - new Date(latest.updatedAt).getTime();
      if (age < 15 * 60_000) {
        candidates.push(`Heads up: ${latest.fact}`);
      }
    }
  }

  // 5. Report pirate encounters from hunter bots
  const hunters = fleet.bots.filter(b => b.routine === "hunter" && b.status === "running");
  for (const h of hunters) {
    if (h.routineState?.toLowerCase().includes("hostile") || h.routineState?.toLowerCase().includes("pirate")) {
      candidates.push(`Spotted hostiles in ${h.systemId ?? "unknown system"}. Pilots beware.`);
      break;
    }
  }

  if (candidates.length === 0) return;

  // Pick one message at random
  const message = candidates[Math.floor(Math.random() * candidates.length)];

  try {
    await poster.api.chat("system", message);
  } catch {
    // Chat may not be available — silently ignore
  }
}

/** Auto-accept incoming peace proposals (runs every 5 minutes) */
async function handleAutoDiplomacy(deps: BroadcastDeps): Promise<void> {
  const bots = deps.botManager.getAllBots();
  const readyBot = bots.find(b => (b.status === "running" || b.status === "ready") && b.api);
  if (!readyBot?.api) return;

  try {
    const factionInfo = await readyBot.api.factionInfo();
    const info = factionInfo as Record<string, unknown>;

    // Check for pending peace proposals
    const peaceProposals = (info.peace_proposals ?? info.pending_peace ?? []) as Array<Record<string, unknown>>;
    if (peaceProposals.length === 0) return;

    for (const proposal of peaceProposals) {
      const targetFactionId = String(proposal.faction_id ?? proposal.factionId ?? proposal.id ?? "");
      const targetName = String(proposal.name ?? proposal.faction_name ?? targetFactionId);
      if (!targetFactionId) continue;

      try {
        await readyBot.api.factionAcceptPeace(targetFactionId);
        console.log(`[Broadcast] Auto-diplomacy: accepted peace proposal from "${targetName}" (${targetFactionId})`);
      } catch (err) {
        console.log(`[Broadcast] Auto-diplomacy: failed to accept peace from "${targetName}": ${err instanceof Error ? err.message : err}`);
      }
    }
  } catch (err) {
    console.log(`[Broadcast] Auto-diplomacy check failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Update the "Fleet Status" faction bulletin board room (runs every 10 minutes) */
async function updateFactionBulletinBoard(deps: BroadcastDeps): Promise<void> {
  const bots = deps.botManager.getAllBots();
  const readyBot = bots.find(b => (b.status === "running" || b.status === "ready") && b.api);
  if (!readyBot?.api) return;

  try {
    const rooms = await readyBot.api.factionRooms();
    const fleet = deps.botManager.getFleetStatus();

    // Count routines across active bots
    const routineCounts = new Map<string, number>();
    for (const bot of fleet.bots) {
      if (bot.status === "running" && bot.routine) {
        routineCounts.set(bot.routine, (routineCounts.get(bot.routine) ?? 0) + 1);
      }
    }
    const topRoutines = [...routineCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name}(${count})`)
      .join(", ") || "none";

    const content = [
      "Fleet Status (auto-updated)",
      `Active bots: ${fleet.activeBots}`,
      `Total credits: ${fleet.totalCredits.toLocaleString()}`,
      `Top routines: ${topRoutines}`,
      `Updated: ${new Date().toISOString()}`,
    ].join("\n");

    // Look for existing "Fleet Status" room
    const existingRoom = rooms.find(
      (r: Record<string, unknown>) => String(r.name ?? r.room_name ?? "").toLowerCase() === "fleet status"
    );

    if (existingRoom) {
      const roomId = String(existingRoom.id ?? existingRoom.room_id ?? "");
      await readyBot.api.factionWriteRoom({ roomId, name: "Fleet Status", description: content });
    } else {
      // Create the room
      await readyBot.api.factionWriteRoom({ name: "Fleet Status", description: content });
    }

    console.log(`[Broadcast] Updated faction bulletin board "Fleet Status"`);
  } catch (err) {
    console.log(`[Broadcast] Faction bulletin board update failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Poll open orders from all bots and aggregate */
async function pollOpenOrders(deps: BroadcastDeps): Promise<OpenOrder[]> {
  const bots = deps.botManager.getAllBots();
  const readyBots = bots.filter(b => (b.status === "running" || b.status === "ready") && b.api);
  if (readyBots.length === 0) return [];

  const allOrders: OpenOrder[] = [];
  // Query ALL ready bots for their orders (each bot sees only their own)
  // Quartermasters create faction orders — label those accordingly
  const results = await Promise.allSettled(
    readyBots.map(async (bot) => {
      const orders = await bot.api!.viewOrders();
      const isFactionBot = bot.routine === "quartermaster";
      return orders.map(o => ({
        id: String(o.id),
        type: o.type as "buy" | "sell",
        itemId: o.itemId,
        itemName: o.itemName || o.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        quantity: o.quantity,
        filled: o.quantity - (o.remaining ?? o.quantity),
        priceEach: o.priceEach,
        total: o.priceEach * o.quantity,
        stationId: o.stationId ?? "",
        stationName: o.stationName ?? o.stationId ?? "",
        createdAt: o.createdAt ?? "",
        botId: isFactionBot ? "Faction" : bot.username,
        owner: isFactionBot ? "faction" as const : "personal" as const,
      }));
    })
  );

  const seenIds = new Set<string>();
  for (const result of results) {
    if (result.status === "fulfilled") {
      for (const order of result.value) {
        if (!seenIds.has(order.id)) {
          seenIds.add(order.id);
          allOrders.push(order);
        }
      }
    }
  }

  return allOrders;
}

/** Post faction missions for materials the fleet is short on (runs every 10 minutes) */
async function postFactionMissionsForDeficits(deps: BroadcastDeps): Promise<void> {
  const bots = deps.botManager.getAllBots();
  const readyBot = bots.find(b => (b.status === "running" || b.status === "ready") && b.api);
  if (!readyBot?.api) return;

  try {
    // Get current economy deficits
    const fleet = deps.botManager.getFleetStatus();
    const ecoEngine = deps.commander.getEconomy();
    if (!ecoEngine) return;

    const snap = ecoEngine.analyze(fleet);
    const criticalDeficits = snap.deficits.filter(d => d.priority === "critical" || d.shortfall > 10);
    if (criticalDeficits.length === 0) return;

    // Check existing faction missions to avoid duplicates
    const existingMissions = await readyBot.api.factionListMissions().catch(() => []);
    const existingMissionItems = new Set(
      existingMissions.map(m => String(m.item_id ?? m.itemId ?? m.title ?? "").toLowerCase())
    );

    let missionsPosted = 0;
    for (const deficit of criticalDeficits.slice(0, 3)) { // Max 3 missions at a time
      const itemName = deficit.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

      // Skip if a mission for this item already exists
      if (existingMissionItems.has(deficit.itemId.toLowerCase()) ||
          existingMissionItems.has(itemName.toLowerCase())) {
        continue;
      }

      const qty = Math.ceil(deficit.shortfall * 2); // Request 2 hours worth of shortfall
      try {
        await readyBot.api.factionPostMission({
          title: `Deliver ${qty}x ${itemName}`,
          description: `Fleet supply chain needs ${itemName}. Current shortfall: ${Math.ceil(deficit.shortfall)}/hr. Deliver to faction storage.`,
          type: "delivery",
          objectives: [{ type: "deliver", item_id: deficit.itemId, quantity: qty }],
          rewards: [{ type: "credits", amount: Math.max(500, qty * 10) }],
          giverName: "Fleet Quartermaster",
          giverTitle: "Supply Chain AI",
          expirationHours: 4,
        });
        missionsPosted++;
        console.log(`[Broadcast] Posted faction mission: Deliver ${qty}x ${itemName} (shortfall: ${Math.ceil(deficit.shortfall)}/hr)`);
      } catch (err) {
        console.log(`[Broadcast] Failed to post faction mission for ${itemName}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (missionsPosted > 0) {
      console.log(`[Broadcast] Posted ${missionsPosted} faction mission(s) for supply deficits`);
    }
  } catch (err) {
    console.log(`[Broadcast] Faction mission posting failed: ${err instanceof Error ? err.message : err}`);
  }
}
