/**
 * Startup wiring — creates and connects all services for SpaceMolt Commander v3.
 * Called by app.ts with loaded config.
 *
 * Supports PostgreSQL + Redis + multi-tenant scoping (v4).
 * SQLite remains as legacy fallback when database URL is a file path.
 */

import crypto from "crypto";
import type { AppConfig } from "./config/schema";
import { createDatabase, type DB, type DatabaseConnection } from "./data/db";
import { createRedisClient } from "./data/redis";
import { RedisCache } from "./data/cache-redis";
import { GameCache } from "./data/game-cache";
import { TrainingLogger } from "./data/training-logger";
import { SessionStore } from "./data/session-store";
import { RetentionManager } from "./data/retention";
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
import { createOpenAIBrain } from "./commander/openai-brain";
import { createGeminiBrain } from "./commander/gemini-brain";
import { createClaudeBrain } from "./commander/claude-brain";
import { EconomyEngine } from "./commander/economy-engine";
import { buildRoutineRegistry } from "./routines";
import { createServer, broadcast, sendTo, type ServerOptions } from "./server/server";
import { activityLog } from "./data/schema";
import { gt, lt, eq, and } from "drizzle-orm";
import { handleClientMessage, type MessageRouterDeps } from "./server/message-router";
import { startBroadcastLoop, type BroadcastDeps } from "./server/broadcast";
import {
  loadBotSettings, loadBotSkills, loadFleetSettings, loadGoals,
  saveBotSettings, saveBotSkills,
  discoverFactionStorage, propagateFleetHome,
  ensureFactionMembership,
} from "./fleet";
import type { CommanderBrain } from "./commander/types";
import { MemoryStore } from "./data/memory-store";
import { EmbeddingStore } from "./commander/embedding-store";
import { parseBotRole, type RolePoolConfig } from "./commander/roles";
import type Redis from "ioredis";

export interface AppServices {
  db: DB;
  close: () => Promise<void>;
  galaxy: Galaxy;
  botManager: BotManager;
  commander: Commander;
  economy: EconomyEngine;
  sessionStore: SessionStore;
  stopBroadcast: () => void;
  tenantId: string;
  redis: Redis | null;
}

/**
 * Check LM Studio is running with the correct models loaded.
 * Only runs when openai is in the tier_order or embed_provider is "openai".
 */
async function ensureLmStudioModels(config: AppConfig): Promise<void> {
  const useOpenAI = config.ai.tier_order.includes("openai") || config.ai.embed_provider === "openai";
  if (!useOpenAI) return;

  const baseUrl = config.ai.openai_base_url;
  const llmModel = config.ai.openai_model;
  const embedModel = config.ai.embed_model;

  // 1. Check what's loaded
  let loaded: string[];
  try {
    const resp = await fetch(`${baseUrl}/v1/models`);
    const data = await resp.json() as { data?: Array<{ id: string }> };
    loaded = data.data?.map((m) => m.id) ?? [];
  } catch {
    console.error(`[Startup] Cannot connect to LM Studio at ${baseUrl}. Is it running?`);
    process.exit(1);
  }

  // 2. Check for wrong models
  if (loaded.length > 0) {
    const hasLlm = loaded.some(id => id === llmModel || id.includes(llmModel));
    const hasEmbed = loaded.some(id => id === embedModel || id.includes(embedModel));

    if (!hasLlm && !hasEmbed) {
      console.error(`[Startup] LM Studio has wrong models loaded: ${loaded.join(', ')}`);
      console.error(`[Startup] Expected LLM: ${llmModel}, Embedding: ${embedModel}`);
      console.error(`[Startup] Unload current models and restart, or update config.toml`);
      process.exit(1);
    }
  }

  // 3. Load missing models
  if (!loaded.some(id => id === llmModel || id.includes(llmModel))) {
    console.log(`[Startup] Loading LLM model: ${llmModel}...`);
    try {
      const resp = await fetch(`${baseUrl}/api/v1/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: llmModel }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      console.log(`[Startup] LLM model loaded: ${llmModel}`);
    } catch (e) {
      console.error(`[Startup] Failed to load LLM model ${llmModel}: ${e}`);
      process.exit(1);
    }
  } else {
    console.log(`[Startup] LLM model already loaded: ${llmModel}`);
  }

  if (!loaded.some(id => id === embedModel || id.includes(embedModel))) {
    console.log(`[Startup] Loading embedding model: ${embedModel}...`);
    try {
      const resp = await fetch(`${baseUrl}/api/v1/models/load`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embedModel }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      console.log(`[Startup] Embedding model loaded: ${embedModel}`);
    } catch (e) {
      console.error(`[Startup] Failed to load embedding model ${embedModel}: ${e}`);
      process.exit(1);
    }
  } else {
    console.log(`[Startup] Embedding model already loaded: ${embedModel}`);
  }
}

/**
 * Wire all services together and start the application.
 */
export async function startup(config: AppConfig): Promise<AppServices> {
  // ── LM Studio model check (before anything else that uses AI) ──
  await ensureLmStudioModels(config);

  // ── Tenant ID ──
  const tenantId = config._tenantId || config.database?.tenant_id || crypto.randomUUID();
  console.log(`[Startup] Tenant ID: ${tenantId}`);

  // ── Database ──
  const dbUrl = config._dbPath ?? config.database?.url ?? "commander.db";
  const connection: DatabaseConnection = createDatabase(dbUrl);
  const { db, driver } = connection;
  console.log(`[Startup] Database driver: ${driver} (${driver === "postgresql" ? "managed by drizzle-kit" : dbUrl})`);

  // ── Redis (optional) ──
  const redisUrl = config._redisUrl ?? (config.redis?.enabled ? config.redis.url : undefined);
  const redisClient: Redis | null = redisUrl ? createRedisClient(redisUrl) : null;
  const redisCache: RedisCache | null = redisClient ? new RedisCache(redisClient, tenantId) : null;
  if (redisClient) {
    console.log(`[Startup] Redis enabled (tenant-scoped)`);
  }

  // ── Data Layer ──
  const trainingLogger = new TrainingLogger(db, tenantId);
  const gameCache = new GameCache(db, trainingLogger, redisCache, tenantId);
  const shipyardCount = await gameCache.loadShipyardData();
  if (shipyardCount > 0) console.log(`[Cache] Loaded ${shipyardCount} shipyard scans from disk`);
  await gameCache.loadRecentMarketData();
  const sessionStore = new SessionStore(db, tenantId);
  const eventBus = new EventBus();

  // ── Retention Manager ──
  const retentionManager = new RetentionManager(db, tenantId);

  // ── Cleanup stale data ──
  try {
    const cutoff = Date.now() - 48 * 3_600_000; // 48 hours
    await db.delete(activityLog).where(and(eq(activityLog.tenantId, tenantId), lt(activityLog.timestamp, cutoff)));
    console.log(`[Cleanup] Trimmed activity log entries older than 48h`);
  } catch { /* non-critical */ }

  // ── Event Handlers ──
  registerTradeTracker(eventBus, trainingLogger);
  registerFactionTracker(eventBus, db, tenantId);
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
    const client = new ApiClient({ username, sessionStore, logger: trainingLogger });
    // Restore session asynchronously (fire-and-forget, login will re-auth if needed)
    client.restoreSession().catch((e) => console.warn(`Failed to restore session for ${username}: ${e}`));
    return client;
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
    maxBotCredits: config.fleet.max_bot_credits,
    facilityBuildQueue: [],
  };

  // Load saved fleet settings
  const savedFleetSettings = await loadFleetSettings(db, tenantId);
  if (savedFleetSettings) {
    botManager.fleetConfig.factionTaxPercent = savedFleetSettings.factionTaxPercent;
    botManager.fleetConfig.minBotCredits = savedFleetSettings.minBotCredits;
    botManager.fleetConfig.maxBotCredits = savedFleetSettings.maxBotCredits;
    if (savedFleetSettings.homeSystem) botManager.fleetConfig.homeSystem = savedFleetSettings.homeSystem;
    if (savedFleetSettings.homeBase) botManager.fleetConfig.homeBase = savedFleetSettings.homeBase;
    if (savedFleetSettings.defaultStorageMode) botManager.fleetConfig.defaultStorageMode = savedFleetSettings.defaultStorageMode as "sell" | "deposit" | "faction_deposit";
    console.log(`[Config] Loaded fleet settings: tax=${savedFleetSettings.factionTaxPercent}%, minCredits=${savedFleetSettings.minBotCredits}, maxCredits=${savedFleetSettings.maxBotCredits}, home=${savedFleetSettings.homeSystem || 'auto'}/${savedFleetSettings.homeBase || 'auto'}, storage=${savedFleetSettings.defaultStorageMode || 'config'}`);
  }

  // Register routines
  botManager.registerRoutines(buildRoutineRegistry());

  // ── Log Persistence + Broadcast ──
  // Wire bot state changes to persist in DB and broadcast to dashboard
  const LOG_BATCH_INTERVAL_MS = 2_000;
  const MAX_LOG_BATCH = 50;
  let logBatch: Array<{ timestamp: number; level: string; botId: string | null; message: string }> = [];
  let logFlushTimer: ReturnType<typeof setInterval> | null = null;

  const flushLogs = async () => {
    if (logBatch.length === 0) return;
    const batch = logBatch.splice(0, MAX_LOG_BATCH);
    try {
      // For SQLite we can use raw transactions for performance.
      // For PostgreSQL, Drizzle handles batching efficiently.
      if (driver === "sqlite") {
        const sqlite = connection.raw as unknown as import("bun:sqlite").Database;
        sqlite.exec("BEGIN");
        try {
          for (const entry of batch) {
            await db.insert(activityLog).values({
              tenantId,
              timestamp: entry.timestamp,
              level: entry.level,
              botId: entry.botId ?? null,
              message: entry.message,
            });
          }
          sqlite.exec("COMMIT");
        } catch (err) {
          try { sqlite.exec("ROLLBACK"); } catch { /* ignore */ }
          throw err;
        }
      } else {
        // PostgreSQL — insert all entries (Drizzle handles async)
        for (const entry of batch) {
          await db.insert(activityLog).values({
            tenantId,
            timestamp: entry.timestamp,
            level: entry.level,
            botId: entry.botId ?? null,
            message: entry.message,
          });
        }
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
  economy.crafting = crafting;

  // ── Persistent Memory Store (inspired by CHAPERON) ──
  const memoryStore = new MemoryStore(db, tenantId);

  // ── Contextual Bandit (learns per-role routine weights from outcomes) ──
  const { BanditBrain } = await import("./commander/bandit-brain");
  const banditBrain = new BanditBrain(db, tenantId, { alpha: 0.5 });
  await banditBrain.init();
  console.log(`[Startup] Bandit brain loaded: ${banditBrain.getTotalEpisodes()} historical episodes`);

  // ── Embedding Store (semantic memory for strategic decisions) ──
  const embeddingStore = new EmbeddingStore(db, {
    provider: config.ai.embed_provider,
    baseUrl: config.ai.embed_provider === "openai" ? config.ai.openai_base_url : config.ai.ollama_base_url,
    model: config.ai.embed_model,
    tenantId,
  });
  // Check embedding model availability (non-blocking)
  embeddingStore.checkHealth().then(available => {
    if (available) {
      console.log(`[Startup] Embedding model (${config.ai.embed_model}) available for semantic memory`);
    } else {
      console.log(`[Startup] Embedding model not available — memory store will use recency fallback`);
    }
  }).catch(() => {});

  // ── Commander Brain ──
  const brain = buildBrain(config, trainingLogger);

  const commanderConfig: CommanderConfig = {
    evaluationIntervalSec: savedFleetSettings?.evaluationInterval ?? config.commander.evaluation_interval,
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
    getFleetConfig: () => botManager.fleetConfig,
    memoryStore,
    setBotRole: (botId: string, role: string | null) => {
      const bot = botManager.getBot(botId);
      if (!bot) return;
      bot.role = role;
      bot.settings.role = role;
      saveBotSettings(db, tenantId, bot.username, bot.settings);
    },
    recoverErrorBots: () => botManager.recoverStuckBots(),
    isBotManual: (botId: string) => botManager.getBot(botId)?.settings.manualControl ?? false,
    embeddingStore,
    ollamaConfig: {
      baseUrl: config.ai.ollama_base_url,
      model: config.ai.ollama_model,
    },
  };

  const commander = new Commander(commanderConfig, commanderDeps, brain);

  // Attach bandit brain to scoring brain (learns base weights from outcomes)
  const scoringBrain = commander.getScoringBrain?.() ?? (brain instanceof ScoringBrain ? brain : null);
  if (scoringBrain) {
    (scoringBrain as any).banditBrain = banditBrain;
    console.log("[Startup] Bandit brain attached to scoring brain");
  }

  // Load role pool config from config.toml
  if (config.fleet.roles.length > 0) {
    const poolConfig: RolePoolConfig[] = config.fleet.roles
      .filter(r => parseBotRole(r.role))
      .map(r => ({
        role: parseBotRole(r.role)!,
        min: r.min,
        max: r.max,
        preferredShip: r.preferred_ship,
      }));
    if (poolConfig.length > 0) {
      commander.setPoolConfig(poolConfig);
      console.log(`[Config] Loaded ${poolConfig.length} role pool configs`);
    }
  }

  // Load saved goals
  const savedGoals = await loadGoals(db, tenantId);
  if (savedGoals.length > 0) {
    commander.setGoals(savedGoals);
    console.log(`[Config] Loaded ${savedGoals.length} saved goals`);
  }

  // ── Load Bot Credentials ──
  const savedBots = await sessionStore.listBots();
  const manualBotIds = new Set<string>();
  for (const creds of savedBots) {
    const bot = botManager.addBot(creds.username);
    const settings = await loadBotSettings(db, tenantId, creds.username);
    if (settings) {
      bot.settings = settings;
      if (settings.role) bot.role = settings.role;
      if (settings.manualControl) manualBotIds.add(bot.id);
    }
    // Seed cached skills from DB (available immediately without API call)
    const cachedSkills = await loadBotSkills(db, tenantId, creds.username);
    if (cachedSkills) bot.seedSkills(cachedSkills);
    // Persist skills to DB whenever refreshed from API
    bot.onSkillsRefreshed = (username, skills) => {
      try { saveBotSkills(db, tenantId, username, skills); } catch { /* non-critical */ }
    };
  }
  if (savedBots.length > 0) {
    console.log(`[Fleet] Loaded ${savedBots.length} bots from session store`);

    // Auto-login all non-manual bots so Commander can assign routines immediately
    botManager.loginAll(manualBotIds).then(({ success, failed }) => {
      if (success.length > 0) console.log(`[Fleet] Auto-started ${success.length} bots: ${success.join(", ")}`);
      if (failed.length > 0) console.log(`[Fleet] Failed to start ${failed.length} bots: ${failed.map(f => `${f.username}: ${f.error}`).join(", ")}`);
    }).catch(err => {
      console.error(`[Fleet] Auto-start error: ${err instanceof Error ? err.message : err}`);
    });
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

  // ── Hydrate known resource locations into galaxy (silicon, crystals, etc.) ──
  const { KNOWN_RESOURCE_LOCATIONS } = await import("./config/constants");
  for (const loc of KNOWN_RESOURCE_LOCATIONS) {
    const existing = galaxy.getSystemForPoi(loc.poiId);
    if (!existing) {
      galaxy.hydrateFromPersistedPois([{
        poiId: loc.poiId,
        systemId: loc.systemId,
        poi: {
          id: loc.poiId,
          name: loc.poiName,
          type: loc.poiType as any,
          hasBase: false, baseId: null, baseName: null,
          resources: loc.resources.map(r => ({ resourceId: r.resourceId, richness: r.richness, remaining: 9999 })),
        },
      }]);
      console.log(`[Startup] Hydrated known POI: ${loc.poiName} (${loc.systemId}) — ${loc.resources.map(r => r.resourceId).join(", ")}`);
    }
  }

  // ── Faction Discovery (async, non-blocking, retries every 60s) ──
  let discoveryTimer: ReturnType<typeof setInterval> | null = null;
  const runDiscovery = async () => {
    if (botManager.fleetConfig.homeBase && botManager.fleetConfig.factionStorageStation) return; // Already found
    const result = await discoverFactionStorage(botManager, galaxy, db, tenantId);
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
    tenantId,
    cache: gameCache,
    sessionStore,
    ensureGalaxyLoaded,
    runDiscovery,
  };

  const serverOpts: ServerOptions = {
    port: config.server.port,
    host: config.server.host,
    staticDir: "web/build",
    db,
    tenantId,
    requireAuth: config._requireAuth,
    trainingLogger,
    botManager: botManager as any,
    startTime: Date.now(),
    onClientMessage: (ws, msg) => handleClientMessage(ws, msg, routerDeps),
    onClientConnect: (ws) => {
      console.log("[WS] New client — sending initial state");
      // Send fleet settings so dashboard populates immediately
      sendTo(ws, {
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
      } as any);

      // Send recent log entries from DB so dashboard has history
      (async () => {
        try {
          const since = Date.now() - 3_600_000; // Last hour
          const recentLogs = await db.select().from(activityLog)
            .where(gt(activityLog.timestamp, since))
            .orderBy(activityLog.timestamp)
            .limit(200);
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
      })();

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
    tenantId,
    startTime: Date.now(),
    trainingLogger,
    broadcastConfig: config.broadcast ? {
      tickIntervalMs: config.broadcast.tick_interval_ms,
      snapshotIntervalTicks: config.broadcast.snapshot_interval_ticks,
      creditHistoryIntervalTicks: config.broadcast.credit_history_interval_ticks,
      maxGlobalSnapshots: config.broadcast.max_global_snapshots,
    } : undefined,
  };

  const stopBroadcast = startBroadcastLoop(broadcastDeps);

  // ── Inject facility upgrade material needs (warehouse upgrade) ──
  // These create high-priority work orders so miners/crafters target these materials
  // Circuit board recipe: 3 copper_ore + 2 silicon_ore + 1 energy_crystal → 1 circuit_board
  // Steel plate recipe: 5 iron_ore → 1 steel_plate
  const warehouseNeeds = new Map<string, number>();
  warehouseNeeds.set("steel_plate", 500);
  warehouseNeeds.set("circuit_board", 200);
  warehouseNeeds.set("silicon_ore", 400);       // 200 boards × 2 silicon each
  warehouseNeeds.set("energy_crystal", 200);    // 200 boards × 1 crystal each
  warehouseNeeds.set("iron_ore", 2500);         // 500 plates × 5 iron each
  gameCache.setFacilityMaterialNeeds(warehouseNeeds);
  console.log("[Startup] Facility material needs set: warehouse upgrade (steel plates, circuit boards, raw ores)");

  // ── Start Commander Eval Loop ──
  commander.start();

  return {
    db,
    close: async () => {
      commander.stop();
      stopBroadcast();
      if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
      if (logFlushTimer) clearInterval(logFlushTimer);
      await flushLogs(); // Flush remaining logs before close
      await connection.close(); // Close PG pool or SQLite file
      // Disconnect Redis if connected
      if (redisClient) {
        try { redisClient.disconnect(); } catch { /* ignore */ }
      }
    },
    galaxy, botManager, commander, economy, sessionStore, stopBroadcast,
    tenantId,
    redis: redisClient,
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
  const promptFile = config.ai.prompt_file || undefined;
  const brainMap: Record<string, () => CommanderBrain> = {
    ollama: () => createOllamaBrain({
      baseUrl: config.ai.ollama_base_url,
      model: config.ai.ollama_model,
      timeoutMs: config.ai.max_latency_ms,
      maxTokens: config.ai.max_tokens,
      promptFile,
    }),
    openai: () => createOpenAIBrain({
      baseUrl: config.ai.openai_base_url,
      model: config.ai.openai_model,
      timeoutMs: config.ai.max_latency_ms,
      maxTokens: config.ai.max_tokens,
      promptFile,
    }),
    gemini: () => createGeminiBrain({
      model: config.ai.gemini_model,
      timeoutMs: config.ai.max_latency_ms,
      maxTokens: config.ai.max_tokens,
      promptFile,
    }),
    claude: () => createClaudeBrain({
      model: config.ai.claude_model,
      timeoutMs: config.ai.max_latency_ms,
      maxTokens: config.ai.max_tokens,
      promptFile,
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
