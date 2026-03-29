/**
 * Database setup with Drizzle ORM.
 * Supports PostgreSQL (primary) and SQLite (legacy fallback).
 *
 * PostgreSQL: uses postgres.js driver
 * SQLite: uses bun:sqlite (for local dev / backwards compatibility)
 */

import { sql } from "drizzle-orm";

// ── PostgreSQL ──
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import * as pgSchema from "./schema-pg";

// ── SQLite (legacy) ──
import { Database } from "bun:sqlite";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import * as sqliteSchema from "./schema-sqlite";

/** PostgreSQL database type */
export type DB = ReturnType<typeof drizzlePg>;

export interface DatabaseConnection {
  db: DB;
  driver: "postgresql" | "sqlite";
  /** Close the connection pool / database */
  close: () => Promise<void>;
  /** Raw SQL client for PostgreSQL */
  raw: postgres.Sql;
}

/**
 * Create a PostgreSQL database connection.
 */
export function createPostgresDatabase(url: string): DatabaseConnection {
  const client = postgres(url, {
    max: 20,                  // connection pool size
    idle_timeout: 30,         // close idle connections after 30s
    connect_timeout: 10,      // 10s connection timeout
    prepare: false,           // disable prepared statements (better for connection pooling)
    transform: {
      undefined: null,        // convert undefined values to null (matches SQLite behavior)
    },
  });

  const db = drizzlePg(client, { schema: pgSchema });

  return {
    db,
    driver: "postgresql",
    raw: client,
    close: async () => { await client.end(); },
  };
}

/**
 * Create a SQLite database connection (legacy / local dev).
 */
export function createSqliteDatabase(dbPath = "commander.db"): DatabaseConnection {
  const sqlite = new Database(dbPath, { create: true });

  // Performance pragmas
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA cache_size = -64000");
  sqlite.run("PRAGMA busy_timeout = 5000");

  // Auto-create tables
  ensureSqliteTables(sqlite);

  const db = drizzleSqlite(sqlite, { schema: sqliteSchema });

  return {
    db,
    driver: "sqlite",
    raw: sqlite,
    close: async () => { sqlite.close(); },
  };
}

/**
 * Create database connection based on config.
 * If databaseUrl starts with "postgresql://" or "postgres://", use PostgreSQL.
 * Otherwise treat as SQLite file path.
 */
export function createDatabase(databaseUrl: string): DatabaseConnection {
  if (databaseUrl.startsWith("postgresql://") || databaseUrl.startsWith("postgres://")) {
    return createPostgresDatabase(databaseUrl);
  }
  return createSqliteDatabase(databaseUrl);
}

/**
 * Run the PostgreSQL schema creation via raw SQL.
 * Called once on first deployment, or use `drizzle-kit push` instead.
 */
export async function ensurePostgresTables(client: postgres.Sql, tenantId?: string): Promise<void> {
  // Use drizzle-kit push for production. This is a safety net.
  // Tables are defined in schema-pg.ts and managed by Drizzle migrations.
  console.log("[DB] PostgreSQL tables managed by drizzle-kit push");
}

// ── SQLite table creation (legacy) ──

function ensureSqliteTables(sqlite: Database): void {
  const tx = sqlite.transaction(() => {
    sqlite.run(`CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, data TEXT NOT NULL, game_version TEXT, fetched_at INTEGER NOT NULL
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS timed_cache (
      key TEXT PRIMARY KEY, data TEXT NOT NULL, fetched_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, bot_id TEXT NOT NULL,
      action TEXT NOT NULL, params TEXT, context TEXT NOT NULL, result TEXT, commander_goal TEXT,
      game_version TEXT NOT NULL, commander_version TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_decision_log_bot ON decision_log(bot_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_decision_log_tick ON decision_log(tick)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_decision_log_action ON decision_log(action)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, bot_id TEXT NOT NULL,
      player_state TEXT NOT NULL, ship_state TEXT NOT NULL, location TEXT NOT NULL,
      game_version TEXT NOT NULL, commander_version TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_snapshots_bot ON state_snapshots(bot_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_snapshots_tick ON state_snapshots(tick)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id TEXT NOT NULL, episode_type TEXT NOT NULL,
      start_tick INTEGER NOT NULL, end_tick INTEGER NOT NULL, duration_ticks INTEGER NOT NULL,
      start_credits INTEGER, end_credits INTEGER, profit INTEGER, route TEXT, items_involved TEXT,
      fuel_consumed INTEGER, risks TEXT, commander_goal TEXT, success INTEGER NOT NULL DEFAULT 1,
      game_version TEXT NOT NULL, commander_version TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_episodes_bot ON episodes(bot_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(episode_type)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS market_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, station_id TEXT NOT NULL,
      item_id TEXT NOT NULL, buy_price REAL, sell_price REAL, buy_volume INTEGER, sell_volume INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_market_station_item ON market_history(station_id, item_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_market_tick ON market_history(tick)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS commander_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, goal TEXT NOT NULL,
      fleet_state TEXT NOT NULL, assignments TEXT NOT NULL, reasoning TEXT NOT NULL, economy_state TEXT,
      game_version TEXT NOT NULL, commander_version TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_commander_tick ON commander_log(tick)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS bot_sessions (
      username TEXT PRIMARY KEY, password TEXT NOT NULL, empire TEXT, player_id TEXT,
      session_id TEXT, session_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS credit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
      total_credits INTEGER NOT NULL, active_bots INTEGER NOT NULL
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_credit_ts ON credit_history(timestamp)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, priority INTEGER NOT NULL,
      params TEXT NOT NULL DEFAULT '{}', constraints TEXT
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS bot_settings (
      username TEXT PRIMARY KEY, fuel_emergency_threshold REAL NOT NULL DEFAULT 20,
      auto_repair INTEGER NOT NULL DEFAULT 1, max_cargo_fill_pct REAL NOT NULL DEFAULT 90,
      storage_mode TEXT NOT NULL DEFAULT 'sell', faction_storage INTEGER NOT NULL DEFAULT 0,
      role TEXT, manual_control INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS financial_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, event_type TEXT NOT NULL,
      amount REAL NOT NULL, bot_id TEXT, source TEXT
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_financial_ts ON financial_events(timestamp)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_financial_type ON financial_events(event_type)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS trade_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, bot_id TEXT NOT NULL,
      action TEXT NOT NULL, item_id TEXT NOT NULL, quantity INTEGER NOT NULL,
      price_each REAL NOT NULL, total REAL NOT NULL, station_id TEXT
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_trade_ts ON trade_log(timestamp)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_trade_bot ON trade_log(bot_id)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS fleet_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, tick INTEGER NOT NULL, brain_name TEXT NOT NULL,
      latency_ms INTEGER NOT NULL, confidence REAL, token_usage INTEGER,
      fleet_input TEXT NOT NULL, assignments TEXT NOT NULL, reasoning TEXT,
      scoring_brain_assignments TEXT, agreement_rate REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_llm_tick ON llm_decisions(tick)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_llm_brain ON llm_decisions(brain_name)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS poi_cache (
      poi_id TEXT PRIMARY KEY, system_id TEXT NOT NULL, data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_poi_system ON poi_cache(system_id)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS faction_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, bot_id TEXT,
      type TEXT NOT NULL, item_id TEXT, item_name TEXT, quantity INTEGER, credits REAL, details TEXT
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_faction_tx_ts ON faction_transactions(timestamp)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_faction_tx_type ON faction_transactions(type)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL,
      level TEXT NOT NULL DEFAULT 'info', bot_id TEXT, message TEXT NOT NULL, details TEXT
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(timestamp)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_activity_bot ON activity_log(bot_id)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS commander_memory (
      key TEXT PRIMARY KEY, fact TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 5,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS bot_skills (
      username TEXT PRIMARY KEY, skills TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS bandit_weights (
      role TEXT PRIMARY KEY, weights TEXT NOT NULL, covariance TEXT NOT NULL,
      episode_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run(`CREATE TABLE IF NOT EXISTS bandit_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, routine TEXT NOT NULL,
      context TEXT NOT NULL, reward REAL NOT NULL, reward_breakdown TEXT NOT NULL DEFAULT '{}',
      duration_sec REAL NOT NULL, goal_type TEXT, bot_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_bandit_ep_role ON bandit_episodes(role)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_bandit_ep_routine ON bandit_episodes(routine)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_bandit_ep_created ON bandit_episodes(created_at)");
    sqlite.run(`CREATE TABLE IF NOT EXISTS outcome_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, embedding TEXT NOT NULL,
      category TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', profit_impact REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_embed_category ON outcome_embeddings(category)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_embed_created ON outcome_embeddings(created_at)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_embed_profit ON outcome_embeddings(profit_impact)");
  });
  tx();
}
