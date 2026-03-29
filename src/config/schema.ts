/**
 * Configuration types with Zod validation — v3 with [ai] section.
 */

import { z } from "zod";

// ── Goal Types ──

export const GoalTypeSchema = z.enum([
  "maximize_income",
  "maximize_profit",
  "explore_region",
  "prepare_for_war",
  "level_skills",
  "establish_trade_route",
  "resource_stockpile",
  "faction_operations",
  "upgrade_ships",
  "upgrade_modules",
  "custom",
]);

export type GoalType = z.infer<typeof GoalTypeSchema>;

export const GoalSchema = z.object({
  type: GoalTypeSchema,
  priority: z.number().int().min(1),
  params: z.record(z.unknown()).default({}),
  constraints: z.object({
    maxRiskLevel: z.number().int().min(0).max(4).optional(),
    regionLock: z.array(z.string()).optional(),
    budgetLimit: z.number().optional(),
  }).optional(),
});

export type Goal = z.infer<typeof GoalSchema>;

// ── Commander Config ──

export const CommanderConfigSchema = z.object({
  brain: z.enum(["scoring", "ollama", "gemini", "claude", "tiered"]).default("tiered"),
  evaluation_interval: z.number().default(60),
  reassignment_cooldown: z.number().default(300),
  reassignment_threshold: z.number().default(0.3),
  switch_cost_weight: z.number().default(1.0),
  urgency_override: z.boolean().default(true),
});

// ── AI Config (v3 new) ──

export const AiConfigSchema = z.object({
  ollama_base_url: z.string().default("http://localhost:11434"),
  ollama_model: z.string().default("qwen3:8b"),
  openai_base_url: z.string().default("http://127.0.0.1:1234"),
  openai_model: z.string().default("openai/gpt-oss-20b"),
  gemini_model: z.string().default("gemini-2.5-pro"),
  claude_model: z.string().default("claude-3-5-haiku-latest"),
  tier_order: z.array(z.enum(["ollama", "openai", "gemini", "claude", "scoring"])).default(["ollama", "gemini", "claude", "scoring"]),
  max_latency_ms: z.number().default(10000),
  max_tokens: z.number().default(2048),
  shadow_mode: z.boolean().default(false),
  prompt_file: z.string().default(""),
  embed_provider: z.enum(["ollama", "openai"]).default("openai"),
  embed_model: z.string().default("text-embedding-nomic-embed-text-v1.5"),
});

export type AiConfig = z.infer<typeof AiConfigSchema>;

// ── Role Pool Config ──

export const RolePoolSchema = z.object({
  role: z.string(),
  min: z.number().int().min(0).default(0),
  max: z.number().int().min(0).default(1),
  preferred_ship: z.string().default(""),
});

export type RolePool = z.infer<typeof RolePoolSchema>;

// ── Fleet Config ──

export const FleetConfigSchema = z.object({
  max_bots: z.number().int().default(20),
  login_stagger_ms: z.number().default(5000),
  snapshot_interval: z.number().default(30),
  home_system: z.string().default(""),
  home_base: z.string().default(""),
  default_storage_mode: z.enum(["sell", "deposit", "faction_deposit"]).default("sell"),
  faction_storage_station: z.string().default(""),
  faction_tax_percent: z.number().min(0).max(100).default(0),
  min_bot_credits: z.number().min(0).default(0),
  max_bot_credits: z.number().min(0).default(0),
  roles: z.array(RolePoolSchema).default([]),
});

// ── Cache Config ──

export const CacheConfigSchema = z.object({
  market_ttl_ms: z.number().default(300_000),
  system_ttl_ms: z.number().default(3_600_000),
  catalog_refresh: z.enum(["on_version_change", "daily"]).default("on_version_change"),
});

// ── Server Config ──

export const ServerConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default("localhost"),
});

// ── Broadcast Config ──

export const BroadcastConfigSchema = z.object({
  tick_interval_ms: z.number().min(1000).default(3_000),
  snapshot_interval_ticks: z.number().min(1).default(10),
  credit_history_interval_ticks: z.number().min(1).default(10),
  max_global_snapshots: z.number().min(100).default(10_000),
});

// ── Training Config ──

export const TrainingConfigSchema = z.object({
  log_decisions: z.boolean().default(true),
  log_snapshots: z.boolean().default(true),
  log_episodes: z.boolean().default(true),
  log_market_history: z.boolean().default(true),
  snapshot_interval: z.number().default(30),
});

// ── Economy Config ──

export const EconomyConfigSchema = z.object({
  enable_premium_orders: z.boolean().default(true),
  max_premium_pct: z.number().default(50),
  min_crafting_margin_pct: z.number().default(30),
  batch_sell_size: z.number().default(100),
  order_stale_timeout_min: z.number().default(120),
});

// ── Stock Targets ──

export const StockTargetSchema = z.object({
  station_id: z.string(),
  item_id: z.string(),
  min_stock: z.number().int().min(0),
  max_stock: z.number().int().min(0),
  purpose: z.enum(["crafting", "trading", "fuel", "ammo", "strategic"]),
});

export type StockTarget = z.infer<typeof StockTargetSchema>;

// ── Database Config ──

export const DatabaseConfigSchema = z.object({
  url: z.string().default("commander.db"),
  driver: z.enum(["postgresql", "sqlite"]).default("sqlite"),
  tenant_id: z.string().default(""),
});

// ── Redis Config ──

export const RedisConfigSchema = z.object({
  url: z.string().default(""),
  enabled: z.boolean().default(false),
});

// ── Full Config ──

export const AppConfigSchema = z.object({
  commander: CommanderConfigSchema.default({}),
  ai: AiConfigSchema.default({}),
  goals: z.array(GoalSchema).default([{ type: "maximize_profit", priority: 1, params: {} }]),
  fleet: FleetConfigSchema.default({}),
  cache: CacheConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  training: TrainingConfigSchema.default({}),
  economy: EconomyConfigSchema.default({}),
  broadcast: BroadcastConfigSchema.default({}),
  database: DatabaseConfigSchema.default({}),
  redis: RedisConfigSchema.default({}),
  inventory_targets: z.array(StockTargetSchema).default([]),
});

export type AppConfig = z.infer<typeof AppConfigSchema> & {
  /** Runtime override: database URL (from CLI --database-url flag) */
  _dbPath?: string;
  /** Runtime override: tenant ID (from CLI --tenant-id flag) */
  _tenantId?: string;
  /** Runtime override: Redis URL (from CLI --redis-url flag) */
  _redisUrl?: string;
  /** Runtime override: require auth (multi-tenant mode) */
  _requireAuth?: boolean;
};
