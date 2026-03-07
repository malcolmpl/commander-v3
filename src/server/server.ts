/**
 * Bun HTTP + WebSocket server — v3.
 * Serves the Svelte frontend and provides a WebSocket API for real-time dashboard updates.
 */

import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientMessage } from "../types/protocol";
import type { DB } from "../data/db";
import type { TrainingLogger } from "../data/training-logger";
import { gt, desc } from "drizzle-orm";
import { creditHistory, marketHistory, activityLog, commanderLog as commanderLogTable, factionTransactions } from "../data/schema";

const RANGE_MS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  "all": 365 * 24 * 60 * 60 * 1000,
};

export interface ServerOptions {
  port: number;
  host: string;
  staticDir: string;
  db?: DB;
  trainingLogger?: TrainingLogger;
  onClientMessage?: (ws: ServerWebSocket<WsData>, msg: ClientMessage) => void;
  onClientConnect?: (ws: ServerWebSocket<WsData>) => void;
}

interface WsData {
  id: string;
  connectedAt: number;
}

const clients = new Set<ServerWebSocket<WsData>>();

export function createServer(opts: ServerOptions) {
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.host,

    async fetch(req, server) {
      const url = new URL(req.url);

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        const upgraded = server.upgrade(req, {
          data: { id: crypto.randomUUID(), connectedAt: Date.now() },
        });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        return handleApiRoute(url, opts);
      }

      // Static files
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${opts.staticDir}${filePath}`);
      if (await file.exists()) {
        return new Response(file);
      }

      // SPA fallback
      const indexFile = Bun.file(`${opts.staticDir}/index.html`);
      if (await indexFile.exists()) {
        return new Response(indexFile, {
          headers: { "Content-Type": "text/html;charset=utf-8" },
        });
      }

      return new Response("Not Found", { status: 404 });
    },

    websocket: {
      open(ws) {
        clients.add(ws);
        const msg: ServerMessage = { type: "connected", version: "3.0.0" };
        ws.send(JSON.stringify(msg));
        opts.onClientConnect?.(ws);
        console.log(`[WS] Client connected (${clients.size} total)`);
      },

      message(ws, message) {
        try {
          const msg = JSON.parse(String(message)) as ClientMessage;
          opts.onClientMessage?.(ws, msg);
        } catch {
          console.error("[WS] Invalid message:", String(message).slice(0, 100));
        }
      },

      close(ws) {
        clients.delete(ws);
        console.log(`[WS] Client disconnected (${clients.size} total)`);
      },
    },
  });

  console.log(`[Server] Running at http://${opts.host}:${opts.port}`);
  return server;
}

/** Broadcast a message to all connected dashboard clients */
export function broadcast(msg: ServerMessage): void {
  if (clients.size === 0) return;
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    ws.send(data);
  }
}

/** Send a message to a specific client */
export function sendTo(ws: ServerWebSocket<WsData>, msg: ServerMessage): void {
  ws.send(JSON.stringify(msg));
}

/** Get count of connected clients */
export function getClientCount(): number {
  return clients.size;
}

// REST API routes
async function handleApiRoute(url: URL, opts: ServerOptions): Promise<Response> {
  const path = url.pathname.replace("/api/", "");

  if (path === "health") {
    return Response.json({ status: "ok", clients: clients.size });
  }

  if (path === "credits" && opts.db) {
    return handleCreditsRoute(url, opts.db);
  }

  if (path === "training/shadow-stats" && opts.trainingLogger) {
    const stats = opts.trainingLogger.getShadowStats();
    return Response.json(stats);
  }

  if (path === "training/stats" && opts.trainingLogger) {
    const stats = opts.trainingLogger.getStats();
    return Response.json({
      decisions: { count: stats.decisions, byAction: {}, byBot: {} },
      snapshots: { count: stats.snapshots },
      episodes: { count: stats.episodes, byType: {}, successRate: 0, avgDurationTicks: 0, totalProfit: 0 },
      marketHistory: { count: stats.marketRecords, stationsTracked: 0, itemsTracked: 0 },
      commanderLog: { count: stats.commanderDecisions, goalDistribution: {} },
      database: { sizeBytes: stats.dbSizeBytes, sizeMB: +(stats.dbSizeBytes / 1048576).toFixed(2) },
    });
  }

  if (path === "economy/history" && opts.trainingLogger) {
    return handleEconomyHistory(url, opts.trainingLogger);
  }

  if (path === "economy/trades" && opts.trainingLogger) {
    return handleEconomyTrades(url, opts.trainingLogger);
  }

  if (path === "economy/market" && opts.db) {
    return handleMarketData(url, opts.db);
  }

  if (path === "logs" && opts.db) {
    return handleLogsRoute(url, opts.db);
  }

  if (path === "decisions" && opts.db) {
    return handleDecisionsRoute(url, opts.db);
  }

  if (path === "faction/transactions" && opts.db) {
    return handleFactionTransactionsRoute(url, opts.db);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

/** GET /api/economy/history?range=1h|1d|1w|1m — bucketed revenue/cost/profit */
function handleEconomyHistory(url: URL, logger: TrainingLogger): Response {
  const range = url.searchParams.get("range") ?? "1d";
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  // Bucket size: 1min for 1h, 5min for 1d, 1hr for 1w, 6hr for 1m
  const bucketMs = range === "1h" ? 60_000 : range === "1d" ? 300_000 : range === "1w" ? 3_600_000 : 21_600_000;
  const history = logger.getFinancialHistory(ms, bucketMs);
  return Response.json(history);
}

/** GET /api/economy/trades?range=1d&limit=200 — recent buy/sell trades */
function handleEconomyTrades(url: URL, logger: TrainingLogger): Response {
  const range = url.searchParams.get("range") ?? "1d";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100") || 100, 500);
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const trades = logger.getRecentTrades(ms, limit);
  return Response.json(trades);
}

/** GET /api/economy/market — aggregated market price data from DB */
function handleMarketData(url: URL, db: DB): Response {
  const range = url.searchParams.get("range") ?? "1d";
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  // tick is stored as Unix timestamp in seconds, not milliseconds
  const since = Math.floor((Date.now() - ms) / 1000);

  const rows = db.select().from(marketHistory)
    .where(gt(marketHistory.tick, since))
    .all();

  // Group by station, keeping only latest price per item
  const stationMap = new Map<string, {
    stationId: string;
    /** Map<itemId, price> — keeps latest (highest tick) per item */
    priceMap: Map<string, { itemId: string; itemName: string; buyPrice: number; sellPrice: number; buyVolume: number; sellVolume: number; tick: number }>;
    fetchedAt: number;
  }>();

  for (const r of rows) {
    let station = stationMap.get(r.stationId);
    if (!station) {
      station = { stationId: r.stationId, priceMap: new Map(), fetchedAt: (r.tick ?? 0) * 1000 };
      stationMap.set(r.stationId, station);
    }
    if ((r.tick ?? 0) * 1000 > station.fetchedAt) station.fetchedAt = (r.tick ?? 0) * 1000;

    const existing = station.priceMap.get(r.itemId);
    if (!existing || (r.tick ?? 0) > existing.tick) {
      station.priceMap.set(r.itemId, {
        itemId: r.itemId,
        itemName: r.itemId.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()),
        buyPrice: r.buyPrice ?? 0,
        sellPrice: r.sellPrice ?? 0,
        buyVolume: r.buyVolume ?? 0,
        sellVolume: r.sellVolume ?? 0,
        tick: r.tick ?? 0,
      });
    }
  }

  return Response.json([...stationMap.values()].map(s => ({
    stationId: s.stationId,
    stationName: s.stationId,
    prices: [...s.priceMap.values()].map(({ tick: _, ...p }) => p),
    fetchedAt: s.fetchedAt,
  })));
}

/** GET /api/credits?range=1h|1d|1w|1m */
function handleCreditsRoute(url: URL, db: DB): Response {
  const range = url.searchParams.get("range") ?? "1h";
  const ms = RANGE_MS[range] ?? RANGE_MS["1h"];
  const since = Date.now() - ms;

  const rows = db.select().from(creditHistory)
    .where(gt(creditHistory.timestamp, since))
    .all();

  return Response.json(
    rows.map(r => ({
      time: new Date(r.timestamp).toISOString(),
      credits: r.totalCredits,
      activeBots: r.activeBots,
    }))
  );
}

/** GET /api/logs?range=1h&limit=500 — persisted bot activity log */
function handleLogsRoute(url: URL, db: DB): Response {
  const range = url.searchParams.get("range") ?? "1h";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "500") || 500, 2000);
  const ms = RANGE_MS[range] ?? RANGE_MS["1h"];
  const since = Date.now() - ms;

  const rows = db.select().from(activityLog)
    .where(gt(activityLog.timestamp, since))
    .orderBy(desc(activityLog.timestamp))
    .limit(limit)
    .all();

  return Response.json(
    rows.map(r => ({
      timestamp: new Date(r.timestamp).toISOString(),
      level: r.level,
      botId: r.botId,
      message: r.message,
      details: r.details ? JSON.parse(r.details) : undefined,
    }))
  );
}

/** GET /api/decisions?range=1h&limit=100 — persisted commander decisions */
function handleDecisionsRoute(url: URL, db: DB): Response {
  const range = url.searchParams.get("range") ?? "1d";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100") || 100, 500);
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];

  const rows = db.select().from(commanderLogTable)
    .where(gt(commanderLogTable.tick, Math.floor((Date.now() - ms) / 1000)))
    .orderBy(desc(commanderLogTable.tick))
    .limit(limit)
    .all();

  return Response.json(
    rows.map(r => ({
      tick: r.tick,
      goal: r.goal,
      assignments: JSON.parse(r.assignments),
      reasoning: r.reasoning,
      thoughts: [],
      timestamp: r.createdAt ?? new Date().toISOString(),
    }))
  );
}

/** GET /api/faction/transactions?range=1d&limit=200 — faction storage + credit transactions */
function handleFactionTransactionsRoute(url: URL, db: DB): Response {
  const range = url.searchParams.get("range") ?? "1d";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200") || 200, 1000);
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const since = Date.now() - ms;

  const rows = db.select().from(factionTransactions)
    .where(gt(factionTransactions.timestamp, since))
    .orderBy(desc(factionTransactions.timestamp))
    .limit(limit)
    .all();

  return Response.json(
    rows.map(r => ({
      timestamp: r.timestamp,
      botId: r.botId,
      type: r.type,
      itemId: r.itemId,
      itemName: r.itemName,
      quantity: r.quantity,
      credits: r.credits,
      details: r.details,
    }))
  );
}
