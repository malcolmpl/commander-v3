/**
 * Drizzle ORM schema — all 17 tables for SpaceMolt Commander v3.
 * Single SQLite file: commander.db
 */

import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ── Static Data Cache (version-gated) ──

export const cache = sqliteTable("cache", {
  key: text("key").primaryKey(),
  data: text("data").notNull(),
  gameVersion: text("game_version"),
  fetchedAt: integer("fetched_at").notNull(),
});

// ── Timed Cache (market, system, poi) ──

export const timedCache = sqliteTable("timed_cache", {
  key: text("key").primaryKey(),
  data: text("data").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
  ttlMs: integer("ttl_ms").notNull(),
});

// ── Decision Log (training data) ──

export const decisionLog = sqliteTable("decision_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  botId: text("bot_id").notNull(),
  action: text("action").notNull(),
  params: text("params"),
  context: text("context").notNull(),
  result: text("result"),
  commanderGoal: text("commander_goal"),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_decision_log_bot").on(table.botId),
  index("idx_decision_log_tick").on(table.tick),
  index("idx_decision_log_action").on(table.action),
]);

// ── State Snapshots ──

export const stateSnapshots = sqliteTable("state_snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  botId: text("bot_id").notNull(),
  playerState: text("player_state").notNull(),
  shipState: text("ship_state").notNull(),
  location: text("location").notNull(),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_snapshots_bot").on(table.botId),
  index("idx_snapshots_tick").on(table.tick),
]);

// ── Episode Summaries ──

export const episodes = sqliteTable("episodes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  botId: text("bot_id").notNull(),
  episodeType: text("episode_type").notNull(),
  startTick: integer("start_tick").notNull(),
  endTick: integer("end_tick").notNull(),
  durationTicks: integer("duration_ticks").notNull(),
  startCredits: integer("start_credits"),
  endCredits: integer("end_credits"),
  profit: integer("profit"),
  route: text("route"),
  itemsInvolved: text("items_involved"),
  fuelConsumed: integer("fuel_consumed"),
  risks: text("risks"),
  commanderGoal: text("commander_goal"),
  success: integer("success").notNull().default(1),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_episodes_bot").on(table.botId),
  index("idx_episodes_type").on(table.episodeType),
]);

// ── Market Price History ──

export const marketHistory = sqliteTable("market_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  stationId: text("station_id").notNull(),
  itemId: text("item_id").notNull(),
  buyPrice: real("buy_price"),
  sellPrice: real("sell_price"),
  buyVolume: integer("buy_volume"),
  sellVolume: integer("sell_volume"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_market_station_item").on(table.stationId, table.itemId),
  index("idx_market_tick").on(table.tick),
]);

// ── Commander Decisions Log ──

export const commanderLog = sqliteTable("commander_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  goal: text("goal").notNull(),
  fleetState: text("fleet_state").notNull(),
  assignments: text("assignments").notNull(),
  reasoning: text("reasoning").notNull(),
  economyState: text("economy_state"),
  gameVersion: text("game_version").notNull(),
  commanderVersion: text("commander_version").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_commander_tick").on(table.tick),
]);

// ── Bot Sessions (credentials) ──

export const botSessions = sqliteTable("bot_sessions", {
  username: text("username").primaryKey(),
  password: text("password").notNull(),
  empire: text("empire"),
  playerId: text("player_id"),
  sessionId: text("session_id"),
  sessionExpiresAt: text("session_expires_at"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ── Credit History ──

export const creditHistory = sqliteTable("credit_history", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: integer("timestamp").notNull(),
  totalCredits: integer("total_credits").notNull(),
  activeBots: integer("active_bots").notNull(),
}, (table) => [
  index("idx_credit_ts").on(table.timestamp),
]);

// ── Goals (persisted across restarts) ──

export const goals = sqliteTable("goals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  type: text("type").notNull(),
  priority: integer("priority").notNull(),
  params: text("params").notNull().default("{}"),
  constraints: text("constraints"),
});

// ── Bot Settings ──

export const botSettings = sqliteTable("bot_settings", {
  username: text("username").primaryKey(),
  fuelEmergencyThreshold: real("fuel_emergency_threshold").notNull().default(20),
  autoRepair: integer("auto_repair").notNull().default(1),
  maxCargoFillPct: real("max_cargo_fill_pct").notNull().default(90),
  storageMode: text("storage_mode").notNull().default("sell"),
  factionStorage: integer("faction_storage").notNull().default(0),
  role: text("role"),
  manualControl: integer("manual_control").notNull().default(0),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ── Financial Events (profit chart) ──

export const financialEvents = sqliteTable("financial_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: integer("timestamp").notNull(),
  eventType: text("event_type").notNull(),
  amount: real("amount").notNull(),
  botId: text("bot_id"),
  source: text("source"),
}, (table) => [
  index("idx_financial_ts").on(table.timestamp),
  index("idx_financial_type").on(table.eventType),
]);

// ── Trade Log ──

export const tradeLog = sqliteTable("trade_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: integer("timestamp").notNull(),
  botId: text("bot_id").notNull(),
  action: text("action").notNull(),
  itemId: text("item_id").notNull(),
  quantity: integer("quantity").notNull(),
  priceEach: real("price_each").notNull(),
  total: real("total").notNull(),
  stationId: text("station_id"),
}, (table) => [
  index("idx_trade_ts").on(table.timestamp),
  index("idx_trade_bot").on(table.botId),
]);

// ── Fleet Settings (key-value) ──

export const fleetSettings = sqliteTable("fleet_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ── LLM Decisions (v3 new — AI brain comparison data) ──

export const llmDecisions = sqliteTable("llm_decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tick: integer("tick").notNull(),
  brainName: text("brain_name").notNull(),
  latencyMs: integer("latency_ms").notNull(),
  confidence: real("confidence"),
  tokenUsage: integer("token_usage"),
  fleetInput: text("fleet_input").notNull(),
  assignments: text("assignments").notNull(),
  reasoning: text("reasoning"),
  scoringBrainAssignments: text("scoring_brain_assignments"),
  agreementRate: real("agreement_rate"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_llm_tick").on(table.tick),
  index("idx_llm_brain").on(table.brainName),
]);

// ── POI Cache (persistent POI resources) ──

export const poiCache = sqliteTable("poi_cache", {
  poiId: text("poi_id").primaryKey(),
  systemId: text("system_id").notNull(),
  data: text("data").notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_poi_system").on(table.systemId),
]);

// ── Faction Transaction Log (deposits, withdrawals, credits) ──

export const factionTransactions = sqliteTable("faction_transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: integer("timestamp").notNull(),
  botId: text("bot_id"),
  type: text("type").notNull(), // "item_deposit" | "item_withdraw" | "credit_deposit" | "credit_withdraw" | "sell_order" | "buy_order"
  itemId: text("item_id"),
  itemName: text("item_name"),
  quantity: integer("quantity"),
  credits: real("credits"),
  details: text("details"),
}, (table) => [
  index("idx_faction_tx_ts").on(table.timestamp),
  index("idx_faction_tx_type").on(table.type),
]);

// ── Activity Log (bot routine state changes, persisted for dashboard history) ──

export const activityLog = sqliteTable("activity_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  timestamp: integer("timestamp").notNull(),
  level: text("level").notNull().default("info"),
  botId: text("bot_id"),
  message: text("message").notNull(),
  details: text("details"),
}, (table) => [
  index("idx_activity_ts").on(table.timestamp),
  index("idx_activity_bot").on(table.botId),
]);

// ── Commander Memory (persistent knowledge base, inspired by CHAPERON) ──

export const commanderMemory = sqliteTable("commander_memory", {
  key: text("key").primaryKey(),
  fact: text("fact").notNull(),
  importance: integer("importance").notNull().default(5),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ── Bot Skills (persisted skill snapshots) ──

export const botSkills = sqliteTable("bot_skills", {
  username: text("username").primaryKey(),
  skills: text("skills").notNull(),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// ── Outcome Embeddings (semantic memory for strategic decisions) ──

export const outcomeEmbeddings = sqliteTable("outcome_embeddings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Human-readable description of the outcome */
  text: text("text").notNull(),
  /** Serialized float32 embedding vector from nomic-embed-text */
  embedding: text("embedding").notNull(),
  /** Category: trade_outcome, mine_outcome, craft_outcome, market_intel, strategic */
  category: text("category").notNull(),
  /** Structured metadata (JSON: item, profit, route, system, etc.) */
  metadata: text("metadata").notNull().default("{}"),
  /** Credit impact of this outcome (positive = profitable) */
  profitImpact: real("profit_impact"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
}, (table) => [
  index("idx_embed_category").on(table.category),
  index("idx_embed_created").on(table.createdAt),
  index("idx_embed_profit").on(table.profitImpact),
]);
