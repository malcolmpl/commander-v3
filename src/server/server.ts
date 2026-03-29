/**
 * Bun HTTP + WebSocket server — v3.
 * Serves the Svelte frontend and provides a WebSocket API for real-time dashboard updates.
 * JWT authentication on WebSocket upgrade and REST API routes.
 */

import type { ServerWebSocket } from "bun";
import type { ServerMessage, ClientMessage } from "../types/protocol";
import type { DB } from "../data/db";
import type { TrainingLogger } from "../data/training-logger";
import { gt, desc, sql, eq, and } from "drizzle-orm";
import { creditHistory, marketHistory, activityLog, commanderLog as commanderLogTable, factionTransactions, financialEvents, users } from "../data/schema";
import { verifyToken, extractToken, createToken, hashPassword, verifyPassword, type TokenPayload } from "../auth/jwt";

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
  tenantId?: string;
  trainingLogger?: TrainingLogger;
  /** If true, require JWT auth on WS and API (multi-tenant mode). If false, open access (legacy). */
  requireAuth?: boolean;
  /** Bot manager for public stats */
  botManager?: { getAllBots(): Array<{ username: string; status: string; routine: string | null; role?: string }> };
  /** Start time for uptime calculation */
  startTime?: number;
  onClientMessage?: (ws: ServerWebSocket<WsData>, msg: ClientMessage) => void;
  onClientConnect?: (ws: ServerWebSocket<WsData>) => void;
}

interface WsData {
  id: string;
  connectedAt: number;
  tenantId?: string;
  username?: string;
}

const clients = new Set<ServerWebSocket<WsData>>();

export function createServer(opts: ServerOptions) {
  const server = Bun.serve<WsData>({
    port: opts.port,
    hostname: opts.host,

    async fetch(req, server) {
      const url = new URL(req.url);

      // CORS preflight
      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
          },
        });
      }

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        let wsData: WsData = { id: crypto.randomUUID(), connectedAt: Date.now() };

        // Authenticate if auth is required
        if (opts.requireAuth) {
          const token = url.searchParams.get("token");
          if (!token) return new Response("Unauthorized: token required", { status: 401 });
          const payload = await verifyToken(token);
          if (!payload) return new Response("Unauthorized: invalid token", { status: 401 });
          wsData.tenantId = payload.tenantId ?? payload.sub;
          wsData.username = payload.username;
        }

        const upgraded = server.upgrade(req, { data: wsData });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        // Public endpoints (no auth required)
        if (url.pathname === "/api/health") {
          return Response.json({ status: "ok", clients: clients.size });
        }
        if (url.pathname === "/api/public/stats") {
          return handlePublicStats(opts);
        }
        if (url.pathname === "/api/public/learning") {
          return handlePublicLearning(opts);
        }

        // Auth endpoints are always public (login/register)
        if (url.pathname === "/api/login" && req.method === "POST") {
          return handleLogin(req, opts);
        }
        if (url.pathname === "/api/register" && req.method === "POST") {
          return handleRegister(req, opts);
        }

        // Authenticate all other REST API routes if required
        if (opts.requireAuth) {
          const authHeader = req.headers.get("Authorization");
          const token = extractToken(authHeader) ?? url.searchParams.get("token");
          if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
          const payload = await verifyToken(token);
          if (!payload) return Response.json({ error: "Invalid token" }, { status: 401 });
        }

        return handleApiRoute(url, opts);
      }

      // Static files with cache headers
      const filePath = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = Bun.file(`${opts.staticDir}${filePath}`);
      if (await file.exists()) {
        const isAsset = /\.(js|css|woff2?|png|svg|ico)$/.test(filePath);
        return new Response(file, {
          headers: {
            "Cache-Control": isAsset ? "public, max-age=86400, immutable" : "public, max-age=300",
          },
        });
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

// REST API routes — all queries are now async
async function handleApiRoute(url: URL, opts: ServerOptions): Promise<Response> {
  const path = url.pathname.replace("/api/", "");

  if (path === "health") {
    return Response.json({ status: "ok", clients: clients.size });
  }

  if (path === "credits" && opts.db) {
    return handleCreditsRoute(url, opts.db);
  }

  if (path === "training/shadow-stats" && opts.trainingLogger) {
    const stats = await opts.trainingLogger.getShadowStats();
    return Response.json(stats);
  }

  if (path === "training/stats" && opts.trainingLogger) {
    const stats = await opts.trainingLogger.getStats();
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

  if (path === "economy/bot-breakdown" && opts.db) {
    return handleBotBreakdownRoute(url, opts.db);
  }

  if (path === "economy/mining-rate" && opts.db) {
    return handleMiningRateRoute(url, opts.db);
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

/** GET /api/economy/history?range=1h|1d|1w|1m — bucketed revenue/cost/profit */
async function handleEconomyHistory(url: URL, logger: TrainingLogger): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const bucketMs = range === "1h" ? 60_000 : range === "1d" ? 300_000 : range === "1w" ? 3_600_000 : 21_600_000;
  const history = await logger.getFinancialHistory(ms, bucketMs);
  return Response.json(history);
}

/** GET /api/economy/trades?range=1d&limit=200 — recent buy/sell trades */
async function handleEconomyTrades(url: URL, logger: TrainingLogger): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100") || 100, 500);
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const trades = await logger.getRecentTrades(ms, limit);
  return Response.json(trades);
}

/** GET /api/economy/market — aggregated market price data from DB */
async function handleMarketData(url: URL, db: DB): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const since = Math.floor((Date.now() - ms) / 1000);

  const rows = await db.select().from(marketHistory)
    .where(gt(marketHistory.tick, since));

  // Group by station, keeping only latest price per item
  const stationMap = new Map<string, {
    stationId: string;
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
async function handleCreditsRoute(url: URL, db: DB): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1h";
  const ms = RANGE_MS[range] ?? RANGE_MS["1h"];
  const since = Date.now() - ms;

  const rows = await db.select().from(creditHistory)
    .where(gt(creditHistory.timestamp, since));

  return Response.json(
    rows.map(r => ({
      time: new Date(r.timestamp).toISOString(),
      credits: r.totalCredits,
      activeBots: r.activeBots,
    }))
  );
}

/** GET /api/logs?range=1h&limit=500 — persisted bot activity log */
async function handleLogsRoute(url: URL, db: DB): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1h";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "500") || 500, 2000);
  const ms = RANGE_MS[range] ?? RANGE_MS["1h"];
  const since = Date.now() - ms;

  const rows = await db.select().from(activityLog)
    .where(gt(activityLog.timestamp, since))
    .orderBy(desc(activityLog.timestamp))
    .limit(limit);

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
async function handleDecisionsRoute(url: URL, db: DB): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "100") || 100, 500);
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];

  const rows = await db.select().from(commanderLogTable)
    .where(gt(commanderLogTable.tick, Math.floor((Date.now() - ms) / 1000)))
    .orderBy(desc(commanderLogTable.tick))
    .limit(limit);

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

/** GET /api/faction/transactions?range=1d&limit=200 */
async function handleFactionTransactionsRoute(url: URL, db: DB): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "200") || 200, 1000);
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const since = Date.now() - ms;

  const rows = await db.select().from(factionTransactions)
    .where(gt(factionTransactions.timestamp, since))
    .orderBy(desc(factionTransactions.timestamp))
    .limit(limit);

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

/** GET /api/economy/bot-breakdown?range=1d — revenue/cost per bot */
async function handleBotBreakdownRoute(url: URL, db: DB): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const since = Date.now() - ms;

  const rows = await (db as any).execute(sql`
    SELECT
      ${financialEvents.botId} as bot_id,
      SUM(CASE WHEN ${financialEvents.eventType} = 'revenue' THEN ${financialEvents.amount} ELSE 0 END) as revenue,
      SUM(CASE WHEN ${financialEvents.eventType} = 'cost' THEN ${financialEvents.amount} ELSE 0 END) as cost
    FROM ${financialEvents}
    WHERE ${financialEvents.timestamp} >= ${since}
    GROUP BY ${financialEvents.botId}
    ORDER BY revenue DESC
  `) as Array<{ bot_id: string | null; revenue: number; cost: number }>;

  return Response.json(
    (rows ?? []).filter((r: any) => r.bot_id).map((r: any) => ({
      botId: r.bot_id,
      revenue: r.revenue ?? 0,
      cost: r.cost ?? 0,
    }))
  );
}

/** GET /api/economy/mining-rate?range=1d — ore mined per hour */
async function handleMiningRateRoute(url: URL, db: DB): Promise<Response> {
  const range = url.searchParams.get("range") ?? "1d";
  const ms = RANGE_MS[range] ?? RANGE_MS["1d"];
  const since = Date.now() - ms;

  const allRows = await db.select({
    timestamp: activityLog.timestamp,
    botId: activityLog.botId,
    message: activityLog.message,
  }).from(activityLog)
    .where(gt(activityLog.timestamp, since));

  const rows = allRows.filter(r => r.message?.includes("miner: mined") || r.message?.includes("harvester: harvested"));

  const bucketMs = 3_600_000;
  const buckets = new Map<number, { total: number; byBot: Record<string, number>; byOre: Record<string, number> }>();

  for (const r of rows) {
    const match = r.message?.match(/(?:mined|harvested)\s+(\d+)\s+(\S+)/);
    if (!match) continue;
    const qty = parseInt(match[1], 10);
    if (isNaN(qty)) continue;
    const oreType = match[2];

    const hour = Math.floor(r.timestamp / bucketMs) * bucketMs;
    let bucket = buckets.get(hour);
    if (!bucket) {
      bucket = { total: 0, byBot: {}, byOre: {} };
      buckets.set(hour, bucket);
    }
    bucket.total += qty;
    const botId = r.botId ?? "unknown";
    bucket.byBot[botId] = (bucket.byBot[botId] ?? 0) + qty;
    bucket.byOre[oreType] = (bucket.byOre[oreType] ?? 0) + qty;
  }

  const result = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, data]) => ({
      hour,
      total: data.total,
      byBot: data.byBot,
      byOre: data.byOre,
    }));

  return Response.json(result);
}

// ── Auth Endpoints ──

/** POST /api/register — create a new user account */
async function handleRegister(req: Request, opts: ServerOptions): Promise<Response> {
  try {
    const body = await req.json();
    const { username, email, password } = body;

    if (!username || !email || !password) {
      return Response.json({ error: "Username, email, and password are required" }, { status: 400 });
    }
    if (password.length < 8) {
      return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }

    const db = opts.db;
    if (!db) return Response.json({ error: "Database not available" }, { status: 500 });

    // Check if username or email exists
    const [existing] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (existing) {
      return Response.json({ error: "Username already taken" }, { status: 409 });
    }

    // Create user
    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    await db.insert(users).values({
      id: userId,
      username,
      email,
      passwordHash,
      role: "owner",
      tier: "free",
    });

    // Create JWT token
    const token = await createToken({
      sub: userId,
      username,
      role: "owner",
      tier: "free",
      tenantId: opts.tenantId,
    });

    return Response.json({
      message: "Account created",
      token,
      user: { id: userId, username, email, role: "owner", tier: "free" },
    });
  } catch (err: any) {
    console.error("[Auth] Register error:", err.message);
    return Response.json({ error: "Registration failed" }, { status: 500 });
  }
}

/** POST /api/login — authenticate and return JWT */
async function handleLogin(req: Request, opts: ServerOptions): Promise<Response> {
  try {
    const body = await req.json();
    const { username, password } = body;

    if (!username || !password) {
      return Response.json({ error: "Username and password are required" }, { status: 400 });
    }

    const db = opts.db;
    if (!db) return Response.json({ error: "Database not available" }, { status: 500 });

    // Find user
    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user) {
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Verify password
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }

    // Create JWT token
    const token = await createToken({
      sub: user.id,
      username: user.username,
      role: user.role,
      tier: user.tier,
      tenantId: opts.tenantId,
    });

    return Response.json({
      message: "Login successful",
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, tier: user.tier },
    });
  } catch (err: any) {
    console.error("[Auth] Login error:", err.message);
    return Response.json({ error: "Login failed" }, { status: 500 });
  }
}

/** GET /api/public/learning — bandit brain learning data for website display */
async function handlePublicLearning(opts: ServerOptions): Promise<Response> {
  const db = opts.db;
  if (!db) return Response.json({ error: "No database" }, { status: 500 });

  try {
    // 1. Per-role weights (summarized — average weight per routine per role)
    const weightsRows = await (db as any).execute(
      sql`SELECT role, weights, episode_count FROM bandit_weights`
    ) as Array<{ role: string; weights: string; episode_count: number }>;

    const roleWeights: Record<string, { routines: Record<string, number>; episodes: number }> = {};
    for (const row of weightsRows ?? []) {
      const parsed = typeof row.weights === "string" ? JSON.parse(row.weights) : row.weights;
      const routines: Record<string, number> = {};
      for (const [routine, weightArr] of Object.entries(parsed)) {
        const arr = weightArr as number[];
        routines[routine] = arr.length > 0 ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : 0;
      }
      roleWeights[row.role] = { routines, episodes: row.episode_count };
    }

    // 2. Recent episodes (last 50)
    const recentEpisodes = await (db as any).execute(
      sql`SELECT role, routine, reward, reward_breakdown, duration_sec, bot_id, created_at
          FROM bandit_episodes ORDER BY created_at DESC LIMIT 50`
    ) as Array<{ role: string; routine: string; reward: number; reward_breakdown: string; duration_sec: number; bot_id: string; created_at: string }>;

    // 3. Top performing combos (avg reward by role+routine, min 3 episodes)
    const topCombos = await (db as any).execute(
      sql`SELECT role, routine, COUNT(*) as episodes, ROUND(AVG(reward)::numeric, 2) as avg_reward,
              ROUND(MAX(reward)::numeric, 2) as max_reward, ROUND(MIN(reward)::numeric, 2) as min_reward
          FROM bandit_episodes GROUP BY role, routine HAVING COUNT(*) >= 3
          ORDER BY AVG(reward) DESC LIMIT 20`
    ) as Array<{ role: string; routine: string; episodes: number; avg_reward: number; max_reward: number; min_reward: number }>;

    // 4. Reward trend (hourly buckets, last 24h)
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    const sinceStr = new Date(since24h).toISOString();
    const rewardTrend = await (db as any).execute(
      sql`SELECT DATE_TRUNC('hour', created_at::timestamp) as hour,
              COUNT(*) as episodes, ROUND(AVG(reward)::numeric, 2) as avg_reward,
              ROUND(SUM(CASE WHEN reward > 0 THEN 1 ELSE 0 END)::numeric * 100 / COUNT(*), 1) as positive_pct
          FROM bandit_episodes WHERE created_at >= ${sinceStr}
          GROUP BY DATE_TRUNC('hour', created_at::timestamp)
          ORDER BY hour`
    ) as Array<{ hour: string; episodes: number; avg_reward: number; positive_pct: number }>;

    // 5. Total stats
    const [totalRow] = await (db as any).execute(
      sql`SELECT COUNT(*) as total, COUNT(DISTINCT role) as roles, COUNT(DISTINCT routine) as routines,
              ROUND(AVG(reward)::numeric, 2) as avg_reward
          FROM bandit_episodes`
    ) as Array<{ total: number; roles: number; routines: number; avg_reward: number }>;

    return new Response(JSON.stringify({
      roleWeights,
      recentEpisodes: (recentEpisodes ?? []).map(e => ({
        role: e.role, routine: e.routine, reward: +Number(e.reward).toFixed(2),
        breakdown: typeof e.reward_breakdown === "string" ? JSON.parse(e.reward_breakdown) : e.reward_breakdown,
        durationSec: +Number(e.duration_sec).toFixed(0), botId: e.bot_id, createdAt: e.created_at,
      })),
      topCombos: topCombos ?? [],
      rewardTrend: (rewardTrend ?? []).map(r => ({
        hour: r.hour, episodes: +r.episodes, avgReward: +r.avg_reward, positivePct: +r.positive_pct,
      })),
      totals: totalRow ? { episodes: +totalRow.total, roles: +totalRow.roles, routines: +totalRow.routines, avgReward: +totalRow.avg_reward } : null,
      timestamp: new Date().toISOString(),
    }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  } catch (err: any) {
    console.error("[Learning API]", err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/** GET /api/public/stats — public fleet statistics for website display */
async function handlePublicStats(opts: ServerOptions): Promise<Response> {
  const bots = opts.botManager?.getAllBots() ?? [];
  const totalBots = bots.length;
  const activeBots = bots.filter(b => b.status === "running" || b.status === "ready").length;
  const onlineBots = bots.filter(b => b.status === "running").length;

  // Count by role
  const byRole: Record<string, number> = {};
  for (const bot of bots) {
    const role = (bot as any).role ?? "unassigned";
    byRole[role] = (byRole[role] ?? 0) + 1;
  }

  // Count by routine (active assignments)
  const byRoutine: Record<string, number> = {};
  for (const bot of bots) {
    if (bot.routine) {
      byRoutine[bot.routine] = (byRoutine[bot.routine] ?? 0) + 1;
    }
  }

  // Users count (from DB)
  let registeredUsers = 0;
  if (opts.db) {
    try {
      const [row] = await (opts.db as any).execute(sql`SELECT COUNT(*) as count FROM users`);
      registeredUsers = Number(row?.count ?? 0);
    } catch { registeredUsers = 1; }
  }

  // 24h credits earned (from financial events)
  let credits24h = 0;
  if (opts.db) {
    try {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const [row] = await (opts.db as any).execute(
        sql`SELECT COALESCE(SUM(amount), 0) as total FROM financial_events WHERE event_type = 'revenue' AND timestamp >= ${since}`
      );
      credits24h = Math.round(Number(row?.total ?? 0));
    } catch { /* non-critical */ }
  }

  // Total credits across all bots
  let totalCredits = 0;
  for (const bot of bots) {
    totalCredits += (bot as any).credits ?? 0;
  }

  // Uptime
  const uptimeMs = opts.startTime ? Date.now() - opts.startTime : 0;
  const uptimeHours = Math.floor(uptimeMs / 3_600_000);
  const uptimeDays = Math.floor(uptimeHours / 24);

  return new Response(JSON.stringify({
    totalBots,
    activeBots,
    onlineBots,
    registeredUsers,
    byRole,
    byRoutine,
    credits24h,
    totalCredits,
    uptime: uptimeDays > 0 ? `${uptimeDays}d ${uptimeHours % 24}h` : `${uptimeHours}h`,
    dashboardClients: clients.size,
    timestamp: new Date().toISOString(),
  }), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
