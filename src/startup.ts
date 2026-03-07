/**
 * Startup wiring — creates and connects all services for SpaceMolt Commander v3.
 * Called by app.ts with loaded config.
 */

import type { AppConfig } from "./config/schema";
import { createDatabase, type DB } from "./data/db";
import { GameCache } from "./data/game-cache";
import { TrainingLogger } from "./data/training-logger";
import { SessionStore } from "./data/session-store";
import { Galaxy } from "./core/galaxy";
import { Navigation } from "./core/navigation";
import { Market } from "./core/market";
import { Cargo } from "./core/cargo";
import { Fuel } from "./core/fuel";
import { Combat } from "./core/combat";
import { Crafting } from "./core/crafting";
import { Station } from "./core/station";
import { EventBus } from "./events/bus";
import { registerTradeTracker, registerProductionTracker, registerDashboardRelay, registerFactionTracker, createProductionStats } from "./events";
import { BotManager, type SharedServices, type ApiClientFactory } from "./bot/bot-manager";
import { ApiClient } from "./core/api-client";
import { Commander, type CommanderConfig, type CommanderDeps } from "./commander/commander";
import { ScoringBrain } from "./commander/scoring-brain";
import { TieredBrain } from "./commander/tiered-brain";
import { createOllamaBrain } from "./commander/ollama-brain";
import { createGeminiBrain } from "./commander/gemini-brain";
import { createClaudeBrain } from "./commander/claude-brain";
import { EconomyEngine } from "./commander/economy-engine";
import { buildRoutineRegistry } from "./routines";
import { createServer, broadcast, sendTo, type ServerOptions } from "./server/server";
import { activityLog } from "./data/schema";
import { gt } from "drizzle-orm";
import { handleClientMessage, type MessageRouterDeps } from "./server/message-router";
import { startBroadcastLoop, type BroadcastDeps } from "./server/broadcast";
import {
  loadBotSettings, loadFleetSettings, loadGoals,
  discoverFactionStorage, propagateFleetHome,
  ensureFactionMembership,
} from "./fleet";
import type { CommanderBrain } from "./commander/types";
import { MemoryStore } from "./data/memory-store";

export interface AppServices {
  db: DB;
  close: () => void;
  galaxy: Galaxy;
  botManager: BotManager;
  commander: Commander;
  economy: EconomyEngine;
  sessionStore: SessionStore;
  stopBroadcast: () => void;
}

/**
 * Wire all services together and start the application.
 */
export async function startup(config: AppConfig): Promise<AppServices> {
  // ── Data Layer ──
  const { db, sqlite } = createDatabase("commander.db");
  const trainingLogger = new TrainingLogger(db);
  const gameCache = new GameCache(db, trainingLogger);
  const sessionStore = new SessionStore(db);
  const eventBus = new EventBus();

  // ── Event Handlers ──
  registerTradeTracker(eventBus, trainingLogger);
  registerFactionTracker(eventBus, db);
  const productionStats = createProductionStats();
  registerProductionTracker(eventBus, productionStats);

  // ── Core Services ──
  const galaxy = new Galaxy();
  const nav = new Navigation(galaxy);
  const cargo = new Cargo();
  const fuel = new Fuel(nav);
  const market = new Market(gameCache, galaxy);
  const combat = new Combat(galaxy);
  const crafting = new Crafting(cargo);
  const station = new Station(galaxy);

  const services: SharedServices = {
    galaxy, nav, market, cargo, fuel, combat, crafting, station,
    cache: gameCache, logger: trainingLogger, sessionStore, eventBus,
  };

  // ── API Factory ──
  const apiFactory: ApiClientFactory = (username: string) => {
    return new ApiClient({ username, sessionStore, logger: trainingLogger });
  };

  // ── Bot Manager ──
  const botManager = new BotManager(
    {
      maxBots: config.fleet.max_bots,
      loginStaggerMs: config.fleet.login_stagger_ms,
      snapshotIntervalSec: config.fleet.snapshot_interval,
    },
    services,
    apiFactory,
  );

  // Apply fleet config
  botManager.fleetConfig = {
    homeSystem: config.fleet.home_system,
    homeBase: config.fleet.home_base,
    defaultStorageMode: config.fleet.default_storage_mode,
    factionStorageStation: config.fleet.faction_storage_station,
    factionTaxPercent: config.fleet.faction_tax_percent,
    minBotCredits: config.fleet.min_bot_credits,
  };

  // Load saved fleet settings
  const savedFleetSettings = loadFleetSettings(db);
  if (savedFleetSettings) {
    botManager.fleetConfig.factionTaxPercent = savedFleetSettings.factionTaxPercent;
    botManager.fleetConfig.minBotCredits = savedFleetSettings.minBotCredits;
    console.log(`[Config] Loaded fleet settings: tax=${savedFleetSettings.factionTaxPercent}%, minCredits=${savedFleetSettings.minBotCredits}`);
  }

  // Register routines
  botManager.registerRoutines(buildRoutineRegistry());

  // ── Log Persistence + Broadcast ──
  // Wire bot state changes to persist in DB and broadcast to dashboard
  const LOG_BATCH_INTERVAL_MS = 2_000;
  const MAX_LOG_BATCH = 50;
  let logBatch: Array<{ timestamp: number; level: string; botId: string | null; message: string }> = [];
  let logFlushTimer: ReturnType<typeof setInterval> | null = null;

  const flushLogs = () => {
    if (logBatch.length === 0) return;
    const batch = logBatch.splice(0, MAX_LOG_BATCH);
    try {
      const insertLog = db.insert(activityLog);
      for (const entry of batch) {
        insertLog.values({
          timestamp: entry.timestamp,
          level: entry.level,
          botId: entry.botId,
          message: entry.message,
        }).run();
      }
    } catch (err) {
      console.error(`[Log] Failed to flush ${batch.length} log entries:`, err);
    }
  };

  logFlushTimer = setInterval(flushLogs, LOG_BATCH_INTERVAL_MS);

  botManager.onBotStateChange = (botId: string, routine: string, state: string) => {
    const entry = {
      timestamp: Date.now(),
      level: "info" as const,
      botId,
      message: `${routine}: ${state}`,
    };

    // Buffer for DB persistence
    logBatch.push(entry);
    if (logBatch.length >= MAX_LOG_BATCH) flushLogs();

    // Broadcast live to connected dashboards
    broadcast({
      type: "log_entry",
      entry: {
        timestamp: new Date(entry.timestamp).toISOString(),
        level: entry.level,
        botId: entry.botId,
        message: entry.message,
      },
    });
  };

  // ── Economy Engine ──
  const economy = new EconomyEngine();

  // ── Persistent Memory Store (inspired by CHAPERON) ──
  const memoryStore = new MemoryStore(db);

  // ── Commander Brain ──
  const brain = buildBrain(config, trainingLogger);

  const commanderConfig: CommanderConfig = {
    evaluationIntervalSec: config.commander.evaluation_interval,
    urgencyOverride: config.commander.urgency_override,
  };

  const commanderDeps: CommanderDeps = {
    getFleetStatus: () => botManager.getFleetStatus(),
    assignRoutine: (botId, routine, params) => botManager.assignRoutine(botId, routine as any, params),
    logger: trainingLogger,
    galaxy,
    market,
    cache: gameCache,
    crafting,
    getApi: () => {
      const bots = botManager.getAllBots();
      const readyBot = bots.find(b => b.status === "ready" || b.status === "running");
      return readyBot?.api ?? null;
    },
    homeBase: config.fleet.home_base || undefined,
    memoryStore,
  };

  const commander = new Commander(commanderConfig, commanderDeps, brain);

  // Load saved goals
  const savedGoals = loadGoals(db);
  if (savedGoals.length > 0) {
    commander.setGoals(savedGoals);
    console.log(`[Config] Loaded ${savedGoals.length} saved goals`);
  }

  // ── Load Bot Credentials ──
  const savedBots = sessionStore.listBots();
  for (const creds of savedBots) {
    const bot = botManager.addBot(creds.username);
    const settings = loadBotSettings(db, creds.username);
    if (settings) {
      bot.settings = settings;
    }
  }
  if (savedBots.length > 0) {
    console.log(`[Fleet] Loaded ${savedBots.length} bots from session store`);
  }

  // ── Galaxy + Catalog Loading ──
  let shipCatalogLoaded = false;
  const ensureGalaxyLoaded = async () => {
    // Full galaxy + recipe + item loading via BotManager
    await botManager.loadGalaxy();

    // Ship catalog for upgrade system
    if (!shipCatalogLoaded) {
      const readyBot = botManager.getAllBots().find(b => b.api);
      if (readyBot?.api) {
        try {
          const shipCatalog = await gameCache.getShipCatalog(readyBot.api);
          if (shipCatalog.length > 0) {
            commander.setShipCatalog(shipCatalog);
            shipCatalogLoaded = true;
          }
        } catch (err) {
          console.log(`[Fleet] Failed to load ship catalog: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  };

  // ── Faction Discovery (async, non-blocking, retries every 60s) ──
  let discoveryTimer: ReturnType<typeof setInterval> | null = null;
  const runDiscovery = async () => {
    if (botManager.fleetConfig.homeBase && botManager.fleetConfig.factionStorageStation) return; // Already found
    const result = await discoverFactionStorage(botManager, galaxy, db);
    if (result) {
      propagateFleetHome(botManager, result.stationId, result.systemId);
      if (discoveryTimer) {
        clearInterval(discoveryTimer);
        discoveryTimer = null;
      }
      // Force commander re-eval now that home config is populated
      commander.forceEvaluation();
    }
  };
  runDiscovery(); // Initial attempt (will likely fail before bots login)
  discoveryTimer = setInterval(runDiscovery, 60_000); // Retry every 60s until found

  // ── Web Server ──
  const routerDeps: MessageRouterDeps = {
    botManager,
    commander,
    galaxy,
    db,
    cache: gameCache,
    ensureGalaxyLoaded,
    runDiscovery,
  };

  const serverOpts: ServerOptions = {
    port: config.server.port,
    host: config.server.host,
    staticDir: "web/build",
    db,
    trainingLogger,
    onClientMessage: (ws, msg) => handleClientMessage(ws, msg, routerDeps),
    onClientConnect: (ws) => {
      console.log("[WS] New client — sending initial state");
      // Send fleet settings so dashboard populates immediately
      sendTo(ws, {
        type: "fleet_settings_update",
        settings: {
          factionTaxPercent: botManager.fleetConfig.factionTaxPercent,
          minBotCredits: botManager.fleetConfig.minBotCredits,
          homeSystem: botManager.fleetConfig.homeSystem,
          homeBase: botManager.fleetConfig.homeBase,
          defaultStorageMode: botManager.fleetConfig.defaultStorageMode,
        },
      } as any);

      // Send recent log entries from DB so dashboard has history
      try {
        const since = Date.now() - 3_600_000; // Last hour
        const recentLogs = db.select().from(activityLog)
          .where(gt(activityLog.timestamp, since))
          .orderBy(activityLog.timestamp)
          .limit(200)
          .all();
        for (const row of recentLogs) {
          sendTo(ws, {
            type: "log_entry",
            entry: {
              timestamp: new Date(row.timestamp).toISOString(),
              level: row.level as any,
              botId: row.botId,
              message: row.message,
            },
          });
        }
      } catch {
        // Non-critical — dashboard will fill from live events
      }

      // Send last commander decision
      const lastDecision = commander.getLastDecision();
      if (lastDecision) {
        sendTo(ws, { type: "commander_decision", decision: lastDecision });
      }
    },
  };

  createServer(serverOpts);

  // Register dashboard relay (forward game events to WebSocket clients)
  registerDashboardRelay(eventBus, broadcast as any);

  // ── Broadcast Loop ──
  const broadcastDeps: BroadcastDeps = {
    botManager,
    commander,
    economy,
    galaxy,
    db,
    startTime: Date.now(),
    trainingLogger,
  };

  const stopBroadcast = startBroadcastLoop(broadcastDeps);

  // ── Start Commander Eval Loop ──
  commander.start();

  return {
    db,
    close: () => {
      if (logFlushTimer) clearInterval(logFlushTimer);
      flushLogs(); // Flush remaining logs before close
      sqlite.close();
    },
    galaxy, botManager, commander, economy, sessionStore, stopBroadcast,
  };
}

/** Build the brain based on config */
function buildBrain(config: AppConfig, logger: TrainingLogger): CommanderBrain {
  const scoringBrain = new ScoringBrain({
    reassignmentCooldownMs: config.commander.reassignment_cooldown * 1000,
  });

  if (config.commander.brain === "scoring") {
    return scoringBrain;
  }

  // Build LLM brains for tiered system
  const brainMap: Record<string, () => CommanderBrain> = {
    ollama: () => createOllamaBrain({
      baseUrl: config.ai.ollama_base_url,
      model: config.ai.ollama_model,
      timeoutMs: config.ai.max_latency_ms,
    }),
    gemini: () => createGeminiBrain({
      model: config.ai.gemini_model,
      timeoutMs: config.ai.max_latency_ms,
    }),
    claude: () => createClaudeBrain({
      model: config.ai.claude_model,
      timeoutMs: config.ai.max_latency_ms,
    }),
    scoring: () => scoringBrain,
  };

  if (config.commander.brain === "tiered") {
    const tiers = config.ai.tier_order
      .map(name => brainMap[name]?.())
      .filter((b): b is CommanderBrain => b !== undefined);

    return new TieredBrain({
      tiers,
      shadowBrain: config.ai.shadow_mode ? scoringBrain : undefined,
      onShadowResult: config.ai.shadow_mode
        ? (primary, shadow) => {
            console.log(`[Shadow] ${primary.brainName} vs ${shadow.brainName}: ` +
              `${primary.assignments.length} vs ${shadow.assignments.length} assignments`);
            logger.logShadowComparison({
              tick: Math.floor(Date.now() / 1000),
              primary: {
                brainName: primary.brainName,
                latencyMs: primary.latencyMs,
                confidence: primary.confidence,
                tokenUsage: primary.tokenUsage,
                assignments: primary.assignments.map(a => ({ botId: a.botId, routine: a.routine })),
                reasoning: primary.reasoning,
              },
              shadow: {
                brainName: shadow.brainName,
                assignments: shadow.assignments.map(a => ({ botId: a.botId, routine: a.routine })),
                reasoning: shadow.reasoning,
              },
              fleetInput: {},
            });
          }
        : undefined,
    });
  }

  // Single brain mode (ollama, gemini, claude)
  const factory = brainMap[config.commander.brain];
  return factory ? factory() : scoringBrain;
}
