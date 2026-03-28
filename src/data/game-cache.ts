/**
 * Game data cache with version-gated static data and TTL-based timed data.
 * Refactored from v2 to use Drizzle ORM.
 */

import { eq, and, like, sql, gt } from "drizzle-orm";
import type { DB } from "./db";
import type { TrainingLogger } from "./training-logger";
import type { ApiClient, MarketInsight } from "../core/api-client";
import { normalizeRecipe, normalizeCatalogItem, normalizeShipClass } from "../core/api-client";
import { cache, timedCache, marketHistory, poiCache } from "./schema";
import type { StarSystem, CatalogItem, ShipClass, Skill, Recipe, MarketPrice, PoiSummary } from "../types/game";

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
  private shipyardCache = new Map<string, { ships: Array<{ id: string; name: string; classId: string; price: number }>; fetchedAt: number }>();
  marketDirty = false;

  // ── Fleet-wide query dedup ──
  // In-flight promise dedup: if bot A is already fetching viewMarket for station X,
  // bot B will await the same promise instead of firing a second API call.
  private inflightMarket = new Map<string, Promise<import("../types/game").MarketOrder[]>>();
  private inflightSystem = new Map<string, Promise<StarSystem>>();
  private inflightInsights = new Map<string, Promise<import("../core/api-client").AnalyzeMarketResult | null>>();

  /** Dedup TTLs — skip API call entirely if data was fetched within this window */
  private static readonly MARKET_DEDUP_MS = 60_000;   // 60s — market orders change slowly
  private static readonly SYSTEM_DEDUP_MS = 120_000;   // 2min — system topology is near-static
  private static readonly INSIGHT_DEDUP_MS = 1_800_000; // 30min — insights update infrequently

  /**
   * Fleet-wide deduped viewMarket. If another bot fetched this station's market
   * within MARKET_DEDUP_MS, returns cached data. If a fetch is in-flight, awaits it.
   * Otherwise fires a fresh API call and shares the result.
   */
  async dedupViewMarket(
    stationId: string,
    fetcher: () => Promise<import("../types/game").MarketOrder[]>,
  ): Promise<import("../types/game").MarketOrder[]> {
    // Check freshness — skip API entirely if recently fetched
    const fetchedAt = this.marketFetchedAt.get(stationId) ?? 0;
    if (fetchedAt > 0 && (Date.now() - fetchedAt) < GameCache.MARKET_DEDUP_MS) {
      const cached = this.getMarketPrices(stationId);
      if (cached) return []; // Signal: data is fresh in cache, caller should use cache
    }

    // Coalesce in-flight requests
    const inflight = this.inflightMarket.get(stationId);
    if (inflight) return inflight;

    const promise = fetcher().finally(() => this.inflightMarket.delete(stationId));
    this.inflightMarket.set(stationId, promise);
    return promise;
  }

  /**
   * Fleet-wide deduped getSystem. Returns cached StarSystem if recently fetched,
   * coalesces in-flight requests, or fires a fresh API call.
   */
  async dedupGetSystem(
    systemId: string,
    fetcher: () => Promise<StarSystem>,
  ): Promise<StarSystem | null> {
    // Check timed cache freshness
    const cached = this.getTimed(`system:${systemId}`);
    if (cached) {
      // System is in timed cache (still within TTL) — check dedup window
      const row = this.db.select({ fetchedAt: timedCache.fetchedAt }).from(timedCache)
        .where(eq(timedCache.key, `system:${systemId}`)).get();
      if (row && (Date.now() - row.fetchedAt) < GameCache.SYSTEM_DEDUP_MS) {
        return JSON.parse(cached); // Fresh enough — skip API
      }
    }

    // Coalesce in-flight requests
    const inflight = this.inflightSystem.get(systemId);
    if (inflight) return inflight;

    const promise = fetcher().finally(() => this.inflightSystem.delete(systemId));
    this.inflightSystem.set(systemId, promise);
    return promise;
  }

  /**
   * Fleet-wide deduped analyzeMarket. Skips if fresh insights exist,
   * coalesces in-flight requests.
   */
  async dedupAnalyzeMarket(
    stationId: string,
    fetcher: () => Promise<import("../core/api-client").AnalyzeMarketResult>,
  ): Promise<import("../core/api-client").AnalyzeMarketResult | null> {
    // Already fresh?
    if (this.hasFreshInsights(stationId, GameCache.INSIGHT_DEDUP_MS)) return null;

    // Coalesce in-flight
    const inflight = this.inflightInsights.get(stationId);
    if (inflight) return inflight;

    const promise = fetcher()
      .then((result) => {
        if (result.insights.length > 0) {
          this.setMarketInsights(stationId, result.insights);
        }
        return result;
      })
      .catch(() => null)
      .finally(() => this.inflightInsights.delete(stationId));
    this.inflightInsights.set(stationId, promise);
    return promise;
  }

  // ── Faction Storage dedup ──
  private inflightFactionStorage: Promise<{ credits: number; items: import("../types/game").CargoItem[]; itemNames: Map<string, string> }> | null = null;
  private factionStorageFetchedAt = 0;
  private factionStorageCache: { credits: number; items: import("../types/game").CargoItem[]; itemNames: Map<string, string> } | null = null;
  private static readonly FACTION_STORAGE_DEDUP_MS = 30_000; // 30s — shared, changes infrequently

  /**
   * Fleet-wide deduped viewFactionStorageFull. Faction storage is shared across all bots.
   * Returns cached data if fetched within 30s, coalesces in-flight requests.
   */
  async dedupFactionStorage(
    fetcher: () => Promise<{ credits: number; items: import("../types/game").CargoItem[]; itemNames: Map<string, string> }>,
  ): Promise<{ credits: number; items: import("../types/game").CargoItem[]; itemNames: Map<string, string> }> {
    if (this.factionStorageCache && (Date.now() - this.factionStorageFetchedAt) < GameCache.FACTION_STORAGE_DEDUP_MS) {
      return this.factionStorageCache;
    }
    if (this.inflightFactionStorage) return this.inflightFactionStorage;

    const promise = fetcher()
      .then((result) => {
        this.factionStorageCache = result;
        this.factionStorageFetchedAt = Date.now();
        return result;
      })
      .finally(() => { this.inflightFactionStorage = null; });
    this.inflightFactionStorage = promise;
    return promise;
  }

  /** Invalidate faction storage cache (call after deposits/withdrawals) */
  invalidateFactionStorage(): void {
    this.factionStorageFetchedAt = 0;
    this.factionStorageCache = null;
  }

  // ── Shipyard Showroom dedup ──
  private inflightShipyard = new Map<string, Promise<Array<{ id: string; name: string; classId: string; price: number }>>>();

  /**
   * Fleet-wide deduped shipyardShowroom. Shipyard inventory is station-level.
   * Returns cached data if within 30min fresh window, coalesces in-flight requests.
   */
  async dedupShipyard(
    stationId: string,
    fetcher: () => Promise<Array<{ id: string; name: string; classId: string; price: number }>>,
  ): Promise<Array<{ id: string; name: string; classId: string; price: number }>> {
    // Check existing cache freshness
    const existing = this.shipyardCache.get(stationId);
    if (existing && (Date.now() - existing.fetchedAt) < GameCache.SHIPYARD_FRESH) {
      return existing.ships;
    }

    const inflight = this.inflightShipyard.get(stationId);
    if (inflight) return inflight;

    const promise = fetcher()
      .then((ships) => {
        this.setShipyardData(stationId, ships);
        return ships;
      })
      .finally(() => this.inflightShipyard.delete(stationId));
    this.inflightShipyard.set(stationId, promise);
    return promise;
  }

  // ── POI Detail dedup ──
  private inflightPoi = new Map<string, Promise<import("../types/game").PoiDetail>>();
  private poiFetchedAt = new Map<string, number>();
  private static readonly POI_DEDUP_MS = 300_000; // 5min — POI resources are near-static

  /**
   * Fleet-wide deduped getPoi. POI resource data is global (same for all bots).
   * Returns cached data if fetched within 5min, coalesces in-flight requests.
   */
  async dedupPoi(
    poiId: string,
    fetcher: () => Promise<import("../types/game").PoiDetail>,
  ): Promise<import("../types/game").PoiDetail | null> {
    const fetchedAt = this.poiFetchedAt.get(poiId) ?? 0;
    if (fetchedAt > 0 && (Date.now() - fetchedAt) < GameCache.POI_DEDUP_MS) {
      return null; // Signal: data is fresh, use galaxy cache
    }

    const inflight = this.inflightPoi.get(poiId);
    if (inflight) return inflight;

    const promise = fetcher()
      .then((detail) => {
        this.poiFetchedAt.set(poiId, Date.now());
        return detail;
      })
      .finally(() => this.inflightPoi.delete(poiId));
    this.inflightPoi.set(poiId, promise);
    return promise;
  }

  /** Active arbitrage route claims — prevents multiple traders racing the same route */
  private arbitrageClaims = new Map<string, { botId: string; claimedAt: number }>();
  private static readonly ARBITRAGE_CLAIM_TTL = 1_200_000; // 20 min (was 10 min — multi-jump routes need more time)

  /** Material requirements for queued facility builds (itemId → quantity needed) */
  private _facilityMaterialNeeds = new Map<string, number>();

  /** Global recipe no-demand tracker — shared across all crafters to avoid repeating failed recipes */
  private noDemandRecipes = new Map<string, { failedAt: number; failCount: number }>();
  private static readonly NO_DEMAND_TTL = 180_000; // 3 min before retrying a failed recipe

  /** Mark a recipe as having no demand (called by crafter after sell failure) */
  markRecipeNoDemand(recipeId: string): void {
    const existing = this.noDemandRecipes.get(recipeId);
    this.noDemandRecipes.set(recipeId, {
      failedAt: Date.now(),
      failCount: (existing?.failCount ?? 0) + 1,
    });
  }

  /** Check if a recipe has been globally flagged as no-demand */
  isRecipeNoDemand(recipeId: string): boolean {
    const entry = this.noDemandRecipes.get(recipeId);
    if (!entry) return false;
    if (Date.now() - entry.failedAt > GameCache.NO_DEMAND_TTL) {
      this.noDemandRecipes.delete(recipeId);
      return false;
    }
    return entry.failCount >= 2; // Require 2 failures (from any crafter) before global skip
  }

  /** Clear no-demand flag for a recipe (called when a sale succeeds) */
  clearRecipeNoDemand(recipeId: string): void {
    this.noDemandRecipes.delete(recipeId);
  }

  /** Claim an arbitrage route (item@buyStation→sellStation). Returns false if already claimed. */
  claimArbitrageRoute(itemId: string, buyStationId: string, sellStationId: string, botId: string): boolean {
    const key = `${itemId}:${buyStationId}:${sellStationId}`;
    const existing = this.arbitrageClaims.get(key);
    // Allow re-claim by same bot, or if claim is stale
    if (existing && existing.botId !== botId && (Date.now() - existing.claimedAt) < GameCache.ARBITRAGE_CLAIM_TTL) {
      return false; // Already claimed by another bot
    }
    this.arbitrageClaims.set(key, { botId, claimedAt: Date.now() });
    return true;
  }

  /** Release an arbitrage route claim (call after trade completes or fails) */
  releaseArbitrageRoute(itemId: string, buyStationId: string, sellStationId: string): void {
    this.arbitrageClaims.delete(`${itemId}:${buyStationId}:${sellStationId}`);
  }

  /** Check if a route is already claimed by another bot */
  isArbitrageRouteClaimed(itemId: string, buyStationId: string, sellStationId: string, botId: string): boolean {
    const key = `${itemId}:${buyStationId}:${sellStationId}`;
    const existing = this.arbitrageClaims.get(key);
    if (!existing) return false;
    if (existing.botId === botId) return false; // Own claim
    return (Date.now() - existing.claimedAt) < GameCache.ARBITRAGE_CLAIM_TTL;
  }

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

    // Version-gated: only refetch galaxy when game version changes
    const cachedRaw = this.getStatic("galaxy_map", this.gameVersion);
    let cachedCount = 0;
    if (cachedRaw) {
      const systems = JSON.parse(cachedRaw) as StarSystem[];
      cachedCount = systems.length;
      if (systems.length > 0) {
        const hasCoords = systems.some((s) => s.x !== 0 || s.y !== 0);
        console.log(`[Cache] Galaxy from cache: ${systems.length} systems (coords=${hasCoords}, version=${this.gameVersion})`);
        return systems;
      }
      console.log(`[Cache] Galaxy cache empty — deleting`);
      this.deleteStatic("galaxy_map");
    }

    // Check for old version cache (migrate to current version without re-fetching)
    const anyVersionRaw = this.getStatic("galaxy_map");
    if (anyVersionRaw) {
      const oldSystems = JSON.parse(anyVersionRaw) as StarSystem[];
      if (oldSystems.length > 0) {
        console.log(`[Cache] Galaxy from old version cache: ${oldSystems.length} systems — migrating to ${this.gameVersion}`);
        this.setStatic("galaxy_map", anyVersionRaw, this.gameVersion);
        return oldSystems;
      }
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
      // Re-fetch if cache is missing cpuCost field (added later for module fit checks)
      const hasModuleFields = raw.some(r => "cpuCost" in r && (r.cpuCost as number) > 0);
      const hasModules = raw.some(r => r.category === "module");
      const needsRefresh = hasModules && !hasModuleFields;
      if (raw.length >= 50 && !needsRefresh) return raw.map(normalizeCatalogItem);
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

  /** Read ship catalog from cache without fetching (no API needed) */
  getCachedShipCatalog(): ShipClass[] | null {
    const cached = this.getStatic("ship_catalog");
    if (!cached) return null;
    const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
    return raw.length > 0 ? raw.map(normalizeShipClass) : null;
  }

  /** Read item catalog from cache without fetching (no API needed) */
  getCachedItemCatalog(): CatalogItem[] | null {
    const cached = this.getStatic("item_catalog");
    if (!cached) return null;
    const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
    return raw.length > 0 ? raw.map(normalizeCatalogItem) : null;
  }

  /** Read skill tree from cache without fetching (no API needed) */
  getCachedSkillTree(): Skill[] | null {
    const cached = this.getStatic("skill_tree");
    if (!cached) return null;
    return JSON.parse(cached) as Skill[];
  }

  /** Read recipe catalog from cache without fetching (no API needed) */
  getCachedRecipes(): Recipe[] | null {
    const cached = this.getStatic("recipe_catalog");
    if (!cached) return null;
    const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
    return raw.length > 0 ? raw.map(normalizeRecipe) : null;
  }

  async getShipCatalog(api: ApiClient): Promise<ShipClass[]> {
    const cached = this.getStatic("ship_catalog", this.gameVersion);
    if (cached) {
      const raw = JSON.parse(cached) as Array<Record<string, unknown>>;
      // Re-fetch if cache is missing region field (added later)
      const hasRegion = raw.length > 0 && "region" in raw[0];
      if (raw.length >= 50 && hasRegion) return raw.map(normalizeShipClass);
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

  // ── Shipyard Cache (in-memory + persisted to timed_cache) ──

  private static SHIPYARD_TTL = 24 * 3_600_000; // 24h persistence
  private static SHIPYARD_FRESH = 1_800_000;     // 30min "fresh" window

  setShipyardData(stationId: string, ships: Array<{ id: string; name: string; classId: string; price: number }>): void {
    const fetchedAt = Date.now();
    this.shipyardCache.set(stationId, { ships, fetchedAt });
    // Persist to SQLite
    this.setTimed(`shipyard:${stationId}`, JSON.stringify(ships), GameCache.SHIPYARD_TTL);
  }

  getShipyardData(stationId: string): Array<{ id: string; name: string; classId: string; price: number }> | null {
    const entry = this.shipyardCache.get(stationId);
    if (!entry) return null;
    // Expire after 24h for persisted data
    if (Date.now() - entry.fetchedAt > GameCache.SHIPYARD_TTL) return null;
    return entry.ships;
  }

  getAllShipyardData(): Record<string, { ships: Array<{ id: string; name: string; classId: string; price: number }>; fetchedAt: number }> {
    const result: Record<string, { ships: Array<{ id: string; name: string; classId: string; price: number }>; fetchedAt: number }> = {};
    const now = Date.now();
    for (const [stationId, entry] of this.shipyardCache) {
      if (now - entry.fetchedAt < GameCache.SHIPYARD_TTL) {
        result[stationId] = entry;
      }
    }
    return result;
  }

  /** Load persisted shipyard data from SQLite into memory (call on startup) */
  loadShipyardData(): number {
    const rows = this.db.select().from(timedCache)
      .where(like(timedCache.key, "shipyard:%")).all();
    let count = 0;
    const now = Date.now();
    for (const row of rows) {
      if (now - row.fetchedAt > row.ttlMs) continue; // expired
      const stationId = row.key.replace("shipyard:", "");
      try {
        const ships = JSON.parse(row.data) as Array<{ id: string; name: string; classId: string; price: number }>;
        this.shipyardCache.set(stationId, { ships, fetchedAt: row.fetchedAt });
        count++;
      } catch { /* skip corrupted entries */ }
    }
    return count;
  }

  /** Get a catalog item by ID (from cached item catalog) */
  getCatalogItem(itemId: string): CatalogItem | null {
    const cached = this.getStatic("item_catalog", this.gameVersion);
    if (!cached) return null;
    const items = JSON.parse(cached) as CatalogItem[];
    return items.find(i => i.id === itemId) ?? null;
  }

  /** Find a station that sells a specific item (from cached market scans) */
  findItemSeller(itemPattern: string, maxPrice: number): { stationId: string; itemId: string; price: number } | null {
    let best: { stationId: string; itemId: string; price: number } | null = null;
    for (const [key] of this.marketFetchedAt) {
      const stationId = key;
      const prices = this.getMarketPrices(stationId);
      if (!prices) continue;
      for (const p of prices) {
        if (!p.itemId.includes(itemPattern)) continue;
        if (!p.sellPrice || p.sellPrice <= 0 || p.sellVolume <= 0) continue;
        if (p.sellPrice > maxPrice) continue;
        if (!best || p.sellPrice < best.price) {
          best = { stationId, itemId: p.itemId, price: p.sellPrice };
        }
      }
    }
    return best;
  }

  /** Find a station that sells a specific ship class (from cached shipyard scans) */
  findShipyardForClass(classId: string): { stationId: string; price: number } | null {
    const now = Date.now();
    for (const [stationId, entry] of this.shipyardCache) {
      if (now - entry.fetchedAt > GameCache.SHIPYARD_TTL) continue;
      const ship = entry.ships.find(s => s.classId === classId);
      if (ship) return { stationId, price: ship.price };
    }
    return null;
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

  // ── Fleet-wide Unsellable Items (prevents all traders from repeatedly trying failed items) ──

  /** Mark an item as unsellable fleet-wide (30 min TTL) */
  markUnsellable(itemId: string): void {
    this.setTimed(`unsellable:${itemId}`, "1", 1_800_000); // 30 minutes
  }

  /** Check if an item is fleet-wide blacklisted as unsellable */
  isUnsellable(itemId: string): boolean {
    return this.getTimed(`unsellable:${itemId}`) !== null;
  }

  /** Get all currently unsellable item IDs */
  getUnsellableItems(): string[] {
    const rows = this.db.select({ key: timedCache.key, data: timedCache.data, fetchedAt: timedCache.fetchedAt, ttlMs: timedCache.ttlMs })
      .from(timedCache).where(like(timedCache.key, "unsellable:%")).all();
    const now = Date.now();
    return rows
      .filter((r) => now - r.fetchedAt <= r.ttlMs)
      .map((r) => r.key.replace("unsellable:", ""));
  }

  /** Clear unsellable status for an item (e.g., when market conditions change) */
  clearUnsellable(itemId: string): void {
    this.db.delete(timedCache).where(eq(timedCache.key, `unsellable:${itemId}`)).run();
  }

  // ── Facility-only Recipes (prevents crafters from retrying known facility-only recipes) ──

  /** Mark a recipe as facility-only (persists for game version lifetime) */
  markFacilityOnly(recipeId: string): void {
    this.setStatic(`facility_only:${recipeId}`, "1", this.gameVersion);
  }

  /** Check if a recipe is known to be facility-only */
  isFacilityOnly(recipeId: string): boolean {
    return this.getStatic(`facility_only:${recipeId}`) !== null;
  }

  /** Get all known facility-only recipe IDs */
  getFacilityOnlyRecipes(): string[] {
    return this.getAllByPrefix("facility_only:").map((r) => r.key.replace("facility_only:", ""));
  }

  /** Temporarily blacklist a recipe that failed to craft (10 min TTL) */
  markRecipeFailed(recipeId: string): void {
    this.setTimed(`recipe_failed:${recipeId}`, "1", 600_000); // 10 minutes
  }

  /** Check if a recipe is temporarily blacklisted */
  isRecipeFailed(recipeId: string): boolean {
    return this.getTimed(`recipe_failed:${recipeId}`) !== null;
  }

  // ── Material Unavailability (per-bot, persists across routine restarts) ──

  /** Mark a material as unavailable for a specific bot (10 min TTL) */
  markMaterialUnavailable(botId: string, itemId: string): void {
    this.setTimed(`material_unavail:${botId}:${itemId}`, "1", 600_000); // 10 minutes
  }

  /** Check if a material is unavailable for a specific bot */
  isMaterialUnavailable(botId: string, itemId: string): boolean {
    return this.getTimed(`material_unavail:${botId}:${itemId}`) !== null;
  }

  /** Get all unavailable material IDs for a specific bot */
  getUnavailableMaterials(botId: string): string[] {
    const prefix = `material_unavail:${botId}:`;
    const rows = this.db.select({ key: timedCache.key, fetchedAt: timedCache.fetchedAt, ttlMs: timedCache.ttlMs })
      .from(timedCache).where(like(timedCache.key, `${prefix}%`)).all();
    const now = Date.now();
    return rows
      .filter((r) => now - r.fetchedAt <= r.ttlMs)
      .map((r) => r.key.replace(prefix, ""));
  }

  // ── Facility Material Needs (shared across QM, crafters, traders) ──

  /** Set material requirements for queued facility builds. Replaces previous needs. */
  setFacilityMaterialNeeds(needs: Map<string, number>): void {
    this._facilityMaterialNeeds = new Map(needs);
  }

  /** Get material requirements for queued facility builds (itemId → quantity needed). */
  getFacilityMaterialNeeds(): Map<string, number> {
    return this._facilityMaterialNeeds;
  }

  /** Check if an item is needed for a facility build. */
  isFacilityMaterial(itemId: string): boolean {
    return (this._facilityMaterialNeeds.get(itemId) ?? 0) > 0;
  }

  clearGalaxyCache(): void { this.deleteStatic("galaxy_map"); }
  clearMarketCache(): void { this.clearTimedByPattern("market:%"); }

  clearAllCache(): void {
    this.db.delete(cache).run();
    this.db.delete(timedCache).run();
  }

  // ── POI Persistence (institutional memory across restarts) ──

  /** Persist a POI discovery (survives restarts, no TTL) */
  persistPoi(poiId: string, systemId: string, poi: PoiSummary): void {
    this.db.insert(poiCache).values({
      poiId,
      systemId,
      data: JSON.stringify(poi),
      updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: poiCache.poiId,
      set: { systemId, data: JSON.stringify(poi), updatedAt: new Date().toISOString() },
    }).run();
  }

  /** Persist multiple POIs from a system scan (preserves existing resource data) */
  persistSystemPois(systemId: string, pois: PoiSummary[]): void {
    for (const poi of pois) {
      // Don't overwrite existing POIs that have resource data with empty-resource versions
      // (get_system returns POIs with resources: [], get_poi fills in the real data)
      if (poi.resources.length === 0) {
        const existing = this.db.select({ data: poiCache.data }).from(poiCache)
          .where(eq(poiCache.poiId, poi.id)).get();
        if (existing) {
          try {
            const prev = JSON.parse(existing.data) as PoiSummary;
            if (prev.resources?.length > 0) continue; // Keep existing resource data
          } catch { /* corrupt — overwrite */ }
        }
      }
      this.persistPoi(poi.id, systemId, poi);
    }
  }

  /** Load all persisted POIs (for galaxy hydration on startup) */
  loadPersistedPois(): Array<{ poiId: string; systemId: string; poi: PoiSummary }> {
    const rows = this.db.select().from(poiCache).all();
    const results: Array<{ poiId: string; systemId: string; poi: PoiSummary }> = [];
    for (const row of rows) {
      try {
        results.push({ poiId: row.poiId, systemId: row.systemId, poi: JSON.parse(row.data) });
      } catch { /* skip corrupt entries */ }
    }
    return results;
  }

  /** Load persisted POIs for a specific system */
  loadPersistedSystemPois(systemId: string): PoiSummary[] {
    const rows = this.db.select().from(poiCache).where(eq(poiCache.systemId, systemId)).all();
    const results: PoiSummary[] = [];
    for (const row of rows) {
      try { results.push(JSON.parse(row.data)); } catch { /* skip */ }
    }
    return results;
  }

  /** Find all belts containing a specific resource (searches persisted POI data) */
  findBeltsWithResource(resourceId: string): Array<{ poiId: string; systemId: string; name: string; richness: number; remaining: number }> {
    const rows = this.db.select().from(poiCache).all();
    const results: Array<{ poiId: string; systemId: string; name: string; richness: number; remaining: number }> = [];
    for (const row of rows) {
      try {
        const poi = JSON.parse(row.data) as PoiSummary;
        if (!poi.resources?.length) continue;
        const res = poi.resources.find(r => r.resourceId === resourceId);
        if (res) {
          results.push({
            poiId: row.poiId,
            systemId: row.systemId,
            name: poi.name,
            richness: res.richness,
            remaining: res.remaining,
          });
        }
      } catch { /* skip corrupt */ }
    }
    return results.sort((a, b) => b.richness - a.richness);
  }

  /** Count persisted POIs */
  getPersistedPoiCount(): number {
    const result = this.db.select({ count: sql<number>`count(*)` }).from(poiCache).get();
    return result?.count ?? 0;
  }

  // ── Routine Checkpoints (Phase 6: crash recovery) ──

  /** Save a routine checkpoint so it can resume after crash/restart */
  saveCheckpoint(botId: string, routine: string, data: Record<string, unknown>): void {
    this.setTimed(`checkpoint:${botId}`, JSON.stringify({ routine, data, savedAt: Date.now() }), 3_600_000); // 1h TTL
  }

  /** Load a routine checkpoint for a bot (returns null if expired/missing) */
  loadCheckpoint(botId: string): { routine: string; data: Record<string, unknown>; savedAt: number } | null {
    const raw = this.getTimed(`checkpoint:${botId}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /** Clear a bot's checkpoint (call on clean routine completion) */
  clearCheckpoint(botId: string): void {
    this.db.delete(timedCache).where(eq(timedCache.key, `checkpoint:${botId}`)).run();
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
