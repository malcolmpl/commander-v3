/**
 * Quartermaster routine - Faction home base commander & merchant.
 *
 * Stays docked at faction home station and manages faction commerce:
 * 1. Sells crafted goods from faction storage at competitive prices
 *    (priced below competing stations to attract buyers to our system)
 * 2. Buys equipment modules (ice/gas harvesters, survey scanners)
 *    slowly, stockpiling them in faction storage for fleet bots to equip
 *
 * This bot acts as the faction leader — it never leaves home.
 *
 * Params:
 *   homeBase: string     - Base ID of faction home (auto from fleetConfig)
 *   moduleTarget: number - Target count per module type (default: 4)
 *   undercutPct: number  - Price undercut percentage vs competitors (default: 0.05)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import type { MarketOrder, Recipe } from "../types/game";
import {
  navigateAndDock,
  refuelIfNeeded,
  getParam,
  cacheMarketData,
  interruptibleSleep,
  withdrawFromFaction,
  ensureMinCredits,
  depositExcessCredits,
  fleetViewFactionStorage,
  MAX_MATERIAL_BUY_PRICE,
} from "./helpers";
import { ROIAnalyzer } from "../commander/roi-analyzer";
import type { ROIEstimate } from "../commander/types";

// Equipment modules to accumulate for fleet use
const MODULE_TARGETS = [
  { pattern: "ice_harvester", target: 4, label: "Ice Harvester", fallbackIds: ["ice_harvester_1", "ice_harvester_2"], fallbackPrice: 15000 },
  { pattern: "gas_harvester", target: 4, label: "Gas Harvester", fallbackIds: ["gas_harvester_1", "gas_harvester_2"], fallbackPrice: 15000 },
  { pattern: "survey", target: 3, label: "Survey Scanner", fallbackIds: ["survey_scanner_1", "survey_scanner_2"], fallbackPrice: 20000 },
  { pattern: "mining_laser", target: 10, label: "Mining Laser", fallbackIds: ["mining_laser_i", "mining_laser_ii"], fallbackPrice: 500 },
  { pattern: "shield_booster", target: 10, label: "Shield Booster", fallbackIds: ["shield_booster_i", "shield_booster_ii"], fallbackPrice: 300 },
  { pattern: "cargo_expander", target: 10, label: "Cargo Expander", fallbackIds: ["cargo_expander_i", "cargo_expander_ii"], fallbackPrice: 500 },
  { pattern: "pulse_laser", target: 10, label: "Pulse Laser", fallbackIds: ["pulse_laser_i", "pulse_laser_ii"], fallbackPrice: 500 },
];

// Minimum sell prices for modules — max(5x craft cost, market price)
// Prevents dumping valuable crafted modules at low prices
const MODULE_MIN_PRICES: Record<string, number> = {
  mining_laser_ii: 2500,    // craft cost ~500, 5x = 2500
  shield_booster_i: 1500,   // craft cost ~300, 5x = 1500
  survey_scanner_i: 2000,   // craft cost ~400, 5x = 2000
  cargo_expander_i: 2500,   // craft cost ~500, 5x = 2500
  pulse_laser_i: 2500,      // craft cost ~500, 5x = 2500
  mining_laser_i: 1000,     // craft cost ~200, 5x = 1000
  ice_harvester_i: 5000,    // high value
  gas_harvester_i: 5000,    // high value
};

// Strategic crafting materials — never sell from faction storage
const PROTECTED_MATERIALS = new Set([
  "energy_crystal", "phase_crystal", "quantum_fragments",
  "focused_crystal", "circuit_board", "titanium_alloy",
  "steel_plate", "copper_wiring", "sensor_array",
  "thruster_nozzle", "power_battery", "ceramite_plating",
  "silver_wiring", "premium_fuel_cell",
  "compressed_hydrogen", "liquid_hydrogen",
]);

// Items that look like ship modules (don't sell these from faction storage)
const MODULE_PATTERNS = [
  "harvester", "scanner", "laser", "cannon", "turret",
  "shield", "armor", "engine", "thruster", "cloak",
  "tow", "salvage", "drill", "weapon", "mod_", "module",
];

// ── Price index (built once per sell cycle, replaces O(n²) scans) ──

interface PriceEntry {
  cheapestBuy: number;   // Lowest buy price across all stations (what sellers charge)
  bestSell: number;      // Highest sell/demand price (what buyers will pay)
  hasBuyVolume: boolean; // Any station has buy orders with volume > 0
  medianBuy: number;     // Volume-weighted median buy price (0 if no data)
  medianSell: number;    // Volume-weighted median sell price (0 if no data)
}

/** Compute volume-weighted median from price/volume pairs */
function computeMedian(entries: Array<{ price: number; volume: number }>): number {
  if (entries.length === 0) return 0;
  // Expand into individual units, sorted by price
  const expanded: number[] = [];
  for (const { price, volume } of entries) {
    // Cap expansion to avoid memory issues with huge volumes
    const units = Math.min(volume, 1000);
    for (let i = 0; i < units; i++) expanded.push(price);
  }
  if (expanded.length === 0) return 0;
  expanded.sort((a, b) => a - b);
  const mid = Math.floor(expanded.length / 2);
  return expanded.length % 2 === 1
    ? expanded[mid]
    : (expanded[mid - 1] + expanded[mid]) / 2;
}

/** Build a per-item price index from all cached station markets. */
function buildPriceIndex(ctx: BotContext, excludeStation?: string): Map<string, PriceEntry> {
  const index = new Map<string, PriceEntry>();
  // Collect raw buy/sell observations for median calculation
  const buyObs = new Map<string, Array<{ price: number; volume: number }>>();
  const sellObs = new Map<string, Array<{ price: number; volume: number }>>();

  const freshness = ctx.cache.getAllMarketFreshness();
  for (const { stationId } of freshness) {
    if (stationId === excludeStation) continue;
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;
    for (const p of prices) {
      let entry = index.get(p.itemId);
      if (!entry) {
        entry = { cheapestBuy: Infinity, bestSell: 0, hasBuyVolume: false, medianBuy: 0, medianSell: 0 };
        index.set(p.itemId, entry);
      }
      if (p.buyPrice && p.buyPrice > 0) {
        if (p.buyPrice < entry.cheapestBuy) entry.cheapestBuy = p.buyPrice;
        if (p.buyVolume > 0) {
          entry.hasBuyVolume = true;
          let obs = buyObs.get(p.itemId);
          if (!obs) { obs = []; buyObs.set(p.itemId, obs); }
          obs.push({ price: p.buyPrice, volume: p.buyVolume });
        }
      }
      if (p.sellPrice && p.sellPrice > 0) {
        if (p.sellPrice > entry.bestSell) entry.bestSell = p.sellPrice;
        if (p.sellVolume > 0) {
          let obs = sellObs.get(p.itemId);
          if (!obs) { obs = []; sellObs.set(p.itemId, obs); }
          obs.push({ price: p.sellPrice, volume: p.sellVolume });
        }
      }
    }
  }

  // Compute medians
  for (const [itemId, entry] of index) {
    const buys = buyObs.get(itemId);
    if (buys) entry.medianBuy = computeMedian(buys);
    const sells = sellObs.get(itemId);
    if (sells) entry.medianSell = computeMedian(sells);
  }

  return index;
}

/** Look up best known price for an item across ALL cached stations (including home). */
function bestKnownPrice(ctx: BotContext, itemId: string, priceIdx?: Map<string, PriceEntry>): number {
  const idx = priceIdx ?? buildPriceIndex(ctx);
  const entry = idx.get(itemId);
  let best = 0;
  if (entry) {
    if (entry.cheapestBuy < Infinity) best = entry.cheapestBuy;
    if (entry.bestSell > best) best = entry.bestSell;
  }
  return best;
}

// ── Supply chain buy order tracking ──

interface BuyOrderTarget {
  itemId: string;
  itemName: string;
  quantityNeeded: number;
  maxBuyPrice: number;
  recommendedPrice: number;
  recipeIds: string[];
  expectedMargin: number;
}

interface MaterialBuyOrder {
  orderId: string;
  itemId: string;
  itemName: string;
  quantity: number;
  priceEach: number;
  placedAt: number;
  forRecipeId: string;
  maxAgeMs: number;
}

interface TrackedSellOrder {
  orderId: string;
  itemId: string;
  itemName: string;
  quantity: number;
  priceEach: number;
  placedAt: number;
  costBasis: number;
}

export async function* quartermaster(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const homeBase = getParam(ctx, "homeBase",
    ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase);
  const moduleTarget = getParam(ctx, "moduleTarget", 4);
  const undercutPct = getParam(ctx, "undercutPct", 0.05);
  const buyOrderBudgetPct = getParam(ctx, "buyOrderBudgetPct", 0.30);
  const maxOrderAge = getParam(ctx, "maxOrderAge", 7_200_000); // 2 hours

  if (!homeBase) {
    yield "no faction home base configured";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
    return;
  }

  // Navigate to faction home and dock (one-time)
  if (ctx.player.dockedAtBase !== homeBase) {
    yield `traveling to faction home`;
    try {
      await navigateAndDock(ctx, homeBase);
    } catch (err) {
      yield `failed to reach faction home: ${err instanceof Error ? err.message : String(err)}`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
      return;
    }
  }

  yield "stationed at faction home — managing commerce";

  // Resolve station name for chat ads
  let stationName = homeBase;
  const homeSystemId = ctx.galaxy.getSystemForBase(homeBase);
  if (homeSystemId) {
    const homeSys = ctx.galaxy.getSystem(homeSystemId);
    const basePoi = homeSys?.pois.find((p) => p.baseId === homeBase);
    stationName = basePoi?.baseName ?? basePoi?.name ?? homeBase;
  }

  // Track items we've already listed to avoid double-listing within a session
  const listedItems = new Set<string>();
  // Items too heavy for our cargo — skip in future cycles
  const oversizedItems = new Set<string>();
  // Track material buy orders placed this session
  const trackedMaterialOrders = new Map<string, MaterialBuyOrder>();
  // Track sell orders for price adjustment
  const trackedSellOrders = new Map<string, TrackedSellOrder>();
  // Rate-limited global chat advertisement (max 1 message per 5 minutes)
  const adState: AdChatState = { lastAdChatTime: 0, stationName };

  while (!ctx.shouldStop) {
    // Ensure still docked at home
    if (ctx.player.dockedAtBase !== homeBase) {
      try {
        await navigateAndDock(ctx, homeBase);
      } catch {
        yield "lost home dock — retrying next cycle";
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
        continue;
      }
    }

    // Scan local market
    let market: MarketOrder[] = [];
    try {
      market = await ctx.api.viewMarket();
      if (market.length > 0) {
        cacheMarketData(ctx, homeBase, market);
      }
    } catch (err) {
      yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (ctx.shouldStop) return;

    // ── Single faction storage fetch per cycle (was 4x!) ──
    let factionStorage: Array<{ itemId: string; quantity: number }> = [];
    try {
      const { items: raw } = await fleetViewFactionStorage(ctx);
      factionStorage = raw.filter((s) => s.quantity > 0);
    } catch (err) {
      yield `faction storage check failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Build price index ONCE per cycle (was 2x: sales + buy orders)
    const priceIndex = buildPriceIndex(ctx, homeBase);
    // Build cost basis cache for this cycle (was O(n²) per item)
    const costBasisCache = new Map<string, number>();

    if (ctx.shouldStop) return;

    // ── 0. CFO ROI Analysis — rank all profit paths before acting ──
    yield* runCFOAnalysis(ctx, priceIndex);

    if (ctx.shouldStop) return;

    // ── 1. Sell faction goods at competitive prices ──
    yield* manageFactionSales(ctx, homeBase, market, undercutPct, listedItems, oversizedItems, trackedSellOrders, adState, factionStorage, priceIndex, costBasisCache);

    if (ctx.shouldStop) return;

    // ── 2. Buy equipment modules for fleet ──
    yield* buyEquipmentModules(ctx, homeBase, market, moduleTarget, factionStorage);

    if (ctx.shouldStop) return;

    // ── 3. Check and collect filled buy orders ──
    // Modules bought via buy orders arrive in cargo — deposit them to faction storage
    yield* collectFilledOrders(ctx);

    if (ctx.shouldStop) return;

    // ── 4. Manage supply chain buy orders ──
    yield* manageMaterialBuyOrders(
      ctx, homeBase, market, trackedMaterialOrders,
      buyOrderBudgetPct, maxOrderAge, adState, factionStorage, priceIndex,
    );

    if (ctx.shouldStop) return;

    // ── 5. Faction facility management (check & upgrade) ──
    yield* manageFactionFacilities(ctx, factionStorage);

    if (ctx.shouldStop) return;

    await refuelIfNeeded(ctx);

    // Credit management — top up if low, deposit excess to faction
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    // Quick cycle — QM is revenue-critical, must react to market changes fast
    await interruptibleSleep(ctx, 15_000);
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "quartermaster" });
  }
}

// ════════════════════════════════════════════════════════════════════
// Faction Sales Management
// ════════════════════════════════════════════════════════════════════

/**
 * Withdraw crafted goods from faction storage and create sell orders
 * priced to attract buyers to our station.
 *
 * Strategy: price BELOW the cheapest buy price at other stations.
 * Traders see cheap goods at our station and come to buy them,
 * then resell elsewhere for profit. This stimulates faction home traffic.
 */
async function* manageFactionSales(
  ctx: BotContext,
  homeBase: string,
  localMarket: MarketOrder[],
  undercutPct: number,
  listedItems: Set<string>,
  oversizedItems: Set<string>,
  trackedSellOrders: Map<string, TrackedSellOrder>,
  adState: AdChatState,
  storageItems: Array<{ itemId: string; quantity: number }>,
  priceIndex: Map<string, PriceEntry>,
  costBasisCache: Map<string, number>,
): AsyncGenerator<RoutineYield, void, void> {
  const now = Date.now();

  if (storageItems.length === 0) {
    yield "faction storage empty";
    return;
  }

  // Get facility material needs — don't sell items needed for facility builds
  const facilityNeeds = ctx.cache.getFacilityMaterialNeeds();

  // Filter for sellable goods (not raw ores unless 5000+; modules only if excess above fleet targets)
  const sellable: Array<{ itemId: string; quantity: number }> = [];
  for (let s of storageItems) {
    // Reserve items needed for facility builds
    const facilityReserve = facilityNeeds.get(s.itemId) ?? 0;
    if (facilityReserve > 0) {
      const available = s.quantity - facilityReserve;
      if (available <= 0) continue; // All reserved for facility build
      // Only sell the excess above what's reserved
      s = { ...s, quantity: available };
    }

    const isOre = s.itemId.startsWith("ore_") || s.itemId.endsWith("_ore");
    if (isOre) {
      // Never sell raw ore — always refine through crafters first
      // Ore is worth far more as crafted goods
      continue;
    }

    // Protect strategic crafting materials from being sold
    if (PROTECTED_MATERIALS.has(s.itemId)) continue;

    if (isModuleItem(s.itemId)) {
      // Check if this module is a target type — only sell excess above target
      const target = MODULE_TARGETS.find((t) => s.itemId.includes(t.pattern));
      if (target) {
        const excess = s.quantity - target.target;
        if (excess > 0) {
          sellable.push({ itemId: s.itemId, quantity: excess });
        }
      } else {
        // Non-targeted module (weapons, shields, etc.) — sell freely
        sellable.push(s);
      }
      continue;
    }

    sellable.push(s);
  }

  // Sort sellable items: in-demand items first, then by quantity descending
  const demandItemIds = new Set<string>();
  const cachedInsights = ctx.cache.getAllCachedInsights();
  for (const insight of cachedInsights) {
    if ((insight.category === "demand" || insight.category === "arbitrage") && insight.priority >= 3) {
      demandItemIds.add(insight.item_id);
    }
  }
  sellable.sort((a, b) => {
    const aDemand = demandItemIds.has(a.itemId) ? 1 : 0;
    const bDemand = demandItemIds.has(b.itemId) ? 1 : 0;
    if (aDemand !== bDemand) return bDemand - aDemand; // Demand items first
    return b.quantity - a.quantity; // Then by quantity
  });

  if (sellable.length === 0) {
    const oreCount = storageItems.filter((s) => s.itemId.startsWith("ore_") || s.itemId.endsWith("_ore")).length;
    const modCount = storageItems.filter((s) => isModuleItem(s.itemId)).length;
    yield `faction storage: ${oreCount} ore type(s), ${modCount} module type(s) — nothing to sell`;
    return;
  }

  // Log sellable items for debugging (ore is never sellable due to L369 filter)
  if (sellable.length > 0) {
    yield `sellable goods: ${sellable.map((s) => `${s.itemId}(${s.quantity})`).join(", ")}`;
  }

  // Get competing prices at other stations
  const cachedStationIds = ctx.cache.getAllMarketFreshness()
    .map((f) => f.stationId)
    .filter((id) => id !== homeBase);

  // Check what we already have listed at our station
  const ourSellOrders = localMarket.filter(
    (o) => o.type === "sell" && o.playerId === ctx.player.id,
  );
  const alreadyListed = new Set(ourSellOrders.map((o) => o.itemId));
  const currentOrderIds = new Set(ourSellOrders.map((o) => o.id));

  // ── Reconcile tracked sell orders ──
  // Remove filled/cancelled orders (no longer in viewMarket)
  for (const [orderId, order] of trackedSellOrders) {
    if (!currentOrderIds.has(orderId)) {
      trackedSellOrders.delete(orderId);
      listedItems.delete(order.itemId);
      yield `sell order filled/cancelled: ${order.itemName} x${order.quantity}`;
    }
  }

  // Adopt untracked sell orders (from previous sessions)
  for (const order of ourSellOrders) {
    if (!trackedSellOrders.has(order.id)) {
      const costBasis = estimateCostBasis(ctx, order.itemId);
      trackedSellOrders.set(order.id, {
        orderId: order.id,
        itemId: order.itemId,
        itemName: ctx.crafting.getItemName(order.itemId) || order.itemId,
        quantity: order.remaining,
        priceEach: order.priceEach,
        placedAt: now - 600_000, // Assume 10min old if unknown
        costBasis: costBasis > 0 ? costBasis : order.priceEach,
      });
      listedItems.add(order.itemId);
    }
  }

  // ── Adjust slow sell orders (>20min unfilled) ──
  let adjustActions = 0;
  for (const [orderId, tracked] of trackedSellOrders) {
    if (ctx.shouldStop || adjustActions >= 2) break;

    const age = now - tracked.placedAt;
    if (age < 1_200_000) continue; // < 20 min — too early to adjust

    const priceResult = calculateSellPrice(ctx, tracked.itemId, tracked.costBasis, cachedStationIds, homeBase, undercutPct, priceIndex);
    if (!priceResult) continue;

    const priceDiff = Math.abs(priceResult.listPrice - tracked.priceEach) / tracked.priceEach;
    if (priceDiff < 0.10) continue; // < 10% difference — not worth a tick

    // Don't lower below 90% of cost basis (accept 10% loss max to clear inventory)
    const floorPrice = Math.max(1, Math.floor(tracked.costBasis * 0.90));
    const newPrice = Math.max(priceResult.listPrice, floorPrice);
    if (newPrice === tracked.priceEach) continue;

    try {
      await ctx.api.modifyOrder(orderId, newPrice);
      const direction = newPrice < tracked.priceEach ? "↓" : "↑";
      yield `adjusted sell order: ${tracked.itemName} ${tracked.priceEach}cr → ${newPrice}cr ${direction}`;
      tracked.priceEach = newPrice;
      tracked.placedAt = now; // Reset age after adjustment
      adjustActions++;
    } catch (err) {
      yield `sell order adjust failed for ${tracked.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Cancel stale sell orders (>30min unfilled — was 2hr, too conservative) ──
  // Shorter timeout frees listing slots for new items faster
  let cancelActions = 0;
  for (const [orderId, tracked] of trackedSellOrders) {
    if (ctx.shouldStop || cancelActions >= 3) break;

    const age = now - tracked.placedAt;
    if (age < 1_800_000) continue; // < 30 min — keep trying

    try {
      await ctx.api.cancelOrder(orderId);
      alreadyListed.delete(tracked.itemId);
      listedItems.delete(tracked.itemId);
      trackedSellOrders.delete(orderId);
      cancelActions++;
      yield `cancelled stale sell order: ${tracked.quantity}x ${tracked.itemName} @ ${tracked.priceEach}cr (>30min unfilled)`;
    } catch (err) {
      yield `cancel sell order failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  let ordersCreated = 0;

  for (const item of sellable) {
    if (ctx.shouldStop) return;

    // Skip if we already have a sell order for this item
    if (alreadyListed.has(item.itemId) || listedItems.has(item.itemId)) continue;
    // Skip items known to be too heavy for our cargo
    if (oversizedItems.has(item.itemId)) continue;

    const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;

    // Use cached cost basis (avoids repeated getAllRecipes() scans)
    let costBasis = costBasisCache.get(item.itemId);
    if (costBasis === undefined) {
      costBasis = estimateCostBasis(ctx, item.itemId);
      costBasisCache.set(item.itemId, costBasis);
    }

    if (costBasis <= 0) {
      // Fallback: use any known market price as cost basis
      const fallbackCost = bestKnownPrice(ctx, item.itemId, priceIndex);
      if (fallbackCost <= 0) continue; // Truly unknown — can't price it
    }

    const effectiveCostBasis = costBasis > 0 ? costBasis : bestKnownPrice(ctx, item.itemId, priceIndex);

    const priceResult = calculateSellPrice(ctx, item.itemId, effectiveCostBasis, cachedStationIds, homeBase, undercutPct, priceIndex);
    if (!priceResult) continue;

    let { listPrice, cheapestElsewhere } = priceResult;

    // Enforce minimum price floor for modules (max of 5x craft cost or market price)
    const moduleFloor = MODULE_MIN_PRICES[item.itemId];
    if (moduleFloor && listPrice < moduleFloor) {
      listPrice = moduleFloor;
    }

    // Skip items where per-unit revenue is essentially zero
    if (listPrice < 2) continue;

    // Withdraw from faction storage and sell/list
    const freeSpace = ctx.cargo.freeSpace(ctx.ship);
    if (freeSpace <= 0) break; // Cargo full — stop trying
    const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
    const maxBySpace = Math.floor(freeSpace / Math.max(1, itemSize));
    let listQty = Math.min(item.quantity, 50, maxBySpace); // Don't flood, respect cargo
    if (listQty <= 0) continue; // Item too heavy for remaining space
    try {
      try {
        await withdrawFromFaction(ctx, item.itemId, listQty);
      } catch (wErr: unknown) {
        // Item heavier than expected (size unknown until in cargo) — retry with less
        if (wErr instanceof Error && wErr.message.includes("cargo_full")) {
          if (listQty <= 1) {
            // Even 1 unit doesn't fit — permanently skip this item
            oversizedItems.add(item.itemId);
            yield `${itemName} too heavy for cargo (${freeSpace} free) — skipping`;
            continue;
          }
          listQty = Math.max(1, Math.floor(listQty / 3));
          try {
            await withdrawFromFaction(ctx, item.itemId, listQty);
          } catch (wErr2: unknown) {
            if (wErr2 instanceof Error && wErr2.message.includes("cargo_full")) {
              oversizedItems.add(item.itemId);
              yield `${itemName} too heavy for cargo — skipping`;
              continue;
            }
            throw wErr2;
          }
        } else if (wErr instanceof Error && (
          wErr.message.includes("insufficient_storage") ||
          wErr.message.includes("insufficient_items")
        )) {
          // Item was withdrawn by another bot since our snapshot — skip silently
          yield `${itemName}: no longer in faction storage — skipped`;
          continue;
        } else {
          throw wErr;
        }
      }
      await ctx.refreshState();

      const inCargo = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
      if (inCargo <= 0) {
        yield `withdraw failed: ${itemName} not in cargo after withdrawal`;
        continue;
      }

      const sellQty = Math.min(inCargo, listQty);

      // Try direct sell first — but skip for modules with a price floor
      // (don't dump crafted modules at whatever the station offers)
      const hasFloor = MODULE_MIN_PRICES[item.itemId] != null;
      const directResult = hasFloor
        ? { quantity: 0, total: 0, priceEach: 0 }
        : await ctx.api.sell(item.itemId, sellQty);
      if (!hasFloor) await ctx.refreshState();

      if (directResult.total > 0) {
        yield `sold ${directResult.quantity} ${itemName} @ ${directResult.priceEach}cr (${directResult.total}cr) — direct sell`;
        ordersCreated++;
        // Emit trade event for logging/tracking
        ctx.eventBus.emit({
          type: "trade_sell", botId: ctx.botId, itemId: item.itemId, quantity: directResult.quantity,
          priceEach: directResult.priceEach, total: directResult.total,
          stationId: ctx.player.dockedAtBase ?? "",
        });

        // Re-deposit leftover (partial fill or cargo items)
        const remaining = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        if (remaining > 0) {
          try {
            await ctx.api.factionDepositItems(item.itemId, remaining);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
          } catch { /* best effort */ }
        }
      } else {
        // No NPC buyer at this station — create a sell order as fallback
        // Check if ANY station has buy orders for this item (someone wants it)
        const hasBuyOrders = priceIndex.get(item.itemId)?.hasBuyVolume ?? false;

        // Items to dump at any price (list once to clear stock, never craft more)
        const DUMP_ITEMS = new Set(["crimson_bloodwine"]);
        // List if: buy orders exist anywhere (demand confirmed), per-unit price is reasonable, or dump item
        const worthListing = hasBuyOrders || listPrice >= 10 || DUMP_ITEMS.has(item.itemId);
        if (worthListing) {
          // Re-deposit to faction storage first, then create faction sell order
          try {
            await ctx.api.factionDepositItems(item.itemId, sellQty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
          } catch { /* best effort — may already be deposited */ }

          let result: Record<string, unknown>;
          try {
            result = await ctx.api.factionCreateSellOrder(item.itemId, listPrice, sellQty);
          } catch {
            // Faction orders not supported — fall back to personal sell order
            try {
              await withdrawFromFaction(ctx, item.itemId, sellQty);
              await ctx.refreshState();
            } catch { /* ok */ }
            result = await ctx.api.createSellOrder(item.itemId, sellQty, listPrice) as Record<string, unknown>;
          }
          await ctx.refreshState();

          // Track the sell order for future price adjustments
          const orderId = String(
            (result as Record<string, unknown>).order_id ??
            (result as Record<string, unknown>).id ??
            `pending_sell_${item.itemId}_${now}`,
          );
          trackedSellOrders.set(orderId, {
            orderId,
            itemId: item.itemId,
            itemName,
            quantity: sellQty,
            priceEach: listPrice,
            placedAt: now,
            costBasis: effectiveCostBasis,
          });

          const margin = listPrice - effectiveCostBasis;
          const vsCompetitor = cheapestElsewhere < Infinity
            ? ` (${Math.round(undercutPct * 100)}% below ${cheapestElsewhere}cr elsewhere)`
            : "";
          yield `listed ${sellQty} ${itemName} @ ${listPrice}cr/ea (+${margin}cr margin)${vsCompetitor}`;

          listedItems.add(item.itemId);
          ordersCreated++;
          await advertiseInChat(ctx, `Selling ${sellQty}x ${itemName} @ ${listPrice}cr`, adState);
        } else {
          // Not worth listing — re-deposit to faction storage
          try {
            await ctx.api.factionDepositItems(item.itemId, sellQty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
          } catch { /* best effort */ }
          yield `${itemName} — no demand, per-unit value too low (${listPrice}cr/ea)`;
        }
      }

      // Up to 5 actions per cycle (game allows 1 mutation per 10s tick = 6/min max)
      if (ordersCreated >= 5) break;
    } catch (err) {
      yield `sell order failed for ${itemName}: ${err instanceof Error ? err.message : String(err)}`;
      // Re-deposit anything stuck in cargo
      const leftover = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
      if (leftover > 0) {
        try {
          await ctx.api.factionDepositItems(item.itemId, leftover);
          ctx.cache.invalidateFactionStorage();
          await ctx.refreshState();
        } catch { /* best effort */ }
      }
    }
  }

  if (ordersCreated === 0 && sellable.length > 0) {
    // Check if any sellable items have demand at OTHER stations (cross-station intel)
    const remoteDemand: Array<{ itemId: string; stationId: string; price: number; volume: number }> = [];
    const allFreshness = ctx.cache.getAllMarketFreshness();
    for (const item of sellable) {
      for (const { stationId } of allFreshness) {
        if (stationId === homeBase) continue;
        const prices = ctx.cache.getMarketPrices(stationId);
        if (!prices) continue;
        const match = prices.find((p) => p.itemId === item.itemId && p.sellPrice && p.sellPrice > 0 && p.sellVolume > 0);
        if (match) {
          remoteDemand.push({ itemId: item.itemId, stationId, price: match.sellPrice!, volume: match.sellVolume });
        }
      }
    }

    if (remoteDemand.length > 0) {
      // Deduplicate: best price per item
      const bestByItem = new Map<string, { stationId: string; price: number; volume: number }>();
      for (const rd of remoteDemand) {
        const existing = bestByItem.get(rd.itemId);
        if (!existing || rd.price > existing.price) {
          bestByItem.set(rd.itemId, rd);
        }
      }
      const tips = [...bestByItem.entries()]
        .sort((a, b) => b[1].price * b[1].volume - a[1].price * a[1].volume)
        .slice(0, 5);
      yield `${sellable.length} sellable item(s) — no local buyers, but ${bestByItem.size} item(s) have remote demand:`;
      for (const [itemId, info] of tips) {
        yield `  → ${itemId} @ ${info.price}cr (${info.volume} wanted) at ${info.stationId.replace(/_/g, " ")}`;
      }
    } else {
      yield `${sellable.length} sellable item(s) in faction — no profitable listings found (local or remote)`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Equipment Module Purchasing
// ════════════════════════════════════════════════════════════════════

/**
 * Slowly buy equipment modules and stockpile in faction storage.
 * Buys at most ONE module per cycle to conserve credits.
 */
async function* buyEquipmentModules(
  ctx: BotContext,
  _homeBase: string,
  localMarket: MarketOrder[],
  targetCount: number,
  storageItems: Array<{ itemId: string; quantity: number }>,
): AsyncGenerator<RoutineYield, void, void> {

  // Count modules per target type (faction storage + equipped on fleet bots)
  const fleet = ctx.getFleetStatus();
  const targets = MODULE_TARGETS.map((t) => {
    const inStorage = storageItems
      .filter((s) => s.itemId.includes(t.pattern))
      .reduce((sum, s) => sum + s.quantity, 0);
    const equippedOnBots = fleet.bots
      .filter((b) => b.moduleIds.some((m) => m.includes(t.pattern)))
      .length;
    // Count our sell orders on the market (items listed but not yet sold)
    const listedForSale = localMarket
      .filter((o) => o.itemId.includes(t.pattern) && o.type === "sell")
      .reduce((sum, o) => sum + o.quantity, 0);
    return {
      ...t,
      target: Math.min(t.target, targetCount), // Respect param override
      count: inStorage + equippedOnBots + listedForSale,
      inStorage,
      equippedOnBots,
    };
  });

  // Report inventory
  const inv = targets.map((t) => {
    const listed = t.count - t.inStorage - t.equippedOnBots;
    return `${t.label}: ${t.count}/${t.target} (${t.inStorage} stored, ${t.equippedOnBots} equipped${listed > 0 ? `, ${listed} listed` : ""})`;
  }).join(", ");
  yield `modules: ${inv}`;

  // Find what's still needed
  const needed = targets.filter((t) => t.count < t.target);
  if (needed.length === 0) {
    yield "all module targets met";
    return;
  }

  // Budget: keep a 2000cr reserve, spend the rest on modules
  // Module buying is the quartermaster's primary job — don't be stingy
  const reserve = 2000;
  const budget = Math.max(0, ctx.player.credits - reserve);
  if (budget < 100) {
    yield `low credits (${ctx.player.credits}cr, reserve ${reserve}cr) — skipping module purchases`;
    return;
  }

  // Try to buy ONE module (most needed first = lowest count/target ratio)
  needed.sort((a, b) => (a.count / a.target) - (b.count / b.target));

  for (const target of needed) {
    if (ctx.shouldStop) return;

    // Check local market for this module
    const available = localMarket
      .filter((o) =>
        o.type === "sell"
        && o.quantity > 0
        && o.itemId.includes(target.pattern),
      )
      .sort((a, b) => a.priceEach - b.priceEach);

    if (available.length > 0) {
      const cheapest = available[0];
      if (cheapest.priceEach <= budget) {
        try {
          const result = await ctx.api.buy(cheapest.itemId, 1);
          await ctx.refreshState();

          if (result.quantity > 0) {
            // Deposit to faction storage
            try {
              await ctx.api.factionDepositItems(cheapest.itemId, 1);
              ctx.cache.invalidateFactionStorage();
              await ctx.refreshState();
              yield `bought & stored 1x ${target.label} @ ${result.priceEach || cheapest.priceEach}cr (${target.count + 1}/${target.target})`;
            } catch {
              yield `bought 1x ${target.label} @ ${result.priceEach || cheapest.priceEach}cr (in cargo — deposit failed)`;
            }
            return; // One purchase per cycle
          }
        } catch (err) {
          yield `buy failed for ${target.label}: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        yield `${target.label} @ ${cheapest.priceEach}cr exceeds budget (${budget}cr)`;
      }
    } else {
      yield `${target.label}: not in stock at this station`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Filled Order Collection
// ════════════════════════════════════════════════════════════════════

/**
 * Check cargo for module items that arrived via filled buy orders.
 * Deposit them to faction storage so fleet bots can withdraw and equip.
 */
async function* collectFilledOrders(
  ctx: BotContext,
): AsyncGenerator<RoutineYield, void, void> {
  await ctx.refreshState();
  const moduleItems = ctx.ship.cargo.filter(item => isModuleItem(item.itemId));
  if (moduleItems.length === 0) return;

  let deposited = 0;
  for (const item of moduleItems) {
    if (ctx.shouldStop) return;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      ctx.cache.invalidateFactionStorage();
      deposited++;
      yield `deposited ${item.quantity}x ${item.itemId} to faction storage (filled order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Single refreshState after all deposits (was 1 per item)
  if (deposited > 0) await ctx.refreshState();
}

// ════════════════════════════════════════════════════════════════════
// Supply Chain Buy Orders
// ════════════════════════════════════════════════════════════════════

/**
 * Manage buy orders for supply chain gap materials.
 * Gap materials are recipe inputs the fleet can't mine or craft internally.
 *
 * Flow: Reconcile filled orders → cancel stale → adjust slow prices → place new.
 * Action budget: max 2 new + 1 cancel + 1 modify = 4 ticks per cycle.
 */
async function* manageMaterialBuyOrders(
  ctx: BotContext,
  _homeBase: string,
  _localMarket: MarketOrder[],
  tracked: Map<string, MaterialBuyOrder>,
  budgetPct: number,
  maxAge: number,
  adState: AdChatState,
  storageItems: Array<{ itemId: string; quantity: number }>,
  buyPriceIndex: Map<string, PriceEntry>,
): AsyncGenerator<RoutineYield, void, void> {
  const now = Date.now();
  let actionsThisCycle = 0;
  const MAX_ACTIONS = 4;

  // ── Reconcile: check current orders vs tracked ──
  let myBuyOrders: MarketOrder[] = [];
  try {
    const allOrders = await ctx.api.viewOrders();
    myBuyOrders = allOrders.filter(
      (o) => o.type === "buy" && o.playerId === ctx.player.id,
    );
  } catch (err) {
    yield `order check failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  const currentOrderIds = new Set(myBuyOrders.map((o) => o.id));

  // Detect fully filled orders (tracked but no longer in viewOrders)
  for (const [orderId, order] of tracked) {
    if (!currentOrderIds.has(orderId)) {
      tracked.delete(orderId);
      yield `buy order filled: ${order.itemName} x${order.quantity}`;
    }
  }

  // Adopt untracked buy orders (from previous sessions or API tracking gaps)
  for (const order of myBuyOrders) {
    if (!tracked.has(order.id) && !isModuleItem(order.itemId)) {
      tracked.set(order.id, {
        orderId: order.id,
        itemId: order.itemId,
        itemName: order.itemName,
        quantity: order.remaining,
        priceEach: order.priceEach,
        placedAt: now - 600_000, // Assume 10min old if unknown
        forRecipeId: "",
        maxAgeMs: maxAge,
      });
      yield `adopted existing buy order: ${order.itemName} x${order.remaining} @ ${order.priceEach}cr`;
    }
  }

  // Deposit any non-module material items in cargo to faction storage (from filled orders)
  await ctx.refreshState();
  const materialsInCargo = ctx.ship.cargo.filter(item =>
    !isModuleItem(item.itemId)
    && !item.itemId.startsWith("ore_")
    && !item.itemId.endsWith("_ore")
  );
  let matDeposits = 0;
  for (const item of materialsInCargo) {
    if (ctx.shouldStop) return;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      ctx.cache.invalidateFactionStorage();
      matDeposits++;
      const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;
      yield `deposited ${item.quantity}x ${itemName} to faction (from buy order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // Single refreshState after all material deposits (was 1 per item)
  if (matDeposits > 0) await ctx.refreshState();

  // Update tracking for partially filled orders
  for (const order of myBuyOrders) {
    const t = tracked.get(order.id);
    if (t && order.remaining < t.quantity) {
      const filled = t.quantity - order.remaining;
      yield `buy order partial fill: ${t.itemName} x${filled}/${t.quantity}`;
      t.quantity = order.remaining;
    }
  }

  // Use shared faction storage snapshot (fetched once per cycle)
  const factionStock = new Map<string, number>();
  for (const s of storageItems) {
    factionStock.set(s.itemId, s.quantity);
  }

  // ── Cancel stale orders ──
  for (const [orderId, order] of tracked) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS) break;

    const age = now - order.placedAt;
    const stock = factionStock.get(order.itemId) ?? 0;

    if (age > order.maxAgeMs || stock >= 20) {
      try {
        await ctx.api.cancelOrder(orderId);
        tracked.delete(orderId);
        actionsThisCycle++;
        const reason = stock >= 20 ? "sufficient stock" : "expired";
        yield `cancelled buy order: ${order.itemName} (${reason})`;
      } catch (err) {
        yield `cancel failed for ${order.itemName}: ${err instanceof Error ? err.message : String(err)}`;
      }
      break; // Max 1 cancel per cycle
    }
  }

  // ── Adjust prices on slow orders (>30min without fills) ──
  for (const [orderId, order] of tracked) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS) break;

    const age = now - order.placedAt;
    if (age < 1_200_000) continue; // < 20 min — too early to adjust

    // Need a recipe context to recalculate price
    if (!order.forRecipeId) continue;
    const recipe = ctx.crafting.getRecipe(order.forRecipeId);
    if (!recipe) continue;

    const priceInfo = calculateBuyPrice(ctx, order.itemId, recipe, buyPriceIndex);
    if (!priceInfo) continue;

    const priceDiff = Math.abs(priceInfo.recommendedPrice - order.priceEach) / order.priceEach;
    if (priceDiff < 0.10) continue; // < 10% difference — not worth a tick

    try {
      await ctx.api.modifyOrder(orderId, priceInfo.recommendedPrice);
      order.priceEach = priceInfo.recommendedPrice;
      order.placedAt = now; // Reset age after adjustment
      actionsThisCycle++;
      yield `adjusted buy order: ${order.itemName} → ${priceInfo.recommendedPrice}cr`;
    } catch (err) {
      yield `modify failed for ${order.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
    break; // Max 1 modify per cycle
  }

  // ── Place new orders ──
  const reserve = 2000;
  const totalBudget = Math.max(0, (ctx.player.credits - reserve) * budgetPct);
  const outstandingValue = [...tracked.values()].reduce(
    (sum, o) => sum + o.priceEach * o.quantity, 0,
  );
  let remainingBudget = totalBudget - outstandingValue;
  const perOrderCap = totalBudget * 0.15;

  if (remainingBudget < 100) {
    if (tracked.size > 0) {
      yield `buy orders: ${tracked.size} active, budget exhausted`;
    }
    return;
  }

  const orderedItems = new Set([...tracked.values()].map((o) => o.itemId));
  const targets = identifyBuyOrderTargets(ctx, factionStock, remainingBudget, buyPriceIndex);
  let newOrdersPlaced = 0;

  for (const target of targets) {
    if (ctx.shouldStop || actionsThisCycle >= MAX_ACTIONS || newOrdersPlaced >= 2) break;
    if (orderedItems.has(target.itemId)) continue;

    // Calculate order size within budget
    const maxByBudget = Math.floor(Math.min(remainingBudget, perOrderCap) / target.recommendedPrice);
    const buyQty = Math.min(target.quantityNeeded, maxByBudget);
    if (buyQty <= 0 || target.recommendedPrice <= 0) continue;

    const orderCost = target.recommendedPrice * buyQty;

    try {
      // Prefer faction buy orders (funded from faction treasury, better visibility)
      let result: Record<string, unknown>;
      try {
        result = await ctx.api.factionCreateBuyOrder(target.itemId, target.recommendedPrice, buyQty);
      } catch {
        // Faction buy order not supported — fall back to personal buy order
        result = await ctx.api.createBuyOrder(target.itemId, buyQty, target.recommendedPrice) as Record<string, unknown>;
      }
      const orderId = String(
        (result as Record<string, unknown>).order_id ??
        (result as Record<string, unknown>).id ??
        `pending_${target.itemId}_${now}`,
      );

      tracked.set(orderId, {
        orderId,
        itemId: target.itemId,
        itemName: target.itemName,
        quantity: buyQty,
        priceEach: target.recommendedPrice,
        placedAt: now,
        forRecipeId: target.recipeIds[0],
        maxAgeMs: maxAge,
      });

      remainingBudget -= orderCost;
      actionsThisCycle++;
      newOrdersPlaced++;

      yield `placed buy order: ${buyQty}x ${target.itemName} @ ${target.recommendedPrice}cr (${orderCost}cr total)`;
      await advertiseInChat(ctx, `Buying ${buyQty}x ${target.itemName} @ ${target.recommendedPrice}cr`, adState);
    } catch (err) {
      yield `buy order failed for ${target.itemName}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (tracked.size > 0) {
    yield `buy orders: ${tracked.size} active, ${Math.floor(remainingBudget)}cr budget remaining`;
  }
}

/**
 * Identify materials to buy — both gap materials AND ores when stock is low.
 * Prioritizes in-demand items using market insights.
 *
 * Strategy:
 * - Gap materials: recipe inputs that aren't ores and aren't craftable (same as before)
 * - Ores: buy at ~50% market rate when faction stock is low (<50 units)
 *   and the ore is needed for profitable recipes
 * - Demand boost: items with high-priority market insights get priority bump
 *
 * Returns top 8 targets sorted by expected margin × demand priority.
 */
function identifyBuyOrderTargets(
  ctx: BotContext,
  factionStock: Map<string, number>,
  _budget: number,
  priceIdx?: Map<string, PriceEntry>,
): BuyOrderTarget[] {
  const recipes = ctx.crafting.getAllRecipes();
  const idx = priceIdx ?? buildPriceIndex(ctx);
  const targets = new Map<string, BuyOrderTarget>();

  // Collect market demand insights for priority boosting
  const demandItems = new Set<string>();
  const allInsights = ctx.cache.getAllCachedInsights();
  for (const insight of allInsights) {
    if ((insight.category === "demand" || insight.category === "arbitrage") && insight.priority >= 3) {
      demandItems.add(insight.item_id);
    }
  }

  // Track which ores are needed by profitable recipes (and how much margin they generate)
  const oreRecipeMargins = new Map<string, number>(); // oreId → best recipe margin

  for (const recipe of recipes) {
    const { profit } = ctx.crafting.estimateMarketProfit(recipe.id);
    if (profit <= 0) continue;

    // Check if this recipe's output is in demand — boost its inputs
    const outputInDemand = demandItems.has(recipe.outputItem);

    const rawMaterials = ctx.crafting.getRawMaterials(recipe.id);

    for (const [itemId, _qty] of rawMaterials) {
      const isOre = itemId.startsWith("ore_") || itemId.endsWith("_ore");

      if (isOre) {
        // Track ore → recipe margin for ore buy order decisions
        const existing = oreRecipeMargins.get(itemId) ?? 0;
        const boostedProfit = outputInDemand ? profit * 1.5 : profit;
        if (boostedProfit > existing) oreRecipeMargins.set(itemId, boostedProfit);
        continue;
      }

      // Skip craftable items (crafters handle these)
      if (ctx.crafting.isCraftable(itemId)) continue;

      // Check faction stock — skip if well-stocked
      const stock = factionStock.get(itemId) ?? 0;
      if (stock >= 20) continue;

      const quantityNeeded = Math.max(1, 20 - stock);

      // Calculate price from recipe profitability
      const priceInfo = calculateBuyPrice(ctx, itemId, recipe, idx);
      if (!priceInfo) continue;

      // Demand boost: items whose recipe output is in demand get higher margin score
      const demandMultiplier = (outputInDemand || demandItems.has(itemId)) ? 1.5 : 1.0;

      const existing = targets.get(itemId);
      if (existing) {
        existing.recipeIds.push(recipe.id);
        if (priceInfo.maxBuyPrice < existing.maxBuyPrice) {
          existing.maxBuyPrice = priceInfo.maxBuyPrice;
          existing.recommendedPrice = priceInfo.recommendedPrice;
          existing.expectedMargin = priceInfo.expectedMargin * demandMultiplier;
        }
      } else {
        targets.set(itemId, {
          itemId,
          itemName: ctx.crafting.getItemName(itemId) || itemId,
          quantityNeeded,
          maxBuyPrice: priceInfo.maxBuyPrice,
          recommendedPrice: priceInfo.recommendedPrice,
          recipeIds: [recipe.id],
          expectedMargin: priceInfo.expectedMargin * demandMultiplier,
        });
      }
    }
  }

  // ── Ore buy orders: buy ores at ~50% market rate when stock is low ──
  const ORE_LOW_STOCK = 50;   // Below this, place buy orders
  const ORE_TARGET_STOCK = 100; // Buy up to this amount
  const ORE_PRICE_FRACTION = 0.50; // Buy at 50% of market rate

  for (const [oreId, recipeMargin] of oreRecipeMargins) {
    const stock = factionStock.get(oreId) ?? 0;
    if (stock >= ORE_LOW_STOCK) continue; // Miners are keeping up

    const quantityNeeded = Math.min(ORE_TARGET_STOCK - stock, 50); // Cap per order
    if (quantityNeeded <= 0) continue;

    // Find market price for this ore
    const entry = idx.get(oreId);
    const marketPrice = entry?.medianBuy ?? entry?.cheapestBuy ?? 0;
    if (!marketPrice || marketPrice === Infinity) continue;

    // Buy at 50% of going market rate — cheap enough to still profit after crafting
    const buyPrice = Math.max(1, Math.floor(marketPrice * ORE_PRICE_FRACTION));

    // Sanity: don't buy ore for more than the recipe can justify
    // Use 30% of recipe margin as max ore spend
    const maxOreSpend = Math.floor(recipeMargin * 0.30);
    if (buyPrice > maxOreSpend && maxOreSpend > 0) continue;

    // Hard cap on ore buy price
    if (buyPrice > MAX_MATERIAL_BUY_PRICE) continue;

    const demandMultiplier = demandItems.has(oreId) ? 1.5 : 1.0;

    targets.set(oreId, {
      itemId: oreId,
      itemName: ctx.crafting.getItemName(oreId) || oreId.replace(/_/g, " "),
      quantityNeeded,
      maxBuyPrice: buyPrice,
      recommendedPrice: buyPrice,
      recipeIds: [],
      expectedMargin: recipeMargin * demandMultiplier,
    });
  }

  return [...targets.values()]
    .sort((a, b) => b.expectedMargin - a.expectedMargin)
    .slice(0, 8);
}

/**
 * Calculate the maximum profitable buy price for a gap material
 * in the context of a specific recipe.
 *
 * Pricing strategy:
 *   maxBuyPrice = (endProductSellPrice - otherInputCosts) / qtyNeeded * 0.70  (30% margin)
 *   attractivePrice = min(cheapestSellPrice * 0.92, catalogBasePrice)
 *   finalPrice = min(maxBuyPrice, attractivePrice)
 *   floor = catalogBasePrice * 0.50  (don't lowball too hard)
 */
function calculateBuyPrice(
  ctx: BotContext,
  gapItemId: string,
  recipe: Recipe,
  priceIdx?: Map<string, PriceEntry>,
): { maxBuyPrice: number; recommendedPrice: number; expectedMargin: number } | null {
  const rawMaterials = ctx.crafting.getRawMaterials(recipe.id);
  const gapQty = rawMaterials.get(gapItemId);
  if (!gapQty || gapQty <= 0) return null;

  // End product sell price
  const endProductPrice = ctx.crafting.getItemBasePrice(recipe.outputItem) * recipe.outputQuantity;

  // Cost of all other raw materials
  let otherCosts = 0;
  for (const [itemId, qty] of rawMaterials) {
    if (itemId === gapItemId) continue;
    otherCosts += ctx.crafting.getItemBasePrice(itemId) * qty;
  }

  // Max buy price with 30% margin
  const maxBuyPrice = Math.floor((endProductPrice - otherCosts) / gapQty * 0.70);
  if (maxBuyPrice <= 0) return null;

  // Find cheapest sell price across all cached stations (O(1) via index)
  const idx = priceIdx ?? buildPriceIndex(ctx);
  const gapEntry = idx.get(gapItemId);
  const cheapestSellPrice = gapEntry?.cheapestBuy ?? Infinity;

  const catalogPrice = ctx.crafting.getItemBasePrice(gapItemId);
  if (catalogPrice <= 0) return null;

  // Attractive price: undercut market or use catalog
  const attractivePrice = cheapestSellPrice < Infinity
    ? Math.min(Math.floor(cheapestSellPrice * 0.92), catalogPrice)
    : catalogPrice;

  // Final price: lower of max and attractive
  const finalPrice = Math.min(maxBuyPrice, attractivePrice);

  // Hard cap: never place buy orders above material safety price
  if (finalPrice > MAX_MATERIAL_BUY_PRICE) return null;

  // Floor: don't lowball too hard
  const floor = Math.floor(catalogPrice * 0.50);
  if (finalPrice < floor || finalPrice <= 0) return null;

  const expectedMargin = endProductPrice - otherCosts - (finalPrice * gapQty);

  return { maxBuyPrice, recommendedPrice: finalPrice, expectedMargin };
}

// ════════════════════════════════════════════════════════════════════
// Faction Facility Management
// ════════════════════════════════════════════════════════════════════

/**
 * Check faction facilities at the home station and upgrade if possible.
 * Runs once per cycle — builds essential missing facilities, then checks
 * existing facilities for available upgrades. Max one build/upgrade per cycle.
 */
async function* manageFactionFacilities(
  ctx: BotContext,
  sharedStorage: Array<{ itemId: string; quantity: number }>,
): AsyncGenerator<RoutineYield, void, void> {
  if (!ctx.player.dockedAtBase) return;

  // User-queued facilities + essential prereqs (faction_quarters is always needed first)
  const userQueue = ctx.fleetConfig.facilityBuildQueue ?? [];
  const ESSENTIAL_FACILITIES = [
    "faction_quarters",     // Common Space — prerequisite for most others
    ...userQueue.filter(f => f !== "faction_quarters"),
  ];

  // Check faction treasury
  let factionCredits = 0;
  try {
    factionCredits = (await fleetViewFactionStorage(ctx)).credits;
  } catch { /* ok */ }

  // List existing faction facilities at this station
  let facilities: Array<Record<string, unknown>> = [];
  try {
    facilities = await ctx.api.factionListFacilities();
  } catch { /* no access */ }

  const existingTypes = new Set(
    facilities.map(f => String(f.type ?? f.facility_type ?? ""))
  );

  // Use shared faction storage snapshot (fetched once per cycle)
  const storageMap = new Map(sharedStorage.map(s => [s.itemId, s.quantity]));

  // Accumulate material needs across all queued facilities
  const allMaterialNeeds = new Map<string, number>();

  // ── Build missing essential facilities ──
  for (const facilityType of ESSENTIAL_FACILITIES) {
    if (ctx.shouldStop) return;
    if (existingTypes.has(facilityType)) continue;

    // Check if we can afford it (query facility types for cost + materials)
    let buildCost = 0;
    let materials: Array<{ itemId: string; quantity: number }> = [];
    try {
      const types = await ctx.api.facilityTypes({ name: facilityType.replace(/^faction_/, "") });
      const typeInfo = types.find(t =>
        String(t.id ?? t.type_id ?? t.facility_type ?? "") === facilityType
        || String(t.id ?? "").includes(facilityType.replace("faction_", ""))
      );
      if (typeInfo) {
        buildCost = Number(typeInfo.cost ?? typeInfo.credits ?? typeInfo.build_cost ?? 0);
        // Extract material requirements (API may use various field names)
        const rawMats = typeInfo.materials ?? typeInfo.requirements ?? typeInfo.build_materials ?? typeInfo.material_cost ?? [];
        if (Array.isArray(rawMats)) {
          for (const m of rawMats) {
            const mObj = m as Record<string, unknown>;
            const itemId = String(mObj.item_id ?? mObj.itemId ?? mObj.id ?? "");
            const qty = Number(mObj.quantity ?? mObj.amount ?? mObj.count ?? 0);
            if (itemId && qty > 0) materials.push({ itemId, quantity: qty });
          }
        } else if (rawMats && typeof rawMats === "object") {
          // Object form: { steel_plate: 100, ... }
          for (const [itemId, qty] of Object.entries(rawMats as Record<string, unknown>)) {
            const n = Number(qty);
            if (n > 0) materials.push({ itemId, quantity: n });
          }
        }
      }
    } catch { /* cost unknown — try anyway */ }

    // Track material needs (deficit = required - current storage)
    for (const mat of materials) {
      const inStorage = storageMap.get(mat.itemId) ?? 0;
      const deficit = Math.max(0, mat.quantity - inStorage);
      if (deficit > 0) {
        allMaterialNeeds.set(mat.itemId, (allMaterialNeeds.get(mat.itemId) ?? 0) + deficit);
      }
    }

    // Require 2x cost as reserve (or just try if cost is unknown)
    if (buildCost > 0 && factionCredits < buildCost * 2) {
      yield `${facilityType.replace(/_/g, " ")} needs ${buildCost}cr — faction has ${factionCredits}cr`;
      continue;
    }

    // Check if we have enough materials — try to buy missing ones from market
    const missingMats = materials.filter(m => (storageMap.get(m.itemId) ?? 0) < m.quantity);
    if (missingMats.length > 0) {
      // Attempt to buy missing materials from local market
      let allAcquired = true;
      for (const mat of missingMats) {
        const have = storageMap.get(mat.itemId) ?? 0;
        const need = mat.quantity - have;
        if (need <= 0) continue;

        try {
          const est = await ctx.api.estimatePurchase(mat.itemId, need);
          const available = (est as any).available ?? 0;
          const cost = (est as any).total_cost ?? 0;
          // Buy if available and affordable (max 30% of faction credits)
          if (available > 0 && cost < factionCredits * 0.3) {
            const buyQty = Math.min(available, need);
            await ctx.api.buy(mat.itemId, buyQty);
            await ctx.refreshState();
            // Deposit to faction storage
            await ctx.api.factionDepositItems(mat.itemId, buyQty);
            await ctx.refreshState();
            storageMap.set(mat.itemId, (storageMap.get(mat.itemId) ?? 0) + buyQty);
            yield `bought ${buyQty}x ${ctx.crafting.getItemName(mat.itemId)} for facility (${cost}cr)`;
          } else if (available === 0) {
            allAcquired = false;
          } else {
            allAcquired = false;
            yield `${ctx.crafting.getItemName(mat.itemId)} too expensive: ${cost}cr for ${available} units`;
          }
        } catch {
          allAcquired = false;
        }
      }

      // Re-check after buying
      const stillMissing = materials.filter(m => (storageMap.get(m.itemId) ?? 0) < m.quantity);
      if (stillMissing.length > 0) {
        const matList = stillMissing.map(m => {
          const have = storageMap.get(m.itemId) ?? 0;
          return `${ctx.crafting.getItemName(m.itemId)}: ${have}/${m.quantity}`;
        }).join(", ");
        yield `${facilityType.replace(/_/g, " ")} still needs materials: ${matList}`;
        continue;
      }
    }

    yield `building ${facilityType.replace(/_/g, " ")}${buildCost > 0 ? ` (${buildCost}cr)` : ""}`;
    try {
      await ctx.api.factionFacilityBuild(facilityType);
      await ctx.refreshState();
      // Remove from build queue on success
      const qi = ctx.fleetConfig.facilityBuildQueue.indexOf(facilityType);
      if (qi >= 0) ctx.fleetConfig.facilityBuildQueue.splice(qi, 1);
      yield `built ${facilityType.replace(/_/g, " ")} successfully`;
      // Clear material needs for this facility (they were consumed)
      for (const mat of materials) allMaterialNeeds.delete(mat.itemId);
      ctx.cache.setFacilityMaterialNeeds(allMaterialNeeds);
      return; // Max one build per cycle (rate limited)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Skip if already exists (another bot built it) or if we lack permissions
      if (msg.includes("already") || msg.includes("exists")) {
        existingTypes.add(facilityType);
        const qi2 = ctx.fleetConfig.facilityBuildQueue.indexOf(facilityType);
        if (qi2 >= 0) ctx.fleetConfig.facilityBuildQueue.splice(qi2, 1);
        continue;
      }
      // Skip if prerequisite not met (e.g., need faction_quarters first)
      if (msg.includes("prerequisite") || msg.includes("requires")) {
        yield `${facilityType.replace(/_/g, " ")}: ${msg}`;
        continue;
      }
      // Parse material requirements from error message (e.g., "needs 100 steel_plate")
      const matMatch = msg.match(/needs?\s+(\d+)\s+(\w+)/gi);
      if (matMatch) {
        for (const m of matMatch) {
          const parts = m.match(/(\d+)\s+(\w+)/);
          if (parts) {
            const qty = Number(parts[1]);
            const itemId = parts[2];
            if (qty > 0 && itemId !== "cr" && itemId !== "credits") {
              const inStorage = storageMap.get(itemId) ?? 0;
              const deficit = Math.max(0, qty - inStorage);
              if (deficit > 0) {
                allMaterialNeeds.set(itemId, (allMaterialNeeds.get(itemId) ?? 0) + deficit);
              }
            }
          }
        }
      }
      yield `build failed: ${msg}`;
      return; // Don't spam builds on unexpected errors
    }
  }

  // Store accumulated material needs for crafters and sales filtering
  ctx.cache.setFacilityMaterialNeeds(allMaterialNeeds);
  if (allMaterialNeeds.size > 0) {
    const needsList = [...allMaterialNeeds.entries()]
      .map(([id, qty]) => `${qty}x ${ctx.crafting.getItemName(id)}`)
      .join(", ");
    yield `facility material needs: ${needsList}`;
  }

  // ── Upgrade existing facilities ──
  if (facilities.length === 0) {
    // Re-fetch after possible builds
    try {
      facilities = await ctx.api.factionListFacilities();
    } catch { return; }
  }

  for (const fac of facilities) {
    if (ctx.shouldStop) return;

    const facId = String(fac.id ?? fac.facility_id ?? "");
    const facName = String(fac.name ?? fac.type ?? "facility");
    const facLevel = Number(fac.level ?? fac.tier ?? 1);

    if (!facId) continue;

    let upgradeInfo: Record<string, unknown>;
    try {
      upgradeInfo = await ctx.api.facilityUpgrades(facId);
    } catch {
      continue;
    }

    const upgrades = (upgradeInfo.upgrades ?? upgradeInfo.available ?? []) as Array<Record<string, unknown>>;
    if (upgrades.length === 0) continue;

    const nextUpgrade = upgrades[0];
    const upgradeCost = Number(nextUpgrade.cost ?? nextUpgrade.credits ?? nextUpgrade.price ?? 0);
    const upgradeType = String(nextUpgrade.type ?? nextUpgrade.facility_type ?? "");
    const upgradeLevel = Number(nextUpgrade.level ?? nextUpgrade.tier ?? facLevel + 1);

    // Refresh credits if we haven't checked yet
    if (factionCredits === 0) {
      try { factionCredits = (await fleetViewFactionStorage(ctx)).credits; } catch { /* ok */ }
    }

    if (upgradeCost > 0 && factionCredits >= upgradeCost * 2) {
      // Check and buy materials for the upgrade
      const upgradeMats = (nextUpgrade.materials ?? nextUpgrade.build_materials ?? []) as Array<Record<string, unknown>>;
      for (const rawMat of upgradeMats) {
        const matId = String(rawMat.item_id ?? rawMat.itemId ?? "");
        const matQty = Number(rawMat.quantity ?? rawMat.amount ?? 0);
        if (!matId || matQty <= 0) continue;
        const inStorage = storageMap.get(matId) ?? 0;
        const deficit = matQty - inStorage;
        if (deficit <= 0) continue;

        // Track as facility need
        allMaterialNeeds.set(matId, (allMaterialNeeds.get(matId) ?? 0) + deficit);

        // Try to buy from market
        try {
          const est = await ctx.api.estimatePurchase(matId, deficit);
          const available = (est as any).available ?? 0;
          const cost = (est as any).total_cost ?? 0;
          if (available > 0 && cost < factionCredits * 0.3) {
            const buyQty = Math.min(available, deficit);
            await ctx.api.buy(matId, buyQty);
            await ctx.refreshState();
            await ctx.api.factionDepositItems(matId, buyQty);
            await ctx.refreshState();
            storageMap.set(matId, inStorage + buyQty);
            yield `bought ${buyQty}x ${ctx.crafting.getItemName(matId)} for upgrade (${cost}cr)`;
          }
        } catch { /* market buy failed — ok */ }
      }
      // Update facility needs in cache
      ctx.cache.setFacilityMaterialNeeds(allMaterialNeeds);

      yield `upgrading ${facName} (Lv${facLevel} → Lv${upgradeLevel}) for ${upgradeCost}cr`;
      try {
        await ctx.api.factionFacilityUpgrade(facId, upgradeType || undefined);
        await ctx.refreshState();
        yield `upgraded ${facName} to level ${upgradeLevel}`;
      } catch (err) {
        yield `facility upgrade failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return; // Max one upgrade per cycle
    } else if (upgradeCost > 0) {
      yield `${facName} upgrade available (Lv${upgradeLevel}, ${upgradeCost}cr) — faction funds: ${factionCredits}cr`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// CFO ROI Analysis
// ════════════════════════════════════════════════════════════════════

/**
 * Fleet CFO logic: survey all profit paths (trade, craft) by ROI and yield
 * a ranked summary. Also checks if trader ships would benefit from a cargo upgrade.
 *
 * Does NOT make purchases — analysis only. Recommendations appear in routine logs.
 */
async function* runCFOAnalysis(
  ctx: BotContext,
  priceIndex: Map<string, PriceEntry>,
): AsyncGenerator<RoutineYield, void, void> {
  const analyzer = new ROIAnalyzer({
    fuelCostPerJump: 50,
    ticksPerJump: 2,
    dangerCostMultiplier: 500,
  });

  const candidates: ROIEstimate[] = [];

  // ── Trade ROI: scan cached cross-station arbitrage opportunities ──
  const freshness = ctx.cache.getAllMarketFreshness();
  const stationIds = freshness.map((f) => f.stationId);

  // For each item in the price index, check if there's a buy-low/sell-high opportunity
  for (const [itemId, entry] of priceIndex) {
    // Need both a cheap source and a demand price
    if (entry.cheapestBuy === Infinity || entry.cheapestBuy <= 0) continue;
    if (entry.bestSell <= 0) continue;

    const margin = entry.bestSell - entry.cheapestBuy;
    if (margin <= 0) continue;

    // Estimate volume as min of median observations (conservative)
    const volume = Math.min(entry.medianBuy > 0 ? 10 : 5, 20);

    // Data age: use average freshness of cached stations
    const dataAgeMs = freshness.length > 0
      ? freshness.reduce((sum, f) => sum + (Date.now() - f.fetchedAt), 0) / freshness.length
      : 600_000;

    const roi = analyzer.tradeROI({
      buyPrice: entry.cheapestBuy,
      sellPrice: entry.bestSell,
      volume,
      jumps: 2, // Conservative default — no galaxy routing from QM
      dataAgeMs,
      dangerScore: 0,
    });

    if (roi.netProfit > 0) {
      // Attach item context for logging
      (roi as ROIEstimate & { _itemId?: string })._itemId = itemId;
      candidates.push(roi);
    }
  }

  // ── Craft ROI: check top profitable recipes ──
  const recipes = ctx.crafting.getAllRecipes();
  for (const recipe of recipes) {
    const { profit } = ctx.crafting.estimateMarketProfit(recipe.id);
    if (profit <= 0) continue;

    const materialCost = recipe.ingredients.reduce(
      (sum, ing) => sum + ctx.crafting.getItemBasePrice(ing.itemId) * ing.quantity,
      0,
    );

    const roi = analyzer.craftROI({
      outputValue: ctx.crafting.getItemBasePrice(recipe.outputItem) * recipe.outputQuantity,
      materialCosts: recipe.ingredients.map((ing) => ({
        itemId: ing.itemId,
        qty: ing.quantity,
        unitCost: ctx.crafting.getItemBasePrice(ing.itemId),
      })),
      craftTimeTicks: 4,
    });

    if (roi.netProfit > 0) {
      (roi as ROIEstimate & { _itemId?: string })._itemId = recipe.outputItem;
      candidates.push(roi);
    }
  }

  // ── Rank all candidates by weighted profitPerTick ──
  const ranked = analyzer.comparePaths(candidates);
  const top = ranked.slice(0, 5);

  if (top.length === 0) {
    yield "CFO: no profitable actions identified in current market data";
  } else {
    const best = top[0];
    const bestLabel = (best as ROIEstimate & { _itemId?: string })._itemId
      ? ctx.crafting.getItemName((best as ROIEstimate & { _itemId?: string })._itemId!) || (best as ROIEstimate & { _itemId?: string })._itemId
      : "unknown";
    yield `CFO: best ROI path — ${best.type} [${bestLabel}] ${Math.round(best.profitPerTick)}cr/tick (net ${Math.round(best.netProfit)}cr, conf ${(best.confidence * 100).toFixed(0)}%)`;

    if (top.length > 1) {
      const summary = top.slice(1).map((r) => {
        const label = (r as ROIEstimate & { _itemId?: string })._itemId
          ? ctx.crafting.getItemName((r as ROIEstimate & { _itemId?: string })._itemId!) || (r as ROIEstimate & { _itemId?: string })._itemId
          : r.type;
        return `${label}(${Math.round(r.profitPerTick)}cr/tick)`;
      }).join(", ");
      yield `CFO: other candidates — ${summary}`;
    }
  }

  // ── Ship investment analysis: check trader bots with small cargo ──
  const fleet = ctx.getFleetStatus();
  const CARGO_UPGRADE_THRESHOLD = 150;  // Consider upgrade if cargo < this
  const PAYBACK_LIMIT_HOURS = 24;       // Only recommend if pays back within 24h

  for (const bot of fleet.bots) {
    if (bot.routine !== "trader") continue;
    if (bot.cargoCapacity >= CARGO_UPGRADE_THRESHOLD) continue;

    // Estimate current profit from recent ROI candidates
    const traderROI = ranked.filter((r) => r.type === "trade");
    if (traderROI.length === 0) continue;

    const bestTradeROI = traderROI[0];
    // Scale profit per tick to per-hour (1 tick ≈ 10 seconds → 360 ticks/hour)
    const TICKS_PER_HOUR = 360;
    const currentProfitPerHour = bestTradeROI.profitPerTick * TICKS_PER_HOUR;
    if (currentProfitPerHour <= 0) continue;

    // Standard upgrade: assume next ship tier has ~2x cargo
    const newCargoCapacity = bot.cargoCapacity * 2;
    // TODO: query shipyard for actual upgrade prices when API is available
    const estimatedUpgradeCost = 200_000; // Conservative placeholder

    const investROI = analyzer.shipInvestmentROI({
      currentCargoCapacity: bot.cargoCapacity,
      newCargoCapacity,
      acquisitionCost: estimatedUpgradeCost,
      currentProfitPerHour,
    });

    if (investROI.paybackHours <= PAYBACK_LIMIT_HOURS) {
      yield `CFO: ship upgrade recommended for ${bot.username} — cargo ${bot.cargoCapacity} → ${newCargoCapacity}, payback ${investROI.paybackHours.toFixed(1)}h (+${Math.round(investROI.profitIncreasePerHour)}cr/h)`;
    }
  }
}

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

/**
 * Calculate a competitive sell price for an item based on cached market data.
 * Returns null if the item shouldn't be listed (market value too low vs cost).
 */
export function calculateSellPrice(
  ctx: BotContext,
  itemId: string,
  costBasis: number,
  _cachedStationIds: string[],
  homeBase: string,
  undercutPct: number,
  priceIdx?: Map<string, PriceEntry>,
): { listPrice: number; cheapestElsewhere: number } | null {
  // Use pre-built index if available, otherwise build on the fly
  const idx = priceIdx ?? buildPriceIndex(ctx, homeBase);
  const entry = idx.get(itemId);
  const cheapestElsewhere = entry?.cheapestBuy ?? Infinity;
  const bestDemandPrice = entry?.bestSell ?? 0;

  // Skip items where market value is far below crafting cost AND no demand exists
  // If demand exists (bestDemandPrice > 0), let market price drive the listing
  if (cheapestElsewhere < Infinity && cheapestElsewhere < costBasis * 0.5 && bestDemandPrice <= 0) {
    return null;
  }

  // Insight-aware pricing: boost base price BEFORE undercutting when demand is confirmed
  // This preserves more margin than applying premium after undercut
  let demandBoost = 1.0;
  const stationInsights = ctx.cache.getMarketInsights(homeBase);
  if (stationInsights) {
    const demandInsight = stationInsights.find(
      (i) => i.item_id === itemId && (i.category === "demand" || i.category === "arbitrage")
    );
    if (demandInsight && demandInsight.priority >= 5) {
      demandBoost = 1.15; // +15% premium for high-demand items (applied before undercut)
    } else if (demandInsight && demandInsight.priority >= 3) {
      demandBoost = 1.08; // +8% for moderate demand
    }
  }

  // Calculate list price: apply demand boost first, then undercut competitors
  let listPrice: number;
  if (cheapestElsewhere < Infinity) {
    listPrice = Math.floor(cheapestElsewhere * demandBoost * (1 - undercutPct));
  } else if (bestDemandPrice > 0) {
    listPrice = Math.floor(bestDemandPrice * demandBoost * (1 - undercutPct / 2));
  } else {
    listPrice = Math.ceil(costBasis * 1.25 * demandBoost);
  }

  // Floor: at least cost basis (break even)
  const minPrice = cheapestElsewhere < Infinity
    ? Math.max(1, Math.floor(cheapestElsewhere * 0.95))
    : Math.ceil(costBasis * 1.10);
  if (listPrice < minPrice) {
    listPrice = minPrice;
  }

  if (listPrice <= 0) return null;

  return { listPrice, cheapestElsewhere };
}

/**
 * Estimate cost basis of an item for pricing sell orders.
 * Uses crafting ingredient costs if available, else base catalog price.
 */
export function estimateCostBasis(ctx: BotContext, itemId: string): number {
  // If craftable, sum ingredient base prices for more accurate cost
  if (ctx.crafting.isCraftable(itemId)) {
    const recipes = ctx.crafting.getAllRecipes();
    const recipe = recipes.find((r) => r.outputItem === itemId);
    if (recipe) {
      const ingredientCost = recipe.ingredients.reduce(
        (sum, ing) => sum + ctx.crafting.getItemBasePrice(ing.itemId) * ing.quantity,
        0,
      );
      if (ingredientCost > 0) {
        return Math.ceil(ingredientCost / Math.max(1, recipe.outputQuantity));
      }
    }
  }

  // Fallback: catalog base price
  return ctx.crafting.getItemBasePrice(itemId);
}

/** Check if an item ID looks like a ship module */
function isModuleItem(itemId: string): boolean {
  return MODULE_PATTERNS.some((p) => itemId.includes(p));
}

// ── Chat advertisement ──

interface AdChatState { lastAdChatTime: number; stationName: string }

const AD_CHAT_COOLDOWN = 300_000; // 5 minutes

/** Post a trade advertisement to system chat, rate-limited to 1 per 5 minutes. */
async function advertiseInChat(
  ctx: BotContext,
  message: string,
  state: AdChatState,
): Promise<boolean> {
  const now = Date.now();
  if (now - state.lastAdChatTime < AD_CHAT_COOLDOWN) return false;
  try {
    const fullMsg = state.stationName ? `${message} at ${state.stationName}` : message;
    await ctx.api.chat("system", fullMsg);
    state.lastAdChatTime = now;
    return true;
  } catch { return false; }
}
