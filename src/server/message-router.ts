/**
 * Client message router — handles all 20 dashboard→server message types.
 * Extracted from v2 index.ts (L681-938).
 */

import type { ServerWebSocket } from "bun";
import type { ClientMessage } from "../types/protocol";
import type { RoutineName } from "../types/protocol";
import type { BotManager } from "../bot/bot-manager";
import type { Commander } from "../commander/commander";
import type { Galaxy } from "../core/galaxy";
import type { DB } from "../data/db";
import type { GameCache } from "../data/game-cache";
import type { SessionStore } from "../data/session-store";
import { broadcast, sendTo } from "./server";
import { saveBotSettings, saveFleetSettings, saveGoals } from "../fleet/persistence";

export interface MessageRouterDeps {
  botManager: BotManager;
  commander: Commander;
  galaxy: Galaxy;
  db: DB;
  cache: GameCache;
  sessionStore: SessionStore;
  ensureGalaxyLoaded: () => Promise<void>;
  runDiscovery: () => Promise<void>;
}

interface WsData {
  id: string;
  connectedAt: number;
}

export function handleClientMessage(
  ws: ServerWebSocket<WsData>,
  msg: ClientMessage,
  deps: MessageRouterDeps,
): void {
  const { botManager, commander, galaxy, db } = deps;

  try {
    switch (msg.type) {
      case "set_goal": {
        commander.addGoal(msg.goal);
        saveGoals(db, commander.getGoals());
        broadcast({ type: "goals_update", goals: commander.getGoals() });
        broadcast({ type: "notification", level: "info", title: "Goal added", message: `${msg.goal.type} (priority ${msg.goal.priority})` });
        break;
      }

      case "update_goal": {
        const goals = commander.getGoals();
        if (msg.index >= 0 && msg.index < goals.length) {
          goals[msg.index] = msg.goal;
          commander.setGoals(goals);
          saveGoals(db, commander.getGoals());
          broadcast({ type: "goals_update", goals: commander.getGoals() });
        }
        break;
      }

      case "remove_goal": {
        commander.removeGoal(msg.index);
        saveGoals(db, commander.getGoals());
        broadcast({ type: "goals_update", goals: commander.getGoals() });
        break;
      }

      case "override_assignment": {
        (async () => {
          try {
            await deps.botManager.assignRoutine(msg.botId, msg.routine, msg.params ?? {});
            broadcast({ type: "notification", level: "info", title: "Override", message: `${msg.botId} → ${msg.routine}` });
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Override failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "release_override": {
        const bot = botManager.getBot(msg.botId);
        if (bot) {
          bot.requestStop();
          broadcast({ type: "notification", level: "info", title: "Released", message: `${msg.botId} will be reassigned` });
        }
        break;
      }

      case "set_inventory_target": {
        const eco = commander.getEconomy();
        eco.addStockTarget(msg.target);
        broadcast({ type: "notification", level: "info", title: "Target set", message: `${msg.target.item_id} @ ${msg.target.station_id}` });
        break;
      }

      case "remove_inventory_target": {
        const eco2 = commander.getEconomy();
        eco2.removeStockTarget(msg.stationId, msg.itemId);
        broadcast({ type: "notification", level: "info", title: "Target removed", message: `${msg.itemId} @ ${msg.stationId}` });
        break;
      }

      case "start_bot": {
        (async () => {
          try {
            const bot = botManager.getBot(msg.botId);
            if (!bot) return;
            if (bot.status === "running" || bot.status === "logging_in") return;

            await bot.login();
            await deps.ensureGalaxyLoaded();
            // Trigger home discovery if not yet found
            if (!botManager.fleetConfig.homeBase) {
              await deps.runDiscovery();
            }
            await commander.forceEvaluation();
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Start failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "start_all_bots": {
        (async () => {
          try {
            // Skip bots under manual control — they are player-driven
            const manualBotIds = new Set(
              botManager.getAllBots()
                .filter(b => b.settings.manualControl)
                .map(b => b.id)
            );
            if (manualBotIds.size > 0) {
              const names = botManager.getAllBots().filter(b => manualBotIds.has(b.id)).map(b => b.username);
              console.log(`[Fleet] start_all_bots skipping ${manualBotIds.size} manual-control bot(s): ${names.join(", ")}`);
            }

            const result = await botManager.loginAll(manualBotIds);
            if (result.success.length > 0) {
              await deps.ensureGalaxyLoaded();
              // Trigger home discovery now that bots have player data
              await deps.runDiscovery();
              await commander.forceEvaluation();
              broadcast({ type: "notification", level: "info", title: "Fleet started", message: `${result.success.length} bot(s) online${manualBotIds.size > 0 ? ` (${manualBotIds.size} manual skipped)` : ""}` });
            }
            for (const fail of result.failed) {
              broadcast({ type: "notification", level: "warning", title: `Login failed: ${fail.username}`, message: fail.error });
            }
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Start all failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "stop_bot": {
        const bot = botManager.getBot(msg.botId);
        if (bot) bot.requestStop();
        break;
      }

      case "add_bot": {
        try {
          const bot = botManager.addBot(msg.username);
          // Persist credentials so bot survives restarts
          if (msg.password) {
            deps.sessionStore.upsertBot({ username: msg.username, password: msg.password, empire: null, playerId: null });
          }
          broadcast({ type: "notification", level: "info", title: "Bot added", message: bot.username });
        } catch (err) {
          broadcast({ type: "notification", level: "warning", title: "Add failed", message: err instanceof Error ? err.message : String(err) });
        }
        break;
      }

      case "remove_bot": {
        (async () => {
          await botManager.removeBot(msg.botId);
          broadcast({ type: "notification", level: "info", title: "Bot removed", message: msg.botId });
        })();
        break;
      }

      case "update_settings": {
        const settings = msg.settings;

        /** Safely parse a number, returning null if NaN or out of range */
        const safeNum = (v: unknown, min: number, max: number): number | null => {
          const n = Number(v);
          return Number.isFinite(n) && n >= min && n <= max ? n : null;
        };

        // ── Fleet settings ──
        if (settings.factionTaxPercent !== undefined) {
          const v = safeNum(settings.factionTaxPercent, 0, 100);
          if (v !== null) botManager.fleetConfig.factionTaxPercent = v;
        }
        if (settings.minBotCredits !== undefined) {
          const v = safeNum(settings.minBotCredits, 0, 1_000_000_000);
          if (v !== null) botManager.fleetConfig.minBotCredits = v;
        }
        if (settings.maxBotCredits !== undefined) {
          const v = safeNum(settings.maxBotCredits, 0, 1_000_000_000);
          if (v !== null) botManager.fleetConfig.maxBotCredits = v;
        }
        if (settings.homeSystem !== undefined) {
          botManager.fleetConfig.homeSystem = String(settings.homeSystem).slice(0, 200);
        }
        if (settings.homeBase !== undefined) {
          botManager.fleetConfig.homeBase = String(settings.homeBase).slice(0, 200);
        }
        if (settings.defaultStorageMode !== undefined) {
          const mode = String(settings.defaultStorageMode);
          if (mode === "sell" || mode === "deposit" || mode === "faction_deposit") {
            botManager.fleetConfig.defaultStorageMode = mode;
          }
        }

        // ── Commander settings ──
        const commanderUpdates: Record<string, unknown> = {};
        if (settings.evaluationInterval !== undefined) {
          const v = safeNum(settings.evaluationInterval, 10, 3600);
          if (v !== null) commanderUpdates.evaluationIntervalSec = v;
        }
        if (settings.reassignmentCooldown !== undefined) {
          const v = safeNum(settings.reassignmentCooldown, 0, 86400);
          if (v !== null) commanderUpdates.reassignmentCooldown = v;
        }
        if (settings.reassignmentThreshold !== undefined) {
          const v = safeNum(settings.reassignmentThreshold, 0, 1);
          if (v !== null) commanderUpdates.reassignmentThreshold = v;
        }
        if (Object.keys(commanderUpdates).length > 0) {
          commander.updateConfig(commanderUpdates as any);
        }

        // Persist all settings
        saveFleetSettings(db, {
          factionTaxPercent: botManager.fleetConfig.factionTaxPercent,
          minBotCredits: botManager.fleetConfig.minBotCredits,
          maxBotCredits: botManager.fleetConfig.maxBotCredits,
          homeSystem: botManager.fleetConfig.homeSystem,
          homeBase: botManager.fleetConfig.homeBase,
          defaultStorageMode: botManager.fleetConfig.defaultStorageMode,
          evaluationInterval: commander.getConfig().evaluationIntervalSec,
        });
        broadcast({
          type: "fleet_settings_update",
          settings: {
            factionTaxPercent: botManager.fleetConfig.factionTaxPercent,
            minBotCredits: botManager.fleetConfig.minBotCredits,
            maxBotCredits: botManager.fleetConfig.maxBotCredits,
            homeSystem: botManager.fleetConfig.homeSystem,
            homeBase: botManager.fleetConfig.homeBase,
            defaultStorageMode: botManager.fleetConfig.defaultStorageMode,
            evaluationInterval: commander.getConfig().evaluationIntervalSec,
          },
        });
        break;
      }

      case "update_ai_settings" as any: {
        const ai = (msg as any).settings as Record<string, unknown>;
        const updates: Record<string, unknown> = {};
        if (ai.ollamaModel !== undefined) {
          const model = String(ai.ollamaModel).slice(0, 100);
          if (model) updates.ollamaModel = model;
        }
        if (ai.ollamaBaseUrl !== undefined) {
          const url = String(ai.ollamaBaseUrl).slice(0, 200);
          if (url) updates.ollamaBaseUrl = url;
        }
        if (ai.timeoutMs !== undefined) {
          const n = Number(ai.timeoutMs);
          if (!isNaN(n) && n >= 5000 && n <= 120000) updates.timeoutMs = n;
        }
        if (Object.keys(updates).length > 0) {
          commander.updateAiSettings(updates as any);
          const current = commander.getAiSettings();
          if (current) {
            broadcast({ type: "ai_settings_update", settings: current } as any);
          }
          broadcast({ type: "notification", level: "info", title: "AI settings updated", message: `Ollama model: ${updates.ollamaModel ?? "unchanged"}` });
        }
        break;
      }

      case "update_bot_settings": {
        const bot = botManager.getBot(msg.botId);
        if (bot) {
          const s = msg.settings;
          if (s.fuelEmergencyThreshold !== undefined) bot.settings.fuelEmergencyThreshold = Number(s.fuelEmergencyThreshold);
          if (s.autoRepair !== undefined) bot.settings.autoRepair = Boolean(s.autoRepair);
          if (s.maxCargoFillPct !== undefined) bot.settings.maxCargoFillPct = Number(s.maxCargoFillPct);
          if (s.storageMode !== undefined) bot.settings.storageMode = s.storageMode as any;
          if (s.factionStorage !== undefined) bot.settings.factionStorage = Boolean(s.factionStorage);

          saveBotSettings(db, bot.username, bot.settings);
          broadcast({ type: "notification", level: "info", title: "Settings saved", message: `${bot.username}` });
        }
        break;
      }

      case "cancel_order": {
        // Not yet implemented
        break;
      }

      case "queue_facility_build": {
        const queue = botManager.fleetConfig.facilityBuildQueue;
        if (!queue.includes(msg.facilityType)) {
          queue.push(msg.facilityType);
          broadcast({ type: "notification", level: "info", title: "Facility queued", message: `${msg.facilityType.replace(/_/g, " ")} — QM will build next cycle` });
        }
        break;
      }

      case "cancel_facility_build": {
        const q = botManager.fleetConfig.facilityBuildQueue;
        const idx = q.indexOf(msg.facilityType);
        if (idx >= 0) {
          q.splice(idx, 1);
          broadcast({ type: "notification", level: "info", title: "Build cancelled", message: msg.facilityType.replace(/_/g, " ") });
        }
        break;
      }

      case "force_reassign": {
        (async () => {
          try {
            await botManager.assignRoutine(msg.botId, msg.routine, {});
            deps.commander.getBrain().clearCooldown(msg.botId);
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Reassign failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "force_evaluation": {
        (async () => {
          const decision = await commander.forceEvaluation();
          broadcast({
            type: "commander_decision",
            decision,
          });
        })();
        break;
      }

      case "request_bot_storage": {
        // Async storage fetch — result sent to requesting client only
        (async () => {
          try {
            const bot = botManager.getBot(msg.botId);
            if (!bot?.api) throw new Error("Bot not available");

            const storage = await bot.api.viewStorage();
            sendTo(ws, {
              type: "bot_storage",
              botId: msg.botId,
              storage: {
                stations: Array.isArray(storage) ? storage : [],
                totalItems: 0,
                totalCredits: 0,
              },
            });
          } catch (err) {
            sendTo(ws, {
              type: "bot_storage",
              botId: msg.botId,
              storage: { stations: [], totalItems: 0, totalCredits: 0 },
            });
          }
        })();
        break;
      }

      case "request_galaxy": {
        (async () => {
          if (galaxy.systemCount < 50) {
            await deps.ensureGalaxyLoaded();
          }
          sendTo(ws, { type: "galaxy_update", systems: galaxy.toSummaries() });
        })();
        break;
      }

      case "request_galaxy_detail": {
        // Returns galaxy systems enriched with market freshness and shipyard data
        (async () => {
          try {
            // Ensure galaxy is fully loaded before responding
            if (galaxy.systemCount < 50) {
              await deps.ensureGalaxyLoaded();
            }
            const systems = galaxy.toSummaries();
            const marketFreshness = deps.cache.getAllMarketFreshness();
            const freshnessMap = new Map(marketFreshness.map(f => [f.stationId, { fetchedAt: f.fetchedAt, ageMs: f.ageMs, fresh: f.fresh }]));

            // Build market/shipyard data per base
            const baseMarket: Record<string, { prices: Array<{ itemId: string; itemName: string; buyPrice: number; sellPrice: number; buyVolume: number; sellVolume: number }>; freshness: { fetchedAt: number; ageMs: number; fresh: boolean } }> = {};
            for (const f of marketFreshness) {
              const prices = deps.cache.getMarketPrices(f.stationId);
              if (prices) {
                baseMarket[f.stationId] = {
                  prices: prices.map(p => ({ itemId: p.itemId, itemName: p.itemName, buyPrice: p.buyPrice ?? 0, sellPrice: p.sellPrice ?? 0, buyVolume: p.buyVolume, sellVolume: p.sellVolume })),
                  freshness: { fetchedAt: f.fetchedAt, ageMs: f.ageMs, fresh: f.fresh },
                };
              }
            }

            const baseShipyard = deps.cache.getAllShipyardData();

            sendTo(ws, { type: "galaxy_detail", systems, baseMarket, baseShipyard });
          } catch {
            sendTo(ws, { type: "galaxy_detail", systems: [], baseMarket: {}, baseShipyard: {} });
          }
        })();
        break;
      }

      case "request_catalog": {
        (async () => {
          try {
            const api = botManager.getAllBots().find(b => b.api)?.api;
            if (!api) {
              // No bot connected — serve from persisted cache
              const ships = deps.cache.getCachedShipCatalog() ?? [];
              const items = deps.cache.getCachedItemCatalog() ?? [];
              const skills = deps.cache.getCachedSkillTree() ?? [];
              const recipes = deps.cache.getCachedRecipes() ?? [];
              sendTo(ws, { type: "catalog_data", ships, items, skills, recipes });
              return;
            }
            const [ships, items, skills, recipes] = await Promise.all([
              deps.cache.getShipCatalog(api),
              deps.cache.getItemCatalog(api),
              deps.cache.getSkillTree(api),
              deps.cache.getRecipes(api),
            ]);
            sendTo(ws, { type: "catalog_data", ships, items, skills, recipes });
          } catch (err) {
            // Fetch failed — try serving from cache before returning empty
            const ships = deps.cache.getCachedShipCatalog() ?? [];
            const items = deps.cache.getCachedItemCatalog() ?? [];
            const skills = deps.cache.getCachedSkillTree() ?? [];
            const recipes = deps.cache.getCachedRecipes() ?? [];
            sendTo(ws, { type: "catalog_data", ships, items, skills, recipes });
          }
        })();
        break;
      }

      case "prefer_ship": {
        (async () => {
          try {
            const bot = botManager.getBot(msg.botId);
            if (!bot) {
              broadcast({ type: "notification", level: "warning", title: "Ship switch failed", message: "Bot not found" });
              return;
            }
            if (bot.ship?.classId === msg.classId) {
              broadcast({ type: "notification", level: "info", title: "Already active", message: `${bot.username} is already flying ${msg.classId}` });
              return;
            }
            // Find location of the target ship from bot's owned ships list
            const ownedShip = bot.ownedShips.find(s => s.id === msg.shipId);
            const shipLocation = ownedShip?.location || undefined;

            // Assign ship_upgrade routine with alreadyOwned mode
            await botManager.assignRoutine(msg.botId, "ship_upgrade", {
              targetShipClass: msg.classId,
              alreadyOwned: true,
              ownedShipId: msg.shipId,
              shipLocation,
              sellOldShip: false,
              role: bot.lastRoutine ?? "default",
            });
            broadcast({ type: "notification", level: "info", title: "Ship switch", message: `${bot.username} switching to ${msg.classId}` });
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Ship switch failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "refresh_cache": {
        (async () => {
          try {
            await deps.ensureGalaxyLoaded();
            broadcast({ type: "notification", level: "info", title: "Cache refreshed", message: "Galaxy and market data reloaded" });
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Refresh failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "buy_ship_upgrade": {
        (async () => {
          try {
            const bot = botManager.getBot(msg.botId);
            if (!bot?.api) {
              broadcast({ type: "notification", level: "warning", title: "Buy ship failed", message: "Bot not found or not connected" });
              return;
            }
            // Assign ship_upgrade routine which handles travel to shipyard, purchase, and switch
            await botManager.assignRoutine(msg.botId, "ship_upgrade", {
              targetShipClass: msg.shipClass,
              alreadyOwned: false,
              sellOldShip: true,
              role: bot.lastRoutine ?? "default",
            });
            broadcast({ type: "notification", level: "info", title: "Ship upgrade", message: `${bot.username} upgrading to ${msg.shipClass}` });
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Buy ship failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "buy_module": {
        (async () => {
          try {
            const bot = botManager.getBot(msg.botId);
            if (!bot?.api) {
              broadcast({ type: "notification", level: "warning", title: "Buy module failed", message: "Bot not found or not connected" });
              return;
            }
            const result = await bot.api.buy(msg.moduleId, 1);
            broadcast({ type: "notification", level: "info", title: "Module purchased", message: `${bot.username} bought ${msg.moduleId}` });
            // Try to install it immediately
            try {
              await bot.api.installMod(msg.moduleId);
              broadcast({ type: "notification", level: "info", title: "Module installed", message: `${bot.username} installed ${msg.moduleId}` });
            } catch (installErr) {
              broadcast({ type: "notification", level: "warning", title: "Install failed", message: `Bought but couldn't install: ${installErr instanceof Error ? installErr.message : String(installErr)}` });
            }
          } catch (err) {
            broadcast({ type: "notification", level: "warning", title: "Buy module failed", message: err instanceof Error ? err.message : String(err) });
          }
        })();
        break;
      }

      case "set_bot_role": {
        const bot = botManager.getBot(msg.botId);
        if (bot) {
          bot.role = msg.role;
          bot.settings.role = msg.role;
          saveBotSettings(db, bot.username, bot.settings);
          console.log(`[WS] Set bot ${msg.botId} role → ${msg.role ?? "generalist"}`);
          broadcast({ type: "notification", level: "info", title: "Role updated", message: `${bot.username} is now ${msg.role ?? "generalist"}` });
        }
        break;
      }

      case "set_manual_control": {
        const bot = botManager.getBot(msg.botId);
        if (bot) {
          bot.settings.manualControl = msg.enabled;
          saveBotSettings(db, bot.username, bot.settings);
          console.log(`[WS] Set bot ${msg.botId} manualControl → ${msg.enabled}`);
          broadcast({ type: "notification", level: "info", title: "Manual control", message: `${bot.username} manual control ${msg.enabled ? "enabled" : "disabled"}` });
        }
        break;
      }

      default:
        console.log(`[WS] Unknown message type: ${(msg as any).type}`);
    }
  } catch (err) {
    console.error(`[WS] Error handling ${msg.type}:`, err);
    broadcast({
      type: "notification",
      level: "critical",
      title: "Server error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
