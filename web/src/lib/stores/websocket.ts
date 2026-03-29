/**
 * WebSocket store - manages connection to the Commander backend.
 * Provides reactive state for all dashboard components.
 */

import { writable, derived, get } from "svelte/store";
import type {
  ServerMessage,
  ClientMessage,
  BotSummary,
  FleetStats,
  EconomyState,
  LogEntry,
  CommanderDecision,
  SkillMilestone,
  TrainingStats,
  GalaxySystemSummary,
  MarketStationData,
  FactionState,
  BotStorageData,
  BrainHealthStatus,
  BrainDecisionStats,
  SupplyChainNode,
  SupplyChainLink,
  MemoryEntry,
  StuckBot,
  SocialChatMessage,
  SocialForumThread,
  SocialDM,
  WorkOrderInfo,
} from "../../../../src/types/protocol";
import type { Goal } from "../../../../src/config/schema";

// ── Connection State ──

type ConnectionState = "connecting" | "connected" | "disconnected";

export const connectionState = writable<ConnectionState>("disconnected");
export const serverVersion = writable<string | null>(null);

// ── Reactive Stores ──

export const bots = writable<BotSummary[]>([]);
export const fleetStats = writable<FleetStats | null>(null);
export const economy = writable<EconomyState | null>(null);
export const commanderLog = writable<CommanderDecision[]>([]);
export const activityLog = writable<LogEntry[]>([]);
export const notifications = writable<
  Array<{ id: string; level: "critical" | "warning" | "info"; title: string; message: string; timestamp: number }>
>([]);
export const skillMilestones = writable<SkillMilestone[]>([]);
export const trainingStats = writable<TrainingStats | null>(null);
export const galaxySystems = writable<GalaxySystemSummary[]>([]);
export const marketStations = writable<MarketStationData[]>([]);
export const goals = writable<Goal[]>([]);
export const factionState = writable<FactionState | null>(null);
export const botStorage = writable<Map<string, BotStorageData>>(new Map());
export const fleetSettings = writable<{
	factionTaxPercent: number;
	minBotCredits: number;
	maxBotCredits: number;
	homeSystem?: string;
	homeBase?: string;
	defaultStorageMode?: string;
	evaluationInterval?: number;
}>({ factionTaxPercent: 0, minBotCredits: 0, maxBotCredits: 0 });
export const brainHealth = writable<BrainHealthStatus[]>([]);
export const supplyChain = writable<{ nodes: SupplyChainNode[]; links: SupplyChainLink[] }>({ nodes: [], links: [] });
export const commanderMemory = writable<MemoryEntry[]>([]);
export const stuckBots = writable<StuckBot[]>([]);
export const socialChat = writable<SocialChatMessage[]>([]);
export const socialForum = writable<SocialForumThread[]>([]);
export const socialDMs = writable<SocialDM[]>([]);
export const brainDecisionStats = writable<BrainDecisionStats | null>(null);
export const workOrders = writable<WorkOrderInfo[]>([]);
export const fleetAdvisor = writable<any>(null);
export const dangerMapData = writable<Array<{ systemId: string; score: number; attacks: number; lastAttack: number }>>([]);

// Galaxy detail (enriched with market data)
export interface GalaxyDetailData {
  systems: GalaxySystemSummary[];
  baseMarket: Record<string, {
    prices: Array<{ itemId: string; itemName: string; buyPrice: number; sellPrice: number; buyVolume: number; sellVolume: number }>;
    freshness: { fetchedAt: number; ageMs: number; fresh: boolean };
  }>;
  baseShipyard: Record<string, {
    ships: Array<{ id: string; name: string; classId: string; price: number }>;
    fetchedAt: number;
  }>;
}
export const galaxyDetail = writable<GalaxyDetailData | null>(null);

// Catalog data (ships, items, skills, recipes)
export interface CatalogData {
  ships: Array<{ id: string; name: string; category: string; description: string; basePrice: number; hull: number; shield: number; armor: number; speed: number; fuel: number; cargoCapacity: number; cpuCapacity: number; powerCapacity: number; region?: string; commissionable?: boolean; extra?: Record<string, unknown> }>;
  items: Array<{ id: string; name: string; category: string; description: string; basePrice: number; stackSize: number; cpuCost?: number; powerCost?: number; slotType?: string }>;
  skills: Array<{ id: string; name: string; category: string; description: string; maxLevel: number; prerequisites: Record<string, number> }>;
  recipes: Array<{ id: string; name: string; description: string; outputItem: string; outputQuantity: number; ingredients: Array<{ itemId: string; quantity: number }>; requiredSkills: Record<string, number>; xpRewards: Record<string, number> }>;
}
export const catalogData = writable<CatalogData | null>(null);

// Derived
export const activeBots = derived(bots, ($bots) => $bots.filter((b) => b.status === "running"));
export const unreadNotifications = derived(notifications, ($n) => $n.length);

// ── WebSocket Management ──

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;
const MAX_LOG_ENTRIES = 500;
const MAX_COMMANDER_LOG = 100;

function getWsUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const base = `${protocol}//${window.location.host}/ws`;
  // Attach JWT token if available (for authenticated multi-tenant mode)
  try {
    const stored = localStorage.getItem("commander_auth");
    if (stored) {
      const { token } = JSON.parse(stored);
      if (token) return `${base}?token=${token}`;
    }
  } catch { /* no auth token — connect without */ }
  return base;
}

function handleMessage(event: MessageEvent) {
  try {
    const msg: ServerMessage = JSON.parse(event.data);

    switch (msg.type) {
      case "connected":
        serverVersion.set(msg.version);
        break;

      case "fleet_update":
        bots.set(msg.bots);
        break;

      case "bot_update":
        bots.update((current) =>
          current.map((b) => (b.id === msg.botId ? { ...b, ...msg.data } : b))
        );
        break;

      case "stats_update":
        fleetStats.set(msg.stats);
        break;

      case "economy_update":
        economy.set(msg.economy);
        if (msg.economy.workOrders) {
          workOrders.set(msg.economy.workOrders);
        }
        break;

      case "commander_decision":
        commanderLog.update((log) => [msg.decision, ...log].slice(0, MAX_COMMANDER_LOG));
        break;

      case "log_entry":
        activityLog.update((log) => [msg.entry, ...log].slice(0, MAX_LOG_ENTRIES));
        break;

      case "supply_chain_update":
        economy.update((e) =>
          e ? { ...e, deficits: msg.deficits, surpluses: msg.surpluses } : e
        );
        break;

      case "order_update":
        economy.update((e) => (e ? { ...e, openOrders: msg.orders } : e));
        break;

      case "skill_milestone":
        skillMilestones.update((m) => [msg.milestone, ...m].slice(0, 50));
        break;

      case "training_stats_update":
        trainingStats.set(msg.stats);
        break;

      case "galaxy_update":
        galaxySystems.set(msg.systems);
        break;

      case "galaxy_detail":
        galaxyDetail.set({ systems: msg.systems, baseMarket: msg.baseMarket, baseShipyard: msg.baseShipyard ?? {} });
        break;

      case "market_update":
        marketStations.set(msg.stations);
        break;

      case "goals_update":
        goals.set(msg.goals);
        break;

      case "faction_update":
        factionState.set(msg.faction);
        break;

      case "fleet_settings_update":
        fleetSettings.set(msg.settings);
        break;

      case "bot_storage":
        botStorage.update((m) => {
          const next = new Map(m);
          next.set(msg.botId, msg.storage);
          return next;
        });
        break;

      case "brain_health_update":
        brainHealth.set(msg.brains);
        break;

      case "supply_chain_flow":
        supplyChain.set({ nodes: msg.nodes, links: msg.links });
        break;

      case "memory_update":
        commanderMemory.set(msg.memories);
        break;

      case "stuck_bots_update":
        stuckBots.set(msg.stuckBots);
        break;

      case "social_chat_update": {
        // Accumulate chat history, dedup by id, keep newest 200
        const existingChat = get(socialChat);
        const seenChat = new Set(existingChat.map(m => m.id));
        const newChat = msg.messages.filter(m => !seenChat.has(m.id));
        const merged = [...newChat, ...existingChat]
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .slice(0, 200);
        socialChat.set(merged);
        break;
      }

      case "social_forum_update":
        socialForum.set(msg.threads);
        break;

      case "social_dm_update": {
        // Accumulate DM history, dedup by id, keep newest 200
        const existingDMs = get(socialDMs);
        const seenDMs = new Set(existingDMs.map(m => m.id));
        const newDMs = msg.messages.filter(m => !seenDMs.has(m.id));
        const mergedDMs = [...newDMs, ...existingDMs]
          .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
          .slice(0, 200);
        socialDMs.set(mergedDMs);
        break;
      }

      case "brain_decision_stats":
        brainDecisionStats.set(msg.stats);
        break;

      case "fleet_advisor_update":
        fleetAdvisor.set(msg.advisor);
        break;

      case "danger_map_update":
        dangerMapData.set(msg.systems);
        break;

      case "catalog_data":
        catalogData.set(msg);
        break;

      case "notification":
        notifications.update((n) => [
          {
            id: crypto.randomUUID(),
            level: msg.level,
            title: msg.title,
            message: msg.message,
            timestamp: Date.now(),
          },
          ...n,
        ]);
        break;
    }
  } catch {
    console.error("[WS] Failed to parse message");
  }
}

/** Get auth headers for REST API calls */
export function getAuthHeaders(): HeadersInit {
  try {
    const stored = localStorage.getItem("commander_auth");
    if (stored) {
      const { token } = JSON.parse(stored);
      if (token) return { Authorization: `Bearer ${token}` };
    }
  } catch { /* no auth */ }
  return {};
}

/** Fetch persisted logs and decisions from REST API on connect/reconnect */
async function fetchHistory() {
  try {
    const headers = getAuthHeaders();
    const [logsRes, decisionsRes] = await Promise.allSettled([
      fetch("/api/logs?range=1h&limit=500", { headers }),
      fetch("/api/decisions?range=1d&limit=100", { headers }),
    ]);

    if (logsRes.status === "fulfilled" && logsRes.value.ok) {
      const logs: LogEntry[] = await logsRes.value.json();
      if (logs.length > 0) {
        activityLog.update((current) => {
          // Merge: existing live entries + historical, dedup by timestamp+message
          const seen = new Set(current.map((e) => `${e.timestamp}:${e.message}`));
          const newEntries = logs.filter((e) => !seen.has(`${e.timestamp}:${e.message}`));
          return [...current, ...newEntries]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, MAX_LOG_ENTRIES);
        });
      }
    }

    if (decisionsRes.status === "fulfilled" && decisionsRes.value.ok) {
      const decisions: CommanderDecision[] = await decisionsRes.value.json();
      if (decisions.length > 0) {
        commanderLog.update((current) => {
          const seen = new Set(current.map((d) => d.tick));
          const newDecisions = decisions.filter((d) => !seen.has(d.tick));
          return [...current, ...newDecisions]
            .sort((a, b) => b.tick - a.tick)
            .slice(0, MAX_COMMANDER_LOG);
        });
      }
    }
  } catch {
    // History fetch is non-critical — dashboard will populate from live events
  }
}

export function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  connectionState.set("connecting");
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    connectionState.set("connected");
    reconnectDelay = 1000;
    console.log("[WS] Connected");

    // Fetch persisted history from REST API on connect
    fetchHistory();
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    connectionState.set("disconnected");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log(`[WS] Reconnecting (delay: ${reconnectDelay}ms)...`);
    connect();
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }, reconnectDelay);
}

export function disconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  ws?.close();
  ws = null;
  connectionState.set("disconnected");
}

export function send(msg: ClientMessage) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    console.warn("[WS] Cannot send - not connected");
  }
}

export function dismissNotification(id: string) {
  notifications.update((n) => n.filter((item) => item.id !== id));
}

export function clearNotifications() {
  notifications.set([]);
}
