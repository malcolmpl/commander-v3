/**
 * Tests for Drizzle data layer — all 17 tables.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../../src/data/db";
import { TrainingLogger } from "../../src/data/training-logger";
import { SessionStore } from "../../src/data/session-store";
import { RetentionManager } from "../../src/data/retention";
import {
  cache, timedCache, decisionLog, stateSnapshots, episodes,
  marketHistory, commanderLog, botSessions, creditHistory,
  goals, botSettings, financialEvents, tradeLog, fleetSettings,
  llmDecisions, systemCache, poiCache,
} from "../../src/data/schema";
import { eq } from "drizzle-orm";
import type { DB } from "../../src/data/db";

let db: DB;
let sqlite: Database;

beforeEach(() => {
  const result = createDatabase(":memory:");
  db = result.db;
  sqlite = result.sqlite;
});

afterEach(() => {
  sqlite.close();
});

describe("Schema — table creation", () => {
  test("all 17 tables exist", () => {
    const tables = sqlite.query(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("cache");
    expect(names).toContain("timed_cache");
    expect(names).toContain("decision_log");
    expect(names).toContain("state_snapshots");
    expect(names).toContain("episodes");
    expect(names).toContain("market_history");
    expect(names).toContain("commander_log");
    expect(names).toContain("bot_sessions");
    expect(names).toContain("credit_history");
    expect(names).toContain("goals");
    expect(names).toContain("bot_settings");
    expect(names).toContain("financial_events");
    expect(names).toContain("trade_log");
    expect(names).toContain("fleet_settings");
    expect(names).toContain("llm_decisions");
    expect(names).toContain("system_cache");
    expect(names).toContain("poi_cache");
  });
});

describe("Schema — cache table", () => {
  test("insert and query static cache", () => {
    db.insert(cache).values({ key: "test", data: '{"x":1}', gameVersion: "1.0", fetchedAt: Date.now() }).run();
    const row = db.select().from(cache).where(eq(cache.key, "test")).get();
    expect(row).toBeTruthy();
    expect(row!.data).toBe('{"x":1}');
    expect(row!.gameVersion).toBe("1.0");
  });

  test("upsert cache entry", () => {
    db.insert(cache).values({ key: "k", data: "old", fetchedAt: 1 }).run();
    db.insert(cache).values({ key: "k", data: "new", fetchedAt: 2 })
      .onConflictDoUpdate({ target: cache.key, set: { data: "new", fetchedAt: 2 } }).run();
    const row = db.select().from(cache).where(eq(cache.key, "k")).get();
    expect(row!.data).toBe("new");
  });
});

describe("Schema — timed cache", () => {
  test("insert and query timed cache", () => {
    db.insert(timedCache).values({ key: "market:st1", data: "[]", fetchedAt: Date.now(), ttlMs: 300000 }).run();
    const row = db.select().from(timedCache).where(eq(timedCache.key, "market:st1")).get();
    expect(row).toBeTruthy();
    expect(row!.ttlMs).toBe(300000);
  });
});

describe("Schema — decision_log", () => {
  test("insert and query decision", () => {
    db.insert(decisionLog).values({
      tick: 100, botId: "bot1", action: "mine", context: "{}", gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(decisionLog).where(eq(decisionLog.botId, "bot1")).all();
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe("mine");
  });
});

describe("Schema — state_snapshots", () => {
  test("insert snapshot", () => {
    db.insert(stateSnapshots).values({
      tick: 200, botId: "bot1", playerState: "{}", shipState: "{}", location: "{}",
      gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(stateSnapshots).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — episodes", () => {
  test("insert episode", () => {
    db.insert(episodes).values({
      botId: "bot1", episodeType: "mining", startTick: 100, endTick: 200,
      durationTicks: 100, profit: 500, success: 1,
      gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(episodes).where(eq(episodes.botId, "bot1")).all();
    expect(rows.length).toBe(1);
    expect(rows[0].profit).toBe(500);
  });
});

describe("Schema — market_history", () => {
  test("insert market price", () => {
    db.insert(marketHistory).values({
      tick: 300, stationId: "st1", itemId: "ore_iron", buyPrice: 10, sellPrice: 8,
    }).run();
    const rows = db.select().from(marketHistory).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — commander_log", () => {
  test("insert commander decision", () => {
    db.insert(commanderLog).values({
      tick: 400, goal: "maximize_income", fleetState: "{}", assignments: "[]",
      reasoning: "test", gameVersion: "1.0", commanderVersion: "3.0.0",
    }).run();
    const rows = db.select().from(commanderLog).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — bot_sessions", () => {
  test("insert and query bot session", () => {
    db.insert(botSessions).values({ username: "bot1", password: "pass1", empire: "solarian" }).run();
    const row = db.select().from(botSessions).where(eq(botSessions.username, "bot1")).get();
    expect(row).toBeTruthy();
    expect(row!.empire).toBe("solarian");
  });
});

describe("Schema — credit_history", () => {
  test("insert credit snapshot", () => {
    db.insert(creditHistory).values({ timestamp: Date.now(), totalCredits: 50000, activeBots: 5 }).run();
    const rows = db.select().from(creditHistory).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — goals", () => {
  test("insert and delete goal", () => {
    db.insert(goals).values({ type: "maximize_income", priority: 1 }).run();
    const rows = db.select().from(goals).all();
    expect(rows.length).toBe(1);
    db.delete(goals).where(eq(goals.id, rows[0].id)).run();
    expect(db.select().from(goals).all().length).toBe(0);
  });
});

describe("Schema — bot_settings", () => {
  test("insert bot settings with defaults", () => {
    db.insert(botSettings).values({ username: "bot1" }).run();
    const row = db.select().from(botSettings).where(eq(botSettings.username, "bot1")).get();
    expect(row!.fuelEmergencyThreshold).toBe(20);
    expect(row!.autoRepair).toBe(1);
    expect(row!.storageMode).toBe("sell");
  });
});

describe("Schema — financial_events", () => {
  test("insert financial event", () => {
    db.insert(financialEvents).values({ timestamp: Date.now(), eventType: "revenue", amount: 1000, botId: "bot1" }).run();
    const rows = db.select().from(financialEvents).all();
    expect(rows.length).toBe(1);
    expect(rows[0].amount).toBe(1000);
  });
});

describe("Schema — trade_log", () => {
  test("insert trade", () => {
    db.insert(tradeLog).values({
      timestamp: Date.now(), botId: "bot1", action: "sell", itemId: "ore_iron",
      quantity: 10, priceEach: 5, total: 50,
    }).run();
    const rows = db.select().from(tradeLog).all();
    expect(rows.length).toBe(1);
  });
});

describe("Schema — fleet_settings", () => {
  test("insert and update fleet setting", () => {
    db.insert(fleetSettings).values({ key: "home_system", value: "sol" }).run();
    db.insert(fleetSettings).values({ key: "home_system", value: "nova" })
      .onConflictDoUpdate({ target: fleetSettings.key, set: { value: "nova" } }).run();
    const row = db.select().from(fleetSettings).where(eq(fleetSettings.key, "home_system")).get();
    expect(row!.value).toBe("nova");
  });
});

describe("Schema — llm_decisions (v3 new)", () => {
  test("insert LLM decision", () => {
    db.insert(llmDecisions).values({
      tick: 500, brainName: "ollama", latencyMs: 5000, confidence: 0.85,
      tokenUsage: 1200, fleetInput: "{}", assignments: "[]",
      reasoning: "Selected miners for income goal",
    }).run();
    const rows = db.select().from(llmDecisions).all();
    expect(rows.length).toBe(1);
    expect(rows[0].brainName).toBe("ollama");
    expect(rows[0].confidence).toBe(0.85);
  });
});

describe("Schema — system_cache", () => {
  test("insert and query system cache", () => {
    db.insert(systemCache).values({ systemId: "sol", data: '{"name":"Sol"}' }).run();
    const row = db.select().from(systemCache).where(eq(systemCache.systemId, "sol")).get();
    expect(row!.data).toBe('{"name":"Sol"}');
  });
});

describe("Schema — poi_cache", () => {
  test("insert POI cache entry", () => {
    db.insert(poiCache).values({ poiId: "poi1", systemId: "sol", data: '{"type":"belt"}' }).run();
    const rows = db.select().from(poiCache).all();
    expect(rows.length).toBe(1);
    expect(rows[0].systemId).toBe("sol");
  });
});

// ── SessionStore tests ──

describe("SessionStore", () => {
  test("listBots returns all registered bots", () => {
    const store = new SessionStore(db);
    store.upsertBot({ username: "a", password: "p1", empire: "solarian", playerId: null });
    store.upsertBot({ username: "b", password: "p2", empire: "crimson", playerId: null });
    const bots = store.listBots();
    expect(bots.length).toBe(2);
  });

  test("getBot returns null for unknown bot", () => {
    const store = new SessionStore(db);
    expect(store.getBot("nonexistent")).toBeNull();
  });

  test("updateSession and clearSession", () => {
    const store = new SessionStore(db);
    store.upsertBot({ username: "x", password: "p", empire: null, playerId: null });
    store.updateSession("x", "sess123", "2030-01-01T00:00:00Z");
    expect(store.getBot("x")!.sessionId).toBe("sess123");
    expect(store.isSessionValid("x")).toBe(true);
    store.clearSession("x");
    expect(store.getBot("x")!.sessionId).toBeNull();
  });

  test("removeBot", () => {
    const store = new SessionStore(db);
    store.upsertBot({ username: "del", password: "p", empire: null, playerId: null });
    expect(store.removeBot("del")).toBe(true);
    expect(store.removeBot("del")).toBe(false);
  });
});

// ── TrainingLogger tests ──

describe("TrainingLogger", () => {
  test("logDecision inserts into decision_log", () => {
    const logger = new TrainingLogger(db);
    logger.setGameVersion("1.0");
    logger.logDecision({
      tick: 1, botId: "bot1", action: "mine",
      context: { fuel: 80 },
    });
    const rows = db.select().from(decisionLog).all();
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe("mine");
  });

  test("logEpisode inserts into episodes", () => {
    const logger = new TrainingLogger(db);
    logger.setGameVersion("1.0");
    logger.logEpisode({
      botId: "bot1", episodeType: "mining",
      startTick: 1, endTick: 10,
      startCredits: 100, endCredits: 200,
      route: ["sol", "alpha"], itemsInvolved: { ore_iron: 10 },
      fuelConsumed: 5, risks: [], success: true,
    });
    const rows = db.select().from(episodes).all();
    expect(rows.length).toBe(1);
    expect(rows[0].profit).toBe(100);
  });

  test("logMarketPrices inserts batch", () => {
    const logger = new TrainingLogger(db);
    logger.setGameVersion("1.0");
    logger.logMarketPrices(10, "station1", [
      { itemId: "ore_iron", buyPrice: 10, sellPrice: 8, buyVolume: 100, sellVolume: 50 },
      { itemId: "ore_copper", buyPrice: 15, sellPrice: 12, buyVolume: 80, sellVolume: 30 },
    ]);
    const rows = db.select().from(marketHistory).all();
    expect(rows.length).toBe(2);
  });

  test("logFinancialEvent ignores zero/negative", () => {
    const logger = new TrainingLogger(db);
    logger.logFinancialEvent("revenue", 0);
    logger.logFinancialEvent("cost", -5);
    logger.logFinancialEvent("revenue", 100, "bot1");
    const rows = db.select().from(financialEvents).all();
    expect(rows.length).toBe(1);
  });

  test("logTrade inserts into trade_log", () => {
    const logger = new TrainingLogger(db);
    logger.logTrade({
      botId: "bot1", action: "sell", itemId: "refined_steel",
      quantity: 5, priceEach: 100, total: 500, stationId: "st1",
    });
    const rows = db.select().from(tradeLog).all();
    expect(rows.length).toBe(1);
    expect(rows[0].total).toBe(500);
  });

  test("flushSnapshots writes buffered data", () => {
    const logger = new TrainingLogger(db);
    logger.setGameVersion("1.0");
    logger.logSnapshot({ tick: 1, botId: "b1", playerState: {}, shipState: {}, location: {} });
    logger.logSnapshot({ tick: 2, botId: "b2", playerState: {}, shipState: {}, location: {} });
    expect(db.select().from(stateSnapshots).all().length).toBe(0); // still buffered
    logger.flushSnapshots();
    expect(db.select().from(stateSnapshots).all().length).toBe(2);
  });

  test("getStats returns counts", () => {
    const logger = new TrainingLogger(db);
    logger.setGameVersion("1.0");
    logger.logDecision({ tick: 1, botId: "b", action: "x", context: {} });
    logger.logDecision({ tick: 2, botId: "b", action: "y", context: {} });
    const stats = logger.getStats();
    expect(stats.decisions).toBe(2);
    expect(stats.snapshots).toBe(0);
  });
});

// ── RetentionManager tests ──

describe("RetentionManager", () => {
  test("run returns zero deletions on empty DB", () => {
    const retention = new RetentionManager(db, sqlite);
    const result = retention.run();
    expect(result.decisionLogDeleted).toBe(0);
    expect(result.snapshotsDeleted).toBe(0);
    expect(result.marketHistoryDeleted).toBe(0);
    expect(result.commanderLogDeleted).toBe(0);
  });

  test("getDataRange returns correct bounds", () => {
    const logger = new TrainingLogger(db);
    logger.setGameVersion("1.0");
    logger.logDecision({ tick: 1, botId: "b", action: "a", context: {} });
    logger.logDecision({ tick: 2, botId: "b", action: "b", context: {} });
    const retention = new RetentionManager(db, sqlite);
    const range = retention.getDataRange("decision_log");
    expect(range.count).toBe(2);
    expect(range.oldest).toBeTruthy();
    expect(range.newest).toBeTruthy();
  });
});
