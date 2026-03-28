/**
 * Economy engine - tracks supply/demand, inventory alerts, and profit.
 * Provides the EconomySnapshot consumed by the Commander brain.
 */

import type { StockTarget } from "../config/schema";
import type { FleetStatus, FleetBotInfo } from "../bot/types";
import type {
  MaterialDemand,
  MaterialSupply,
  SupplyDeficit,
  SupplySurplus,
  InventoryAlert,
  EconomySnapshot,
  FleetWorkOrder,
} from "./types";

/** Fallback production rates per routine (used when no observed data yet) */
const FALLBACK_PRODUCTION: Record<string, { itemId: string; qtyPerHour: number }[]> = {
  miner: [{ itemId: "ore_iron", qtyPerHour: 60 }],
  harvester: [{ itemId: "ore_ice_nitrogen", qtyPerHour: 40 }],
  crafter: [{ itemId: "refined_steel", qtyPerHour: 15 }],
};

/** Fallback consumption rates per routine */
const FALLBACK_CONSUMPTION: Record<string, { itemId: string; qtyPerHour: number }[]> = {
  crafter: [{ itemId: "ore_iron", qtyPerHour: 30 }],
};

/** Sliding window duration for observed production tracking (1 hour) */
const OBSERVATION_WINDOW_MS = 3_600_000;

export class EconomyEngine {
  private demands: MaterialDemand[] = [];
  private supplies: MaterialSupply[] = [];
  private stockTargets: StockTarget[] = [];
  private stationInventory = new Map<string, Map<string, number>>(); // station → item → qty
  private factionInventory = new Map<string, number>(); // item → qty (shared faction storage)

  // Profit tracking (running totals — reset daily)
  private totalRevenue = 0;
  private totalCosts = 0;

  /** Crafting service for recipe-aware work orders (set by Commander) */
  crafting: import("../core/crafting").Crafting | null = null;

  /** Latest computed work orders (cached for dashboard access) */
  private _workOrders: FleetWorkOrder[] = [];

  /** Facility material needs from GameCache (injected by Commander) */
  private facilityMaterialNeeds = new Map<string, number>();

  /** Update facility material needs (called by Commander after QM sets cache) */
  setFacilityMaterialNeeds(needs: Map<string, number>): void {
    this.facilityMaterialNeeds = new Map(needs);
  }

  /**
   * Observed production/consumption per bot: botId → timestamped events.
   * Trimmed in bulk every TRIM_INTERVAL_MS (not per-read).
   */
  private observedProduction = new Map<string, Array<{ itemId: string; qty: number; at: number }>>();
  private observedConsumption = new Map<string, Array<{ itemId: string; qty: number; at: number }>>();
  private lastTrimTime = 0;
  private static readonly TRIM_INTERVAL_MS = 5 * 60_000; // Bulk trim every 5 minutes

  /** Record an observed production event (e.g., miner deposited 10 ore_iron) */
  recordProduction(botId: string, itemId: string, qty: number): void {
    if (qty <= 0) return;
    if (!this.observedProduction.has(botId)) this.observedProduction.set(botId, []);
    this.observedProduction.get(botId)!.push({ itemId, qty, at: Date.now() });
    this.trimIfNeeded();
  }

  /** Record an observed consumption event (e.g., crafter consumed 5 ore_iron) */
  recordConsumption(botId: string, itemId: string, qty: number): void {
    if (qty <= 0) return;
    if (!this.observedConsumption.has(botId)) this.observedConsumption.set(botId, []);
    this.observedConsumption.get(botId)!.push({ itemId, qty, at: Date.now() });
    this.trimIfNeeded();
  }

  /** Bulk trim stale observations (runs at most every 5 minutes) */
  private trimIfNeeded(): void {
    const now = Date.now();
    if (now - this.lastTrimTime < EconomyEngine.TRIM_INTERVAL_MS) return;
    this.lastTrimTime = now;
    const cutoff = now - OBSERVATION_WINDOW_MS;
    for (const store of [this.observedProduction, this.observedConsumption]) {
      for (const [botId, events] of store) {
        const trimmed = events.filter(e => e.at >= cutoff);
        if (trimmed.length === 0) store.delete(botId);
        else store.set(botId, trimmed);
      }
    }
  }

  /** Get observed per-hour rates for a bot (production) */
  private getObservedRates(botId: string, type: "production" | "consumption"): Map<string, number> {
    const store = type === "production" ? this.observedProduction : this.observedConsumption;
    const events = store.get(botId);
    if (!events || events.length === 0) return new Map();

    const now = Date.now();
    const cutoff = now - OBSERVATION_WINDOW_MS;

    // Sum quantities per item (skip stale inline — no mutation needed, bulk trim handles cleanup)
    const sums = new Map<string, number>();
    let oldestRecent = now;
    let hasRecent = false;
    for (const e of events) {
      if (e.at < cutoff) continue;
      sums.set(e.itemId, (sums.get(e.itemId) ?? 0) + e.qty);
      if (e.at < oldestRecent) oldestRecent = e.at;
      hasRecent = true;
    }

    if (!hasRecent) return new Map();

    // Convert to per-hour rate: qty / (window hours elapsed)
    const elapsed = Math.max(now - oldestRecent, 60_000); // Min 1 minute to avoid division by tiny number
    const hoursElapsed = elapsed / 3_600_000;

    const rates = new Map<string, number>();
    for (const [itemId, total] of sums) {
      rates.set(itemId, total / hoursElapsed);
    }
    return rates;
  }

  /** Set inventory targets from config */
  setStockTargets(targets: StockTarget[]): void {
    this.stockTargets = targets;
  }

  /** Add a single stock target */
  addStockTarget(target: StockTarget): void {
    // Replace existing target for same station/item, or add new
    const idx = this.stockTargets.findIndex(
      (t) => t.station_id === target.station_id && t.item_id === target.item_id
    );
    if (idx >= 0) {
      this.stockTargets[idx] = target;
    } else {
      this.stockTargets.push(target);
    }
  }

  /** Remove a stock target by station and item */
  removeStockTarget(stationId: string, itemId: string): void {
    this.stockTargets = this.stockTargets.filter(
      (t) => !(t.station_id === stationId && t.item_id === itemId)
    );
  }

  /** Update station inventory from storage queries */
  updateStationInventory(stationId: string, items: Map<string, number>): void {
    this.stationInventory.set(stationId, items);
  }

  /** Update faction storage inventory (shared across all bots) */
  updateFactionInventory(items: Map<string, number>): void {
    this.factionInventory = items;
  }

  /** Get quantity of an item in faction storage */
  getFactionStock(itemId: string): number {
    return this.factionInventory.get(itemId) ?? 0;
  }

  /** Get the full faction inventory snapshot */
  getFactionInventory(): Map<string, number> {
    return new Map(this.factionInventory);
  }

  /** Check if faction has any items matching a pattern */
  hasFactionMaterials(itemPatterns: string[]): boolean {
    for (const pattern of itemPatterns) {
      for (const [itemId] of this.factionInventory) {
        if (itemId.includes(pattern)) return true;
      }
    }
    return false;
  }

  /** Record revenue (credits earned from selling) */
  recordRevenue(amount: number): void {
    this.totalRevenue += amount;
  }

  /** Record cost (credits spent on buying/refueling/repair) */
  recordCost(amount: number): void {
    this.totalCosts += amount;
  }

  /**
   * Analyze fleet state and produce an economy snapshot.
   * This is the primary output consumed by the Commander brain.
   */
  analyze(fleet: FleetStatus): EconomySnapshot {
    this.calculateDemandSupply(fleet);

    const deficits = this.computeDeficits();
    const surpluses = this.computeSurpluses();
    const inventoryAlerts = this.checkInventoryTargets();

    const totalRevenue = this.totalRevenue;
    const totalCosts = this.totalCosts;
    const netProfit = totalRevenue - totalCosts;

    // Compute prioritized work orders from deficits + market analysis
    const workOrders = this.computeWorkOrders(deficits, surpluses);
    this._workOrders = workOrders;

    return {
      deficits,
      surpluses,
      inventoryAlerts,
      totalRevenue,
      totalCosts,
      netProfit,
      factionStorage: new Map(this.factionInventory),
      workOrders,
    };
  }

  /** Get the latest computed work orders */
  getWorkOrders(): FleetWorkOrder[] {
    return this._workOrders;
  }

  /** Reset profit tracking (call at beginning of each evaluation period) */
  resetProfitTracking(): void {
    this.totalRevenue = 0;
    this.totalCosts = 0;
  }

  // ── Internal ──

  private calculateDemandSupply(fleet: FleetStatus): void {
    this.demands = [];
    this.supplies = [];

    for (const bot of fleet.bots) {
      if (bot.status !== "running" || !bot.routine) continue;

      // Production: prefer observed rates, fall back to estimates
      const observedProd = this.getObservedRates(bot.botId, "production");
      if (observedProd.size > 0) {
        for (const [itemId, qtyPerHour] of observedProd) {
          this.supplies.push({ itemId, quantityPerHour: qtyPerHour, source: bot.botId });
        }
      } else {
        const fallback = FALLBACK_PRODUCTION[bot.routine];
        if (fallback) {
          for (const p of fallback) {
            this.supplies.push({ itemId: p.itemId, quantityPerHour: p.qtyPerHour, source: bot.botId });
          }
        }
      }

      // Consumption: prefer observed rates, fall back to estimates
      const observedCons = this.getObservedRates(bot.botId, "consumption");
      if (observedCons.size > 0) {
        for (const [itemId, qtyPerHour] of observedCons) {
          this.demands.push({ itemId, quantityPerHour: qtyPerHour, source: bot.botId, priority: "normal" });
        }
      } else {
        const fallback = FALLBACK_CONSUMPTION[bot.routine];
        if (fallback) {
          for (const c of fallback) {
            this.demands.push({ itemId: c.itemId, quantityPerHour: c.qtyPerHour, source: bot.botId, priority: "normal" });
          }
        }
      }

      // Fuel demand for all active bots
      this.demands.push({
        itemId: "fuel",
        quantityPerHour: 10,
        source: bot.botId,
        priority: bot.fuelPct < 30 ? "critical" : "normal",
      });
    }
  }

  private computeDeficits(): SupplyDeficit[] {
    // Aggregate demand and supply per item
    const demandMap = new Map<string, { total: number; priority: "critical" | "normal" | "low" }>();
    const supplyMap = new Map<string, number>();

    for (const d of this.demands) {
      const existing = demandMap.get(d.itemId) ?? { total: 0, priority: "low" as const };
      existing.total += d.quantityPerHour;
      // Escalate priority
      if (d.priority === "critical" || existing.priority === "critical") {
        existing.priority = "critical";
      } else if (d.priority === "normal" || existing.priority === "normal") {
        existing.priority = "normal";
      }
      demandMap.set(d.itemId, existing);
    }

    for (const s of this.supplies) {
      supplyMap.set(s.itemId, (supplyMap.get(s.itemId) ?? 0) + s.quantityPerHour);
    }

    const deficits: SupplyDeficit[] = [];
    for (const [itemId, demand] of demandMap) {
      const supply = supplyMap.get(itemId) ?? 0;
      if (demand.total > supply) {
        deficits.push({
          itemId,
          demandPerHour: demand.total,
          supplyPerHour: supply,
          shortfall: demand.total - supply,
          priority: demand.priority,
        });
      }
    }

    // Sort by priority then shortfall
    deficits.sort((a, b) => {
      const prio = priorityValue(b.priority) - priorityValue(a.priority);
      if (prio !== 0) return prio;
      return b.shortfall - a.shortfall;
    });

    return deficits;
  }

  private computeSurpluses(): SupplySurplus[] {
    const demandMap = new Map<string, number>();
    const supplyMap = new Map<string, number>();

    for (const d of this.demands) {
      demandMap.set(d.itemId, (demandMap.get(d.itemId) ?? 0) + d.quantityPerHour);
    }
    for (const s of this.supplies) {
      supplyMap.set(s.itemId, (supplyMap.get(s.itemId) ?? 0) + s.quantityPerHour);
    }

    const surpluses: SupplySurplus[] = [];
    for (const [itemId, supply] of supplyMap) {
      const demand = demandMap.get(itemId) ?? 0;
      if (supply > demand) {
        surpluses.push({
          itemId,
          excessPerHour: supply - demand,
          stationId: "", // Would need station-level tracking
          currentStock: 0,
        });
      }
    }

    return surpluses;
  }

  private checkInventoryTargets(): InventoryAlert[] {
    const alerts: InventoryAlert[] = [];

    for (const target of this.stockTargets) {
      const stationItems = this.stationInventory.get(target.station_id);
      const current = stationItems?.get(target.item_id) ?? 0;

      if (current < target.min_stock) {
        alerts.push({
          stationId: target.station_id,
          itemId: target.item_id,
          current,
          target,
          type: "below_min",
        });
      } else if (current > target.max_stock) {
        alerts.push({
          stationId: target.station_id,
          itemId: target.item_id,
          current,
          target,
          type: "above_max",
        });
      }
    }

    return alerts;
  }

  /**
   * Compute prioritized work orders from supply/demand analysis.
   * These tell the fleet WHAT to do — the scoring brain decides WHO does it.
   */
  private computeWorkOrders(deficits: SupplyDeficit[], surpluses: SupplySurplus[]): FleetWorkOrder[] {
    const orders: FleetWorkOrder[] = [];

    // ── Mining orders: from deficits + low faction storage ──
    const oreStock = new Map<string, number>();
    for (const [itemId, qty] of this.factionInventory) {
      if (itemId.includes("ore")) oreStock.set(itemId, qty);
    }

    // Ore types crafters need (from deficit analysis)
    for (const deficit of deficits) {
      if (deficit.itemId.startsWith("ore_") || deficit.itemId.includes("ice") || deficit.itemId.includes("gas")) {
        const stock = this.factionInventory.get(deficit.itemId) ?? 0;
        const priority = deficit.priority === "critical" ? 90
          : deficit.priority === "normal" ? 60 : 30;
        orders.push({
          type: "mine",
          targetId: deficit.itemId,
          description: `Mine ${deficit.itemId.replace(/_/g, " ")}`,
          priority: Math.min(100, priority + Math.min(30, deficit.shortfall)),
          reason: `deficit: ${deficit.shortfall.toFixed(0)}/hr, stock: ${stock}`,
          quantity: Math.max(10, Math.round(deficit.shortfall * 2)),
        });
      }
    }

    // Low-stock ores not covered by deficits
    const LOW_ORE_THRESHOLD = 50;
    const coveredOres = new Set(orders.filter(o => o.type === "mine").map(o => o.targetId));
    for (const [itemId, qty] of oreStock) {
      if (coveredOres.has(itemId)) continue;
      if (qty < LOW_ORE_THRESHOLD) {
        orders.push({
          type: "mine",
          targetId: itemId,
          description: `Mine ${itemId.replace(/_/g, " ")} (low stock)`,
          priority: 40 + Math.round((LOW_ORE_THRESHOLD - qty) * 3),
          reason: `faction stock: ${qty} (below ${LOW_ORE_THRESHOLD})`,
          quantity: LOW_ORE_THRESHOLD * 2,
        });
      }
    }

    // ── Crafting orders: profitable recipes with available materials ──
    if (this.crafting && this.crafting.recipeCount > 0) {
      const recipes = this.crafting.getAllRecipes();
      for (const recipe of recipes) {
        const { profit, hasMarketData } = this.crafting.estimateMarketProfit(recipe.id);
        if (profit <= 0) continue;

        // Check if raw materials are available in faction storage
        const raws = this.crafting.getRawMaterials(recipe.id, 1);
        let canCraft = true;
        let minBatches = Infinity;
        for (const [rawId, needed] of raws) {
          const available = this.factionInventory.get(rawId) ?? 0;
          if (available < needed) { canCraft = false; break; }
          minBatches = Math.min(minBatches, Math.floor(available / needed));
        }
        if (!canCraft || minBatches === 0) continue;

        orders.push({
          type: "craft",
          targetId: recipe.id,
          description: `Craft ${recipe.name ?? recipe.id.replace(/_/g, " ")}`,
          priority: Math.min(85, 40 + Math.round(profit / 100)),
          reason: `profit: ${profit.toFixed(0)}cr${hasMarketData ? "" : " (est)"}, can make ${minBatches}`,
          quantity: Math.min(minBatches, 10),
        });
      }
    }

    // ── Trade orders: sell surplus crafted goods in faction storage ──
    const craftedGoods = [...this.factionInventory.entries()]
      .filter(([id]) => id.startsWith("refined_") || id.startsWith("component_") || id.startsWith("alloy_"))
      .filter(([, qty]) => qty >= 5);

    for (const [itemId, qty] of craftedGoods) {
      orders.push({
        type: "trade",
        targetId: itemId,
        description: `Sell ${itemId.replace(/_/g, " ")} (${qty} in stock)`,
        priority: Math.min(70, 30 + Math.round(qty / 5)),
        reason: `${qty} units in faction storage`,
        quantity: qty,
      });
    }

    // ── Facility material orders: highest priority mining/crafting for facility builds ──
    for (const [itemId, needed] of this.facilityMaterialNeeds) {
      const inStorage = this.factionInventory.get(itemId) ?? 0;
      if (inStorage >= needed) continue;
      const deficit = needed - inStorage;
      // Check if this is a raw material (mine it) or crafted (craft it)
      const isRaw = itemId.startsWith("ore_") || itemId.includes("ice") || itemId.includes("gas");
      orders.push({
        type: isRaw ? "mine" : "craft",
        targetId: itemId,
        description: `Facility build: ${itemId.replace(/_/g, " ")} (${inStorage}/${needed})`,
        priority: 95, // Near-max priority — facility builds are strategic
        reason: `facility blocked: need ${deficit} more ${itemId}`,
        quantity: deficit,
      });
    }

    // ── Sell overstocked raw ores (3000+) ──
    for (const [itemId, qty] of oreStock) {
      if (qty >= 3000) {
        orders.push({
          type: "trade",
          targetId: itemId,
          description: `Sell excess ${itemId.replace(/_/g, " ")}`,
          priority: Math.min(80, 50 + Math.round((qty - 3000) / 500)),
          reason: `overstocked: ${qty} units`,
          quantity: qty - 1000, // Keep 1000 reserve
        });
      }
    }

    // Sort by priority descending
    orders.sort((a, b) => b.priority - a.priority);
    return orders;
  }
}

function priorityValue(p: "critical" | "normal" | "low"): number {
  switch (p) {
    case "critical": return 3;
    case "normal": return 2;
    case "low": return 1;
  }
}
