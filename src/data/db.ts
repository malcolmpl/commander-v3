/**
 * Database setup with Drizzle ORM.
 * Auto-creates tables on first run via push-based migration.
 */

import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type DB = ReturnType<typeof createDrizzle>;

function createDrizzle(sqlite: Database) {
  return drizzle(sqlite, { schema });
}

export function createDatabase(dbPath = "commander.db"): { db: DB; sqlite: Database } {
  const sqlite = new Database(dbPath, { create: true });

  // Performance pragmas
  sqlite.run("PRAGMA journal_mode = WAL");
  sqlite.run("PRAGMA synchronous = NORMAL");
  sqlite.run("PRAGMA cache_size = -64000"); // 64MB cache
  sqlite.run("PRAGMA busy_timeout = 5000");

  // Auto-create all tables from schema
  ensureTables(sqlite);

  const db = createDrizzle(sqlite);
  return { db, sqlite };
}

/**
 * Create tables if they don't exist.
 * Drizzle doesn't auto-create — we generate DDL from the schema definitions.
 */
function ensureTables(sqlite: Database): void {
  const tx = sqlite.transaction(() => {
    // Schema version
    sqlite.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);

    // Cache
    sqlite.run(`CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      game_version TEXT,
      fetched_at INTEGER NOT NULL
    )`);

    // Timed cache
    sqlite.run(`CREATE TABLE IF NOT EXISTS timed_cache (
      key TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      fetched_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL
    )`);

    // Decision log
    sqlite.run(`CREATE TABLE IF NOT EXISTS decision_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT,
      context TEXT NOT NULL,
      result TEXT,
      commander_goal TEXT,
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_decision_log_bot ON decision_log(bot_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_decision_log_tick ON decision_log(tick)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_decision_log_action ON decision_log(action)");

    // State snapshots
    sqlite.run(`CREATE TABLE IF NOT EXISTS state_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      player_state TEXT NOT NULL,
      ship_state TEXT NOT NULL,
      location TEXT NOT NULL,
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_snapshots_bot ON state_snapshots(bot_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_snapshots_tick ON state_snapshots(tick)");

    // Episodes
    sqlite.run(`CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      episode_type TEXT NOT NULL,
      start_tick INTEGER NOT NULL,
      end_tick INTEGER NOT NULL,
      duration_ticks INTEGER NOT NULL,
      start_credits INTEGER,
      end_credits INTEGER,
      profit INTEGER,
      route TEXT,
      items_involved TEXT,
      fuel_consumed INTEGER,
      risks TEXT,
      commander_goal TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_episodes_bot ON episodes(bot_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_episodes_type ON episodes(episode_type)");

    // Market history
    sqlite.run(`CREATE TABLE IF NOT EXISTS market_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      station_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      buy_price REAL,
      sell_price REAL,
      buy_volume INTEGER,
      sell_volume INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_market_station_item ON market_history(station_id, item_id)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_market_tick ON market_history(tick)");

    // Commander log
    sqlite.run(`CREATE TABLE IF NOT EXISTS commander_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      goal TEXT NOT NULL,
      fleet_state TEXT NOT NULL,
      assignments TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      economy_state TEXT,
      game_version TEXT NOT NULL,
      commander_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_commander_tick ON commander_log(tick)");

    // Bot sessions
    sqlite.run(`CREATE TABLE IF NOT EXISTS bot_sessions (
      username TEXT PRIMARY KEY,
      password TEXT NOT NULL,
      empire TEXT,
      player_id TEXT,
      session_id TEXT,
      session_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    // Credit history
    sqlite.run(`CREATE TABLE IF NOT EXISTS credit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      total_credits INTEGER NOT NULL,
      active_bots INTEGER NOT NULL
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_credit_ts ON credit_history(timestamp)");

    // Goals
    sqlite.run(`CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      priority INTEGER NOT NULL,
      params TEXT NOT NULL DEFAULT '{}',
      constraints TEXT
    )`);

    // Bot settings
    sqlite.run(`CREATE TABLE IF NOT EXISTS bot_settings (
      username TEXT PRIMARY KEY,
      fuel_emergency_threshold REAL NOT NULL DEFAULT 20,
      auto_repair INTEGER NOT NULL DEFAULT 1,
      max_cargo_fill_pct REAL NOT NULL DEFAULT 90,
      storage_mode TEXT NOT NULL DEFAULT 'sell',
      faction_storage INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    // Financial events
    sqlite.run(`CREATE TABLE IF NOT EXISTS financial_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      amount REAL NOT NULL,
      bot_id TEXT
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_financial_ts ON financial_events(timestamp)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_financial_type ON financial_events(event_type)");

    // Trade log
    sqlite.run(`CREATE TABLE IF NOT EXISTS trade_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      bot_id TEXT NOT NULL,
      action TEXT NOT NULL,
      item_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price_each REAL NOT NULL,
      total REAL NOT NULL,
      station_id TEXT
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_trade_ts ON trade_log(timestamp)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_trade_bot ON trade_log(bot_id)");

    // Fleet settings
    sqlite.run(`CREATE TABLE IF NOT EXISTS fleet_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    // LLM decisions (v3 new)
    sqlite.run(`CREATE TABLE IF NOT EXISTS llm_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      brain_name TEXT NOT NULL,
      latency_ms INTEGER NOT NULL,
      confidence REAL,
      token_usage INTEGER,
      fleet_input TEXT NOT NULL,
      assignments TEXT NOT NULL,
      reasoning TEXT,
      scoring_brain_assignments TEXT,
      agreement_rate REAL,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_llm_tick ON llm_decisions(tick)");
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_llm_brain ON llm_decisions(brain_name)");

    // System cache (persistent system details)
    sqlite.run(`CREATE TABLE IF NOT EXISTS system_cache (
      system_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);

    // POI cache
    sqlite.run(`CREATE TABLE IF NOT EXISTS poi_cache (
      poi_id TEXT PRIMARY KEY,
      system_id TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    sqlite.run("CREATE INDEX IF NOT EXISTS idx_poi_system ON poi_cache(system_id)");
  });

  tx();
}
