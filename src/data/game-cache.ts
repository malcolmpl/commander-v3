/**
 * Game data cache with version-gated static data and TTL-based timed data.
 * Refactored from v2 to use Drizzle ORM.
 */

import { eq, and, like, sql, gt } from "drizzle-orm";
import type { DB } from "./db";
import type { TrainingLogger } from "./training-logger";
import type { ApiClient, MarketInsight } from "../core/api-client";
import { normalizeRecipe, normalizeCatalogItem, normalizeShipClass } from "../core/api-client";
import { cache, timedCache, marketHistory } from "./schema";
import type { StarSystem, CatalogItem, ShipClass, Skill, Recipe, MarketPrice } from "../types/game";

export interface MarketFreshness {
  stationId: string;
  fetchedAt: number;
  ageMs: number;
  fresh: boolean;
}

export class GameCache {
  private gameVersion: string = "unknown";
  private marketFetchedAt = new Map<string, number>();
  private insightFetchedAt = new Map<string, number>();
  marketDirty = false;

  constructor(
    private db: DB,
    private logger: TrainingLogger,
  ) {}

  async initialize(api: ApiClient): Promise<void> {
    const { version } = await api.getVersion();
    this.gameVersion = version;
    this.logger.setGameVersion(version);
    console.log(`[Cache] Game version: ${version}`);
  }

  get version(): string {
    return this.gameVersion;
  }

  // ── Static Cache Helpers ──

  private getStatic(key: string, gameVersion?: string): string | null {
    const row = gameVersion
      ? this.db.select({ data: cache.data }).from(cache)
          .where(and(eq(cache.key, key), eq(cache.gameVersion, gameVersion))).get()
      : this.db.select({ data: cache.data }).from(cache)
          .where(eq(cache.key, key)).get();
    return row?.data ?? null;
  }

  private setStatic(key: string, data: string, gameVersion: string): void {
    this.db.insert(cache).values({ key, data, gameVersion, fetchedAt: Date.now() })
      .onConflictDoUpdate({ target: cache.key, set: { data, gameVersion, fetchedAt: Date.now() } })
      .run();
  }

  private deleteStatic(key: string): void {
    this.db.delete(cache).where(eq(cache.key, key)).run();
  }

  private getAllByPrefix(prefix: string): Array<{ key: string; data: string }> {
    return this.db.select({ key: cache.key, data: cache.data }).from(cache)
      .where(like(cache.key, `${prefix}%`)).all();
  }

  // ── Timed Cache Helpers ──

  private getTimed(key: string): string | null {
    const row = this.db.select().from(timedCache).where(eq(timedCache.key, key)).get();
    if (!row) return null;
    if (Date.now() - row.fetchedAt > row.ttlMs) return null;
    return row.data;
  }

  private setTimed(key: string, data: string, ttlMs: number): void {
    this.db.insert(timedCache).values({ key, data, fetchedAt: Date.now(), ttlMs })
      .onConflictDoUpdate({ target: timedCache.key, set: { data, fetchedAt: Date.now(), ttlMs } })
      .run();
  }

  private clearTimedByPattern(pattern: string): void {
    this.db.delete(timedCache).where(like(timedCache.key, pattern)).run();
  }

  // ── Galaxy Map (static, version-gated) ──

  async getMap(api: ApiClient): Promise<StarSystem[]> {
    if (this.gameVersion === "unknown") {
      try { await this.initialize(api); }
      catch (err) { console.warn("[Cache] Failed to init version:", err instanceof Error ? err.message : err); }
    }

    const cachedRaw = this.getStatic("galaxy_map");
    let cachedCount = 0;
    if (cachedRaw) {
      const systems = JSON.parse(cachedRaw) as StarSystem[];
      cachedCount = systems.length;
      if (systems.length > 0) {
        const hasCoords = systems.some((s) => s.x !== 0 || s.y !== 0);
        console.log(`[Cache] Galaxy from cache: ${systems.length} systems (coords=${hasCoords})`);
        return systems;
      }
      console.log(`[Cache] Galaxy cache empty — deleting`);
      this.deleteStatic("galaxy_map");
    }

    console.log("[Cache] Fetching galaxy map from API...");
    const systems = await api.getMap();
    console.log(`[Cache] API returned ${systems.length} systems`);
    if (systems.length > 0 && systems.length >= cachedCount) {
      this.setStatic("galaxy_map", JSON.stringify(systems), this.gameVersion);
    }
    return systems;
  }

  // ── Catalogs ──

  async getItemCatalog(api: ApiClient): Promise<CatalogItem[]> {
    const cached = this.getStatic("item_catalog", this.gameVersion);
    if (cached) {
      const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
      if (raw.length >= 50) return raw.map(normalizeCatalogItem);
    }

    const categories = ["ore", "refined", "component", "module", "artifact", "fuel", "ammo", "equipment"];
    const allItems: Record<string, unknown>[] = [];
    const seenIds = new Set<string>();

    const defaultItems = await this.fetchAllCatalogPages(api, "items");
    for (const item of defaultItems) {
      const id = String(item.id ?? item.item_id ?? "");
      if (id && !seenIds.has(id)) { seenIds.add(id); allItems.push(item); }
    }
    for (const category of categories) {
      const catItems = await this.fetchAllCatalogPages(api, "items", category);
      for (const item of catItems) {
        const id = String(item.id ?? item.item_id ?? "");
        if (id && !seenIds.has(id)) { seenIds.add(id); allItems.push(item); }
      }
    }

    const normalized = allItems.map(normalizeCatalogItem);
    this.setStatic("item_catalog", JSON.stringify(normalized), this.gameVersion);
    console.log(`[Cache] Cached ${normalized.length} items`);
    return normalized;
  }

  async getShipCatalog(api: ApiClient): Promise<ShipClass[]> {
    const cached = this.getStatic("ship_catalog", this.gameVersion);
    if (cached) {
      const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
      if (raw.length >= 50) return raw.map(normalizeShipClass);
    }

    const raw = await this.fetchAllCatalogPages(api, "ships");
    const normalized = raw.map(normalizeShipClass);
    this.setStatic("ship_catalog", JSON.stringify(normalized), this.gameVersion);
    console.log(`[Cache] Cached ${normalized.length} ships`);
    return normalized;
  }

  async getSkillTree(api: ApiClient): Promise<Skill[]> {
    const cached = this.getStatic("skill_tree", this.gameVersion);
    if (cached) return JSON.parse(cached);
    const items = await this.fetchAllCatalogPages(api, "skills");
    this.setStatic("skill_tree", JSON.stringify(items), this.gameVersion);
    console.log(`[Cache] Cached ${items.length} skills`);
    return items as unknown as Skill[];
  }

  async getRecipes(api: ApiClient): Promise<Recipe[]> {
    const cached = this.getStatic("recipe_catalog", this.gameVersion);
    if (cached) {
      const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
      if (raw.length >= 50) return raw.map(normalizeRecipe);
    }

    const categories = [
      "refining", "manufacturing", "components", "modules", "ammunition",
      "equipment", "electronics", "fuel", "consumables", "advanced",
      "engineering", "weapons", "armor", "shields", "medical", "explosives",
      "structures", "tools", "supplies",
    ];
    const allItems: Record<string, unknown>[] = [];
    const seenIds = new Set<string>();

    const defaultItems = await this.fetchAllCatalogPages(api, "recipes");
    for (const item of defaultItems) {
      const id = String(item.id ?? item.recipe_id ?? "");
      if (id && !seenIds.has(id)) { seenIds.add(id); allItems.push(item); }
    }
    for (const category of categories) {
      const catItems = await this.fetchAllCatalogPages(api, "recipes", category);
      for (const item of catItems) {
        const id = String(item.id ?? item.recipe_id ?? "");
        if (id && !seenIds.has(id)) { seenIds.add(id); allItems.push(item); }
      }
    }

    const normalized = allItems.map(normalizeRecipe);
    this.setStatic("recipe_catalog", JSON.stringify(normalized), this.gameVersion);
    console.log(`[Cache] Cached ${normalized.length} recipes`);
    return normalized;
  }

  private async fetchAllCatalogPages(api: ApiClient, type: string, category?: string): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let page = 1;
    while (true) {
      const batch = await api.catalog(type, { page, pageSize: 50, category });
      if (batch.length === 0) break;
      items.push(...batch);
      if (batch.length < 50) break;
      page++;
    }
    return items;
  }

  // ── Market Prices (timed cache) ──

  getMarketPrices(stationId: string): MarketPrice[] | null {
    const cached = this.getTimed(`market:${stationId}`);
    if (!cached) return null;
    return JSON.parse(cached);
  }

  setMarketPrices(stationId: string, prices: MarketPrice[], tick: number, ttlMs = 1_800_000): void {
    this.setTimed(`market:${stationId}`, JSON.stringify(prices), ttlMs);
    this.marketFetchedAt.set(stationId, Date.now());
    this.marketDirty = true;
    this.logger.logMarketPrices(tick, stationId, prices.map((p) => ({
      itemId: p.itemId, buyPrice: p.buyPrice, sellPrice: p.sellPrice,
      buyVolume: p.buyVolume, sellVolume: p.sellVolume,
    })));
  }

  // ── Market Insights ──

  getMarketInsights(stationId: string): MarketInsight[] | null {
    const cached = this.getTimed(`insights:${stationId}`);
    if (!cached) return null;
    return JSON.parse(cached);
  }

  setMarketInsights(stationId: string, insights: MarketInsight[], ttlMs = 1_800_000): void {
    this.setTimed(`insights:${stationId}`, JSON.stringify(insights), ttlMs);
    this.insightFetchedAt.set(stationId, Date.now());
  }

  getAllCachedInsights(): MarketInsight[] {
    const all: MarketInsight[] = [];
    for (const stationId of this.insightFetchedAt.keys()) {
      const insights = this.getMarketInsights(stationId);
      if (insights) all.push(...insights);
    }
    return all;
  }

  hasFreshInsights(stationId: string, ttlMs = 1_800_000): boolean {
    const fetchedAt = this.insightFetchedAt.get(stationId) ?? 0;
    return fetchedAt > 0 && (Date.now() - fetchedAt) < ttlMs;
  }

  // ── System Details ──

  getSystemDetail(systemId: string): StarSystem | null {
    const cached = this.getTimed(`system:${systemId}`);
    if (!cached) return null;
    return JSON.parse(cached);
  }

  setSystemDetail(systemId: string, system: StarSystem, ttlMs = 3_600_000): void {
    this.setTimed(`system:${systemId}`, JSON.stringify(system), ttlMs);
    this.setStatic(`system_detail:${systemId}`, JSON.stringify(system), "persistent");
  }

  loadPersistedSystemDetails(): StarSystem[] {
    const entries = this.getAllByPrefix("system_detail:");
    return entries.map((e) => JSON.parse(e.data) as StarSystem);
  }

  // ── Market Freshness ──

  getMarketFreshness(stationId: string, ttlMs = 900_000): MarketFreshness {
    const fetchedAt = this.marketFetchedAt.get(stationId) ?? 0;
    const ageMs = fetchedAt > 0 ? Date.now() - fetchedAt : Infinity;
    return { stationId, fetchedAt, ageMs, fresh: ageMs < ttlMs };
  }

  getAllMarketFreshness(ttlMs = 900_000): MarketFreshness[] {
    return Array.from(this.marketFetchedAt.keys()).map((id) => this.getMarketFreshness(id, ttlMs));
  }

  getFreshStationIds(ttlMs = 300_000): string[] {
    return this.getAllMarketFreshness(ttlMs).filter((f) => f.fresh).map((f) => f.stationId);
  }

  getAllCachedMarketPrices(): Array<{ stationId: string; prices: MarketPrice[]; fetchedAt: number }> {
    const results: Array<{ stationId: string; prices: MarketPrice[]; fetchedAt: number }> = [];
    for (const [stationId, fetchedAt] of this.marketFetchedAt.entries()) {
      const prices = this.getMarketPrices(stationId);
      if (prices) results.push({ stationId, prices, fetchedAt });
    }
    return results;
  }

  hasAnyMarketData(): boolean {
    return this.marketFetchedAt.size > 0;
  }

  // ── Market Data Recovery (from SQLite history) ──

  loadRecentMarketData(sqlite: import("bun:sqlite").Database): void {
    try {
      const cutoff = Math.floor(Date.now() / 1000) - 86_400;
      const rows = sqlite.query(`
        SELECT station_id, item_id, buy_price, sell_price, buy_volume, sell_volume, MAX(tick) as latest_tick
        FROM market_history WHERE tick > ?
        GROUP BY station_id, item_id ORDER BY station_id, item_id
      `).all(cutoff) as Array<{
        station_id: string; item_id: string; buy_price: number | null;
        sell_price: number | null; buy_volume: number; sell_volume: number; latest_tick: number;
      }>;

      if (rows.length === 0) return;

      const byStation = new Map<string, { prices: MarketPrice[]; latestTick: number }>();
      for (const row of rows) {
        let entry = byStation.get(row.station_id);
        if (!entry) { entry = { prices: [], latestTick: 0 }; byStation.set(row.station_id, entry); }
        entry.prices.push({
          itemId: row.item_id,
          itemName: row.item_id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          buyPrice: row.buy_price, sellPrice: row.sell_price,
          buyVolume: row.buy_volume, sellVolume: row.sell_volume,
        });
        if (row.latest_tick > entry.latestTick) entry.latestTick = row.latest_tick;
      }

      for (const [stationId, entry] of byStation) {
        this.setTimed(`market:${stationId}`, JSON.stringify(entry.prices), 14_400_000);
        this.marketFetchedAt.set(stationId, entry.latestTick * 1000);
      }

      console.log(`[Cache] Loaded market data from DB: ${byStation.size} station(s), ${rows.length} price(s)`);
    } catch (err) {
      console.warn(`[Cache] Failed to load market history:`, err);
    }
  }

  // ── Cache Management ──

  setMapCache(systems: StarSystem[]): void {
    this.setStatic("galaxy_map", JSON.stringify(systems), this.gameVersion);
  }

  async refreshMap(api: ApiClient): Promise<StarSystem[]> {
    console.log("[Cache] Force-refreshing galaxy map...");
    const systems = await api.getMap();
    if (systems.length > 0) {
      const cachedRaw = this.getStatic("galaxy_map");
      const cachedCount = cachedRaw ? (JSON.parse(cachedRaw) as StarSystem[]).length : 0;
      if (systems.length >= cachedCount) {
        this.setStatic("galaxy_map", JSON.stringify(systems), this.gameVersion);
      }
    }
    return systems;
  }

  clearGalaxyCache(): void { this.deleteStatic("galaxy_map"); }
  clearMarketCache(): void { this.clearTimedByPattern("market:%"); }

  clearAllCache(): void {
    this.db.delete(cache).run();
    this.db.delete(timedCache).run();
  }

  getCacheStatus(): Record<string, { cached: boolean; version: string | null }> {
    const keys = ["galaxy_map", "item_catalog", "ship_catalog", "skill_tree", "recipe_catalog"];
    const status: Record<string, { cached: boolean; version: string | null }> = {};
    for (const key of keys) {
      const cached = this.getStatic(key, this.gameVersion);
      status[key] = { cached: cached !== null, version: cached ? this.gameVersion : null };
    }
    return status;
  }
}
