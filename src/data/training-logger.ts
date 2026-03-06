/**
 * Training data logger — Drizzle ORM version.
 * Records decisions, snapshots, episodes, market prices, commander decisions.
 */

import { eq, sql, gte, desc } from "drizzle-orm";
import type { DB } from "./db";
import {
  decisionLog, stateSnapshots, episodes, marketHistory,
  commanderLog, financialEvents, tradeLog,
} from "./schema";

const COMMANDER_VERSION = "3.0.0";

export class TrainingLogger {
  private gameVersion: string = "unknown";
  private enabled = {
    decisions: true,
    snapshots: true,
    episodes: true,
    marketHistory: true,
  };

  private snapshotBuffer: Array<{
    tick: number; botId: string;
    playerState: Record<string, unknown>;
    shipState: Record<string, unknown>;
    location: Record<string, unknown>;
  }> = [];
  private snapshotFlushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private db: DB) {}

  startSnapshotFlush(): void {
    if (this.snapshotFlushTimer) return;
    this.snapshotFlushTimer = setInterval(() => this.flushSnapshots(), 10_000);
  }

  flushSnapshots(): void {
    if (this.snapshotBuffer.length === 0) return;
    const batch = this.snapshotBuffer;
    this.snapshotBuffer = [];
    for (const s of batch) {
      this.db.insert(stateSnapshots).values({
        tick: s.tick,
        botId: s.botId,
        playerState: JSON.stringify(s.playerState),
        shipState: JSON.stringify(s.shipState),
        location: JSON.stringify(s.location),
        gameVersion: this.gameVersion,
        commanderVersion: COMMANDER_VERSION,
      }).run();
    }
  }

  destroy(): void {
    if (this.snapshotFlushTimer) {
      clearInterval(this.snapshotFlushTimer);
      this.snapshotFlushTimer = null;
    }
    this.flushSnapshots();
  }

  setGameVersion(version: string): void { this.gameVersion = version; }

  configure(opts: Partial<typeof this.enabled>): void {
    Object.assign(this.enabled, opts);
  }

  logDecision(params: {
    tick: number; botId: string; action: string;
    actionParams?: Record<string, unknown>;
    context: Record<string, unknown>;
    result?: Record<string, unknown>;
    commanderGoal?: string;
  }): void {
    if (!this.enabled.decisions) return;
    this.db.insert(decisionLog).values({
      tick: params.tick,
      botId: params.botId,
      action: params.action,
      params: params.actionParams ? JSON.stringify(params.actionParams) : null,
      context: JSON.stringify(params.context),
      result: params.result ? JSON.stringify(params.result) : null,
      commanderGoal: params.commanderGoal ?? null,
      gameVersion: this.gameVersion,
      commanderVersion: COMMANDER_VERSION,
    }).run();
  }

  logSnapshot(params: {
    tick: number; botId: string;
    playerState: Record<string, unknown>;
    shipState: Record<string, unknown>;
    location: Record<string, unknown>;
  }): void {
    if (!this.enabled.snapshots) return;
    this.snapshotBuffer.push(params);
  }

  logEpisode(params: {
    botId: string; episodeType: string;
    startTick: number; endTick: number;
    startCredits: number; endCredits: number;
    route: string[]; itemsInvolved: Record<string, number>;
    fuelConsumed: number; risks: string[];
    commanderGoal?: string; success: boolean;
  }): void {
    if (!this.enabled.episodes) return;
    this.db.insert(episodes).values({
      botId: params.botId,
      episodeType: params.episodeType,
      startTick: params.startTick,
      endTick: params.endTick,
      durationTicks: params.endTick - params.startTick,
      startCredits: params.startCredits,
      endCredits: params.endCredits,
      profit: params.endCredits - params.startCredits,
      route: JSON.stringify(params.route),
      itemsInvolved: JSON.stringify(params.itemsInvolved),
      fuelConsumed: params.fuelConsumed,
      risks: JSON.stringify(params.risks),
      commanderGoal: params.commanderGoal ?? null,
      success: params.success ? 1 : 0,
      gameVersion: this.gameVersion,
      commanderVersion: COMMANDER_VERSION,
    }).run();
  }

  logMarketPrices(
    tick: number, stationId: string,
    prices: Array<{
      itemId: string; buyPrice: number | null; sellPrice: number | null;
      buyVolume: number; sellVolume: number;
    }>
  ): void {
    if (!this.enabled.marketHistory) return;
    for (const p of prices) {
      this.db.insert(marketHistory).values({
        tick, stationId, itemId: p.itemId,
        buyPrice: p.buyPrice, sellPrice: p.sellPrice,
        buyVolume: p.buyVolume, sellVolume: p.sellVolume,
      }).run();
    }
  }

  logCommanderDecision(params: {
    tick: number; goal: string;
    fleetState: Record<string, unknown>;
    assignments: Record<string, unknown>[];
    reasoning: string;
    economyState?: Record<string, unknown>;
  }): void {
    this.db.insert(commanderLog).values({
      tick: params.tick,
      goal: params.goal,
      fleetState: JSON.stringify(params.fleetState),
      assignments: JSON.stringify(params.assignments),
      reasoning: params.reasoning,
      economyState: params.economyState ? JSON.stringify(params.economyState) : null,
      gameVersion: this.gameVersion,
      commanderVersion: COMMANDER_VERSION,
    }).run();
  }

  logShipUpgrade(botId: string, fromShip: string, toShip: string, cost: number, role: string): void {
    this.logCommanderDecision({
      tick: Math.floor(Date.now() / 1000),
      goal: "ship_upgrade",
      fleetState: { botId, fromShip, toShip, cost, role },
      assignments: [{ botId, routine: "ship_upgrade", fromShip, toShip, cost }],
      reasoning: `Upgraded ${botId}: ${fromShip} → ${toShip} for ${cost}cr (role: ${role})`,
    });
  }

  logFinancialEvent(type: "revenue" | "cost", amount: number, botId?: string): void {
    if (amount <= 0) return;
    this.db.insert(financialEvents).values({
      timestamp: Date.now(), eventType: type, amount, botId: botId ?? null,
    }).run();
  }

  getFinancialHistory(sinceMs: number, bucketMs: number): Array<{
    timestamp: number; revenue: number; cost: number; profit: number;
  }> {
    const since = Date.now() - sinceMs;
    // Fall back to raw SQL for the bucket aggregation — Drizzle doesn't support this well
    const rows = this.db.all(sql`
      SELECT
        (${financialEvents.timestamp} / ${bucketMs} * ${bucketMs}) as bucket,
        SUM(CASE WHEN ${financialEvents.eventType} = 'revenue' THEN ${financialEvents.amount} ELSE 0 END) as revenue,
        SUM(CASE WHEN ${financialEvents.eventType} = 'cost' THEN ${financialEvents.amount} ELSE 0 END) as cost
      FROM ${financialEvents}
      WHERE ${financialEvents.timestamp} >= ${since}
      GROUP BY bucket ORDER BY bucket ASC
    `) as Array<{ bucket: number; revenue: number; cost: number }>;

    return rows.map((r) => ({
      timestamp: r.bucket, revenue: r.revenue, cost: r.cost,
      profit: r.revenue - r.cost,
    }));
  }

  logTrade(params: {
    botId: string; action: "buy" | "sell"; itemId: string;
    quantity: number; priceEach: number; total: number; stationId?: string;
  }): void {
    this.db.insert(tradeLog).values({
      timestamp: Date.now(), botId: params.botId, action: params.action,
      itemId: params.itemId, quantity: params.quantity, priceEach: params.priceEach,
      total: params.total, stationId: params.stationId ?? null,
    }).run();
  }

  getRecentTrades(sinceMs: number, limit = 100): Array<{
    timestamp: number; botId: string; action: string; itemId: string;
    quantity: number; priceEach: number; total: number; stationId: string | null;
  }> {
    const since = Date.now() - sinceMs;
    return this.db.select().from(tradeLog)
      .where(gte(tradeLog.timestamp, since))
      .orderBy(desc(tradeLog.timestamp))
      .limit(limit)
      .all()
      .map((r) => ({
        timestamp: r.timestamp, botId: r.botId, action: r.action,
        itemId: r.itemId, quantity: r.quantity, priceEach: r.priceEach,
        total: r.total, stationId: r.stationId,
      }));
  }

  getStats(): {
    decisions: number; snapshots: number; episodes: number;
    marketRecords: number; commanderDecisions: number; dbSizeBytes: number;
  } {
    const count = (table: Parameters<typeof this.db.select>[0] extends undefined ? never : never) => 0;
    // Use raw SQL for efficient COUNT(*)
    const decisions = (this.db.all(sql`SELECT COUNT(*) as count FROM ${decisionLog}`) as Array<{ count: number }>)[0]?.count ?? 0;
    const snapshots = (this.db.all(sql`SELECT COUNT(*) as count FROM ${stateSnapshots}`) as Array<{ count: number }>)[0]?.count ?? 0;
    const episodeCount = (this.db.all(sql`SELECT COUNT(*) as count FROM ${episodes}`) as Array<{ count: number }>)[0]?.count ?? 0;
    const marketRecords = (this.db.all(sql`SELECT COUNT(*) as count FROM ${marketHistory}`) as Array<{ count: number }>)[0]?.count ?? 0;
    const commanderDecisions = (this.db.all(sql`SELECT COUNT(*) as count FROM ${commanderLog}`) as Array<{ count: number }>)[0]?.count ?? 0;

    const file = Bun.file("commander.db");
    const dbSizeBytes = file.size;

    return { decisions, snapshots, episodes: episodeCount, marketRecords, commanderDecisions, dbSizeBytes };
  }
}
