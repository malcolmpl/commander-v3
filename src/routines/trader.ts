/**
 * Trader routine - buy low at one station, sell high at another.
 *
 * Smart trading:
 * 1. Scans market at buy station, finds items with known profitable sell targets
 * 2. Calculates max buy quantity (cargo space + credits)
 * 3. Only buys when profit margin is confirmed
 * 4. Scans sell station market to verify prices before selling
 *
 * Params:
 *   buyStation: string      - Base ID to buy from (auto-discovered if empty)
 *   sellStation: string     - Base ID to sell at (auto-discovered if empty)
 *   item: string            - Item ID to trade (auto-discovered if empty)
 *   maxBuyPrice?: number    - Don't pay more than this
 *   minSellPrice?: number   - Don't accept less than this
 *   maxRoundTrips?: number  - Max trips before yielding cycle_complete
 *   useOrders?: boolean     - Place market orders instead of instant buy/sell
 *   sellFromFaction?: boolean - Withdraw from faction storage and sell (supply chain mode)
 *   enableArbitrage?: boolean - After faction sell, attempt insight-gated arbitrage trip
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import type { MarketOrder } from "../types/game";
import {
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
  sellAllCargo,
  cacheMarketData,
  isProtectedItem,
  recordSellResult,
  adjustMarketCache,
  payFactionTax,
  ensureMinCredits,
  depositExcessCredits,
  interruptibleSleep,
  withdrawFromFaction,
  fleetViewMarket,
  fleetGetSystem,
  fleetViewFactionStorage,
  collectScatteredCargo,
  depositAllToFaction,
  MAX_MATERIAL_BUY_PRICE,
  INSIGHT_GATE_PRICE,
} from "./helpers";
import { calculateSellPrice, estimateCostBasis } from "./quartermaster";

/** Check if item is an ore (game uses both ore_X and X_ore patterns, plus raw variants) */
function isOre(itemId: string): boolean {
  return itemId.startsWith("ore_") || itemId.endsWith("_ore") || itemId.includes("_ore_");
}

/** Resolve current station name for chat messages */
function getStationName(ctx: BotContext): string {
  const baseId = ctx.player.dockedAtBase;
  if (!baseId) return "";
  const systemId = ctx.galaxy.getSystemForBase(baseId);
  if (!systemId) return baseId;
  const sys = ctx.galaxy.getSystem(systemId);
  const poi = sys?.pois.find((p) => p.baseId === baseId);
  return poi?.baseName ?? poi?.name ?? baseId;
}

/**
 * Check if a buy is allowed under the insight-gated price system.
 * ≤ INSIGHT_GATE_PRICE: always allowed (existing guards sufficient).
 * INSIGHT_GATE_PRICE..MAX_MATERIAL_BUY_PRICE: requires demand insight at sell station.
 * > MAX_MATERIAL_BUY_PRICE: always blocked.
 */
function isInsightGatedBuyAllowed(
  ctx: BotContext, itemId: string, unitPrice: number, sellStationId: string,
): { allowed: boolean; reason: string } {
  if (unitPrice > MAX_MATERIAL_BUY_PRICE) {
    return { allowed: false, reason: `price ${unitPrice}cr exceeds cap ${MAX_MATERIAL_BUY_PRICE}cr` };
  }
  if (unitPrice <= INSIGHT_GATE_PRICE) {
    return { allowed: true, reason: "" };
  }
  // Check demand insights first (strongest signal)
  const insights = ctx.cache.getMarketInsights(sellStationId);
  if (insights && insights.length > 0) {
    const hasDemand = insights.some(
      (i) => i.category === "demand" && i.item_id === itemId && i.priority >= 3,
    );
    if (hasDemand) return { allowed: true, reason: "" };
  }
  // Fallback: allow if cached sell price confirms ≥15% margin (even without fresh insights)
  const cachedPrices = ctx.cache.getMarketPrices(sellStationId);
  if (cachedPrices) {
    const sellData = cachedPrices.find(p => p.itemId === itemId);
    if (sellData?.sellPrice && sellData.sellPrice > unitPrice * 1.15) {
      return { allowed: true, reason: "cached price confirms margin" };
    }
  }
  return { allowed: false, reason: `${unitPrice}cr > ${INSIGHT_GATE_PRICE}cr, no demand signal for ${itemId}` };
}

/**
 * Find an alternate station to sell cargo at, using cached market data.
 * Scores stations by total expected revenue for items currently in cargo,
 * skipping the failed station. Returns the best reachable station base ID or null.
 */
function findAlternateBuyer(ctx: BotContext, failedStation: string): string | null {
  const cargoItems = ctx.ship.cargo.filter((c) => c.itemId !== "fuel_cell" && c.quantity > 0);
  if (cargoItems.length === 0) return null;

  const freshStations = ctx.cache.getAllMarketFreshness();
  let bestStation = "";
  let bestRevenue = 0;

  for (const { stationId } of freshStations) {
    if (stationId === failedStation) continue;
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;

    let revenue = 0;
    for (const cargo of cargoItems) {
      const price = prices.find((p) => p.itemId === cargo.itemId);
      if (price?.sellPrice && price.sellPrice > 0) {
        revenue += price.sellPrice * cargo.quantity;
      }
    }

    if (revenue > bestRevenue) {
      bestRevenue = revenue;
      bestStation = stationId;
    }
  }

  return bestStation || null;
}

export async function* trader(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  let buyStation = getParam(ctx, "buyStation", "");
  let sellStation = getParam(ctx, "sellStation", "");
  let item = getParam(ctx, "item", "");
  let maxBuyPrice = getParam(ctx, "maxBuyPrice", Infinity);
  let minSellPrice = getParam(ctx, "minSellPrice", 0);
  const maxRoundTrips = getParam(ctx, "maxRoundTrips", Infinity);
  const useOrders = getParam(ctx, "useOrders", false);
  let sellFromFaction = getParam(ctx, "sellFromFaction", false);
  const enableArbitrage = getParam(ctx, "enableArbitrage", false);
  const traderIndex = getParam(ctx, "traderIndex", 0);

  // Track items that failed to sell — seeded from fleet-wide cache, persists across sessions
  const blacklistedItems = new Set<string>(await ctx.cache.getUnsellableItems());

  // Commander-assigned route (from scoring brain's arbitrage analysis)
  const assignedItem = getParam(ctx, "assignedItem", "");
  const assignedBuyStation = getParam(ctx, "assignedBuyStation", "");
  const assignedSellStation = getParam(ctx, "assignedSellStation", "");
  const maxBuyQty = getParam(ctx, "maxBuyQty", Infinity);
  const expectedBuyPrice = getParam(ctx, "expectedBuyPrice", 0);
  const expectedSellPrice = getParam(ctx, "expectedSellPrice", 0);

  // Use commander-assigned route if provided
  if (assignedItem && assignedBuyStation && assignedSellStation) {
    item = assignedItem;
    buyStation = assignedBuyStation;
    sellStation = assignedSellStation;
    maxBuyPrice = expectedBuyPrice > 0 ? expectedBuyPrice * 1.05 : Infinity; // 5% tolerance
    minSellPrice = expectedSellPrice > 0 ? expectedSellPrice * 0.90 : 0; // 10% tolerance
    yield `commander-assigned route: ${assignedItem} ${assignedBuyStation} → ${assignedSellStation} (max ${maxBuyQty} units)`;
  }

  // Auto-detect: if no explicit trade route and faction storage is configured, use faction sell
  if (!sellFromFaction && !buyStation && !sellStation && !item) {
    const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
    if (factionStation) {
      sellFromFaction = true;
      yield "auto-detected faction sell mode (no explicit trade route)";
    }
  }

  // Guard: traders don't trade ores (miners handle those via supply chain)
  if (item && isOre(item)) {
    yield `skipping ore trade (${item}) — miners handle ores`;
    item = ""; // Force auto-discovery of non-ore items
  }

  // ── Clear leftover cargo from previous routine (e.g., ore from mining) ──
  if (ctx.cargo.freeSpace(ctx.ship) <= 0 && ctx.ship.cargo.length > 0) {
    // If not docked, dock first
    if (!ctx.player.dockedAtBase) {
      try {
        await findAndDock(ctx);
      } catch {
        // Can't dock — try to continue anyway
      }
    }
    if (ctx.player.dockedAtBase) {
      yield "clearing leftover cargo from previous role";
      let cleared = false;
      for (const c of [...ctx.ship.cargo]) {
        if (isProtectedItem(c.itemId)) continue;
        if (c.quantity <= 0) continue;
        // Try sell first (earns credits)
        try {
          const result = await ctx.api.sell(c.itemId, c.quantity);
          if (result.total > 0) {
            yield `sold ${result.quantity} ${c.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
            cleared = true;
            continue;
          }
        } catch (err) {
          console.warn(`[${ctx.botId}] pre-trade sell failed for ${c.itemId}: ${err instanceof Error ? err.message : err}`);
          // Refresh state to fix stale cargo data (e.g., item already sold/moved)
          await ctx.refreshState();
          continue;
        }
        // Deposit to faction storage
        try {
          await ctx.api.factionDepositItems(c.itemId, c.quantity);
          ctx.cache.invalidateFactionStorage();
          yield `deposited ${c.quantity} ${c.itemId} to faction storage`;
          cleared = true;
          continue;
        } catch (err) { console.warn(`[${ctx.botId}] faction deposit failed for ${c.itemId}: ${err instanceof Error ? err.message : err}`); }
        // Personal storage fallback
        try {
          await ctx.api.depositItems(c.itemId, c.quantity);
          cleared = true;
        } catch (err) { console.warn(`[${ctx.botId}] personal deposit failed for ${c.itemId}: ${err instanceof Error ? err.message : err}`); }
      }
      if (cleared) await ctx.refreshState();
      await refuelIfNeeded(ctx);
    }
  }

  // ── Faction supply chain mode (hybrid: faction sell + optional arbitrage) ──
  if (sellFromFaction) {
    yield* factionSellLoop(ctx, maxRoundTrips, blacklistedItems);
    // Hybrid: attempt 1 arbitrage trip after faction sell if insights exist
    if (enableArbitrage && !ctx.shouldStop && ctx.cargo.freeSpace(ctx.ship) > 0) {
      yield "faction sell complete — checking arbitrage opportunities";
      yield* insightGatedArbitrageTrip(ctx, blacklistedItems);
    }
    return;
  }

  // ── Check faction storage for free sellable goods before buying ──
  // Faction items cost nothing to acquire — any confirmed sell price is pure profit.
  // viewFactionStorage requires docking, so this only fires when the bot is currently docked.
  {
    const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
    if (factionStation) {
      try {
        const { items: storage } = await fleetViewFactionStorage(ctx);
        const sellableItems = storage
          .filter((s) => s.quantity > 0 && !isOre(s.itemId));

        if (sellableItems.length > 0) {
          // Check if faction goods have enough total value to justify a sell trip
          const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
          let bestTotalValue = 0;
          let bestItemName = "";
          let bestItemQty = 0;
          let bestItemPrice = 0;
          for (const si of sellableItems) {
            for (const stationId of cachedStationIds) {
              if (stationId === factionStation) continue;
              const prices = ctx.cache.getMarketPrices(stationId);
              const sellPrice = prices?.find((p) => p.itemId === si.itemId)?.sellPrice ?? 0;
              const totalValue = sellPrice * si.quantity;
              if (totalValue > bestTotalValue) {
                bestTotalValue = totalValue;
                bestItemName = ctx.crafting.getItemName(si.itemId);
                bestItemQty = si.quantity;
                bestItemPrice = sellPrice;
              }
            }
          }
          // Only divert to faction sell if total value justifies the trip (>2000cr)
          if (bestTotalValue >= 2000) {
            yield `faction has ${bestItemQty} ${bestItemName} sellable @${bestItemPrice}cr (~${bestTotalValue}cr total) — selling free goods first`;
            yield* factionSellLoop(ctx, maxRoundTrips, blacklistedItems);
            return;
          }
        }
      } catch {
        // viewFactionStorage may fail if not docked or not in a faction — continue normally
      }
    }
  }

  // ── Market discovery: scan stations when cache is too thin for route finding ──
  if (!buyStation && !sellStation && !item) {
    const cachedCount = ctx.cache.getAllMarketFreshness().length;
    if (cachedCount < 2) {
      yield `market cache thin (${cachedCount} station${cachedCount !== 1 ? "s" : ""}) — scanning nearby stations`;
      // Dock if not already, scan current station
      if (!ctx.player.dockedAtBase) {
        try { await findAndDock(ctx); } catch { /* continue */ }
      }
      if (ctx.player.dockedAtBase) {
        try {
          await fleetViewMarket(ctx, ctx.player.dockedAtBase);
          yield `scanned market at current station`;
        } catch { /* continue */ }
      }
      // Look for other stations in-system and scan them too
      if (!ctx.shouldStop) {
        try {
          const system = await fleetGetSystem(ctx);
          const otherBases = system.pois.filter(p => p.hasBase && p.baseId && p.baseId !== ctx.player.dockedAtBase);
          for (const poi of otherBases.slice(0, 2)) { // Scan up to 2 other stations
            if (ctx.shouldStop) break;
            try {
              yield `scanning market at ${poi.baseName ?? poi.name}`;
              await navigateAndDock(ctx, poi.baseId!);
              await fleetViewMarket(ctx, poi.baseId!);
              yield `scanned market at ${poi.baseName ?? poi.name}`;
            } catch { /* skip this station */ }
          }
        } catch { /* continue */ }
      }
    }
  }

  // ── Auto-discover trade routes (ranked by profitability) ──
  type CandidateRoute = { itemId: string; itemName: string; buyStation: string; sellStation: string; buyPrice: number; sellPrice: number; profitPerUnit: number; volume: number; jumps: number };
  const candidateRoutes: CandidateRoute[] = [];

  if (!buyStation || !sellStation || !item) {
    yield "discovering trade routes...";

    // Use Commander's cached market data to find arbitrage
    const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
    if (cachedStationIds.length >= 2) {
      const estFuelCost = ctx.nav?.estimateJumpFuel?.(ctx.ship) ?? 50;
      const routes = ctx.market.findArbitrage(cachedStationIds, ctx.player.currentSystem, ctx.cargo.freeSpace(ctx.ship), estFuelCost)
        .filter((r) => !isOre(r.itemId) && !blacklistedItems.has(r.itemId)); // Skip ores and blacklisted items
      for (const r of routes) {
        candidateRoutes.push({
          itemId: r.itemId, itemName: r.itemName,
          buyStation: r.buyStationId, sellStation: r.sellStationId,
          buyPrice: r.buyPrice, sellPrice: r.sellPrice,
          profitPerUnit: r.profitPerUnit, volume: r.volume, jumps: r.jumps,
        });
      }
      if (candidateRoutes.length > 0) {
        yield `found ${candidateRoutes.length} potential route(s)`;
      }
    }

    // Use best route for this trader (offset by traderIndex for deconfliction)
    if (candidateRoutes.length > 0) {
      const routeOffset = Math.min(traderIndex, candidateRoutes.length - 1);
      const best = candidateRoutes[routeOffset];
      if (!item) item = best.itemId;
      if (!buyStation) buyStation = best.buyStation;
      if (!sellStation) sellStation = best.sellStation;
      maxBuyPrice = best.buyPrice;
      minSellPrice = best.sellPrice * 0.9;
      yield `route 1/${candidateRoutes.length}: buy ${best.itemName} @${best.buyPrice}cr → sell @${best.sellPrice}cr (+${best.profitPerUnit}cr/unit, ${best.volume > 0 ? best.volume + " avail" : "?"}, ${best.jumps} jump${best.jumps !== 1 ? "s" : ""})`;
    }

    // Fallback: scan local market if docked — but only if there's a second station to sell at
    if ((!buyStation || !item) && ctx.player.dockedAtBase) {
      // Check for a sell station FIRST — no point picking items with nowhere to sell
      const system = await fleetGetSystem(ctx);
      const otherStations = system.pois.filter((p) => p.hasBase && p.baseId !== ctx.player.dockedAtBase);

      if (otherStations.length === 0) {
        yield "only one station in system, cannot trade locally";
      } else {
        const market = await ctx.api.viewMarket();
        if (market.length > 0) {
          cacheMarketData(ctx, ctx.player.dockedAtBase, market);

          if (!buyStation) {
            buyStation = ctx.player.dockedAtBase;
          }

          // Pick a tradeable item — skip ores (miners handle those), prefer high margins
          if (!item) {
            const sellOrders = market
              .filter((m) => m.type === "sell" && m.quantity > 0 && m.priceEach > 0 && !isOre(m.itemId))
              .sort((a, b) => b.priceEach - a.priceEach); // Most expensive first

            // If we have cached data for any sell station, prefer items with confirmed demand there
            const sellStationId = otherStations[0]?.baseId;
            if (sellStationId) {
              const sellStationPrices = ctx.cache.getMarketPrices(sellStationId);
              if (sellStationPrices) {
                // Items that have buy orders (demand) at the sell station, ranked by margin
                const withDemand = sellOrders
                  .map((o) => {
                    const sellData = sellStationPrices.find((p) => p.itemId === o.itemId);
                    const sellPrice = sellData?.sellPrice ?? 0; // Best bid at destination
                    const margin = sellPrice - o.priceEach;
                    return { order: o, margin, sellPrice };
                  })
                  .filter((x) => x.margin > 0)
                  .sort((a, b) => b.margin - a.margin);

                if (withDemand.length > 0) {
                  const best = withDemand[0];
                  item = best.order.itemId;
                  yield `trading: ${best.order.itemName} (margin +${best.margin}cr/unit)`;
                }
              }
            }

            // No demand-verified pick — do NOT buy without confirmed sell price
            if (!item) {
              yield "no items with confirmed profitable sell destination";
            }
          }
        }

        // Set sell station from discovered other stations
        if (!sellStation && otherStations.length > 0 && otherStations[0].baseId) {
          sellStation = otherStations[0].baseId;
          yield `sell at: ${otherStations[0].baseName ?? otherStations[0].name}`;
        }
      }
    }
  }

  // If we still can't figure out a route, sell cargo and wait for market data
  if (!buyStation || !sellStation || !item) {
    yield "no trade route found — waiting for market data";
    if (ctx.ship.cargo.length > 0) {
      try {
        if (!ctx.player.dockedAtBase) await findAndDock(ctx);
        if (ctx.player.dockedAtBase) {
          const sellResult = await sellAllCargo(ctx);
          for (const s of sellResult.items) {
            yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
          }
          yield `sold cargo for ${sellResult.totalEarned} credits`;
        }
      } catch (err) {
        console.warn(`[${ctx.botId}] trader: failed to sell remaining cargo: ${err instanceof Error ? err.message : err}`);
      }
    }
    await refuelIfNeeded(ctx);
    await interruptibleSleep(ctx, 120_000);
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
    return;
  }

  let tripCount = 0;
  let lastBuyPrice = 0; // Track what we paid to verify profit at sell station
  let routeIndex = 0; // Track which candidate route we're on

  while (!ctx.shouldStop && tripCount < maxRoundTrips) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) {
        yield "emergency unresolved, stopping";
        return;
      }
    }

    // ── Navigate to buy station ──
    yield "traveling to buy station";
    try {
      await navigateAndDock(ctx, buyStation);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    if (ctx.shouldStop) return;

    // ── Scan market at buy station ──
    let buyOrders: MarketOrder[] = [];
    try {
      const market = await ctx.api.viewMarket();
      if (market.length > 0) {
        cacheMarketData(ctx, buyStation, market);
      }
      // Find sell orders for our item (these are what we can buy)
      buyOrders = market.filter(
        (m) => m.type === "sell" && m.itemId === item && m.quantity > 0
      );
    } catch (err) {
      yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    // ── Buy goods ──
    let freeWeight = ctx.cargo.freeSpace(ctx.ship);

    // If cargo is full of non-trade items (leftover from previous routine), dispose them
    if (freeWeight <= 0 && ctx.cargo.getItemQuantity(ctx.ship, item) === 0) {
      const otherItems = ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId) && c.itemId !== item);
      if (otherItems.length > 0 && ctx.player.dockedAtBase) {
        yield `disposing ${otherItems.length} leftover item(s) blocking cargo`;
        for (const other of otherItems) {
          let disposed = false;

          // Try sell first (earns credits)
          try {
            const result = await ctx.api.sell(other.itemId, other.quantity);
            await ctx.refreshState();
            if (result.total > 0) {
              yield `sold ${result.quantity} ${other.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
              disposed = true;
            }
          } catch (err) {
            yield `sell failed for ${other.itemId}: ${err instanceof Error ? err.message : String(err)}`;
          }

          // Try faction deposit if sell didn't work
          if (!disposed) {
            try {
              await ctx.api.factionDepositItems(other.itemId, other.quantity);
              ctx.cache.invalidateFactionStorage();
              await ctx.refreshState();
              yield `deposited ${other.quantity} ${other.itemId} to faction storage`;
              disposed = true;
            } catch (err) {
              yield `deposit failed for ${other.itemId}: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          // Try personal storage deposit as last resort
          if (!disposed) {
            try {
              await ctx.api.depositItems(other.itemId, other.quantity);
              await ctx.refreshState();
              yield `stored ${other.quantity} ${other.itemId} in personal storage`;
              disposed = true;
            } catch (err) {
              yield `storage failed for ${other.itemId}: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          if (!disposed) {
            yield `WARNING: cannot dispose ${other.quantity} ${other.itemId} — stuck in cargo`;
          }
        }
        freeWeight = ctx.cargo.freeSpace(ctx.ship);
      }
    }

    if (freeWeight <= 0) {
      yield "no cargo space, skipping buy";
    } else {
      // Calculate safe buy quantity: limited by cargo weight, credits, AND item size
      const bestPrice = buyOrders.length > 0 ? buyOrders[0].priceEach : 0;
      const availableQty = buyOrders.reduce((sum, o) => sum + o.quantity, 0);
      // Get item size (weight per unit) from cargo if we already have some, else default 1
      const itemSize = ctx.cargo.getItemSize(ctx.ship, item);

      // Pre-buy profit check: REQUIRE known sell price > buy price
      const sellStationPrices = ctx.cache.getMarketPrices(sellStation);
      const expectedSellPrice = sellStationPrices?.find((p) => p.itemId === item)?.sellPrice ?? 0;
      const noSellData = expectedSellPrice <= 0;
      const wouldLose = bestPrice > 0 && (noSellData || expectedSellPrice < bestPrice);

      if (buyOrders.length === 0) {
        yield `no sell orders for ${item} at this station, skipping buy`;
      } else if (bestPrice <= 0) {
        yield `${item} listed at 0cr, skipping buy`;
      } else if (bestPrice > maxBuyPrice && maxBuyPrice < Infinity) {
        yield `price too high (${bestPrice} > max ${maxBuyPrice}), skipping buy`;
      } else if (!isInsightGatedBuyAllowed(ctx, item, bestPrice, sellStation).allowed) {
        yield `buy blocked: ${isInsightGatedBuyAllowed(ctx, item, bestPrice, sellStation).reason}`;
      } else if (wouldLose) {
        yield noSellData
          ? `no sell price data for ${item} at sell station, skipping (won't buy blind)`
          : `unprofitable: buy ${bestPrice}cr > sell ${expectedSellPrice}cr for ${item}, skipping`;
      } else {
        // Weight-aware: divide free cargo weight by per-unit size
        let buyQty = Math.floor(freeWeight / Math.max(1, itemSize));
        // Cap by known sell demand volume — don't buy more than we can sell
        const sellDemandVol = sellStationPrices?.find((p) => p.itemId === item)?.sellVolume ?? 0;
        if (bestPrice > 0) {
          // Dynamic spend cap: raise to 75% when margin is strong (>30%) and demand is confirmed
          const margin = expectedSellPrice > 0 ? (expectedSellPrice - bestPrice) / bestPrice : 0;
          const spendPct = (margin >= 0.30 && sellDemandVol > 0) ? 0.75 : 0.50;
          const spendCap = Math.floor(ctx.player.credits * spendPct);
          const maxByCredits = Math.floor(spendCap / bestPrice);
          buyQty = Math.min(buyQty, maxByCredits, availableQty || buyQty);
        }
        if (sellDemandVol > 0) {
          buyQty = Math.min(buyQty, sellDemandVol);
        }
        // Cap by commander-assigned volume limit (prevents multiple traders over-buying)
        if (maxBuyQty < Infinity) {
          buyQty = Math.min(buyQty, maxBuyQty);
        }

        if (buyQty <= 0) {
          yield `cannot afford ${item} (${bestPrice}cr each, have ${ctx.player.credits}cr)`;
        } else {
          yield `buying ${buyQty} ${item}${bestPrice > 0 ? ` @ ${bestPrice}cr` : ""}${itemSize > 1 ? ` (size ${itemSize}/unit)` : ""}`;
          try {
            if (useOrders) {
              // Place a buy order at a specific price
              const orderPrice = maxBuyPrice < Infinity ? maxBuyPrice : bestPrice;
              if (orderPrice <= 0) {
                yield "cannot place order without price data";
              } else {
                await ctx.api.createBuyOrder(item, buyQty, orderPrice);
                yield `buy order placed: ${buyQty}x @ ${orderPrice}cr`;
                try { const stn = getStationName(ctx); await ctx.api.chat("system", `Buying ${buyQty}x ${item} @ ${orderPrice}cr${stn ? ` at ${stn}` : ""}`); } catch { /* best effort */ }
              }
            } else {
              const cargoBefore = ctx.cargo.getItemQuantity(ctx.ship, item);
              const result = await ctx.api.buy(item, buyQty);
              await ctx.refreshState();
              // Verify purchase landed in cargo
              const cargoAfter = ctx.cargo.getItemQuantity(ctx.ship, item);
              const actualReceived = cargoAfter - cargoBefore;
              if (result.quantity > 0 && actualReceived <= 0) {
                yield `buy warning: API reports ${result.quantity} bought but cargo unchanged (before=${cargoBefore}, after=${cargoAfter})`;
              }
              // API sometimes returns 0 for priceEach — use expected price as fallback
              const actualPrice = result.priceEach > 0 ? result.priceEach : bestPrice;
              const actualTotal = result.total > 0 ? result.total : result.quantity * actualPrice;
              lastBuyPrice = actualPrice;
              // Optimistic update: reduce cached supply so other bots don't target same stock
              adjustMarketCache(ctx, buyStation, item, "buy", actualReceived > 0 ? actualReceived : result.quantity);
              yield typedYield(`bought ${actualReceived > 0 ? actualReceived : result.quantity} ${item} @ ${actualPrice}cr each (${actualTotal}cr)`, {
                type: "trade_buy", botId: ctx.botId, itemId: item,
                quantity: actualReceived > 0 ? actualReceived : result.quantity,
                priceEach: actualPrice, total: actualTotal, stationId: buyStation,
              });
            }
          } catch (err) {
            yield `buy failed: ${err instanceof Error ? err.message : String(err)}`;
            // Continue to sell what we already have
          }
        }
      }
    }

    if (ctx.shouldStop) return;

    // ── Navigate to sell station ──
    const cargoQty = ctx.cargo.getItemQuantity(ctx.ship, item);
    if (cargoQty === 0) {
      // Opportunistic buy: we're already at this station, scan for anything profitable here
      if (ctx.player.dockedAtBase) {
        const localMarket = await ctx.api.viewMarket();
        if (localMarket.length > 0) {
          cacheMarketData(ctx, ctx.player.dockedAtBase, localMarket);
          const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
          const freeWeight = ctx.cargo.freeSpace(ctx.ship);
          // Find anything here we can buy profitably
          for (const order of localMarket.filter((m) => m.type === "sell" && m.quantity > 0 && m.priceEach > 0 && !isOre(m.itemId) && !blacklistedItems.has(m.itemId))) {
            for (const sid of cachedStationIds) {
              if (sid === ctx.player.dockedAtBase) continue;
              // Insight-gated price check (sell destination = sid)
              const gateCheck = isInsightGatedBuyAllowed(ctx, order.itemId, order.priceEach, sid);
              if (!gateCheck.allowed) continue;
              // Verify sell station data is fresh (<30min) — stale data causes bad trades
              const freshness = ctx.cache.getAllMarketFreshness().find((f) => f.stationId === sid);
              if (!freshness || freshness.ageMs > 30 * 60_000) continue;
              const prices = ctx.cache.getMarketPrices(sid);
              const sellData = prices?.find((p) => p.itemId === order.itemId);
              if (sellData?.sellPrice && sellData.sellPrice > order.priceEach) {
                const profit = sellData.sellPrice - order.priceEach;
                // Require 12%+ margin AND 10cr+ per unit to guard against stale data
                if (profit / order.priceEach < 0.12 || profit < 10) continue;
                const itemSize = ctx.cargo.getItemSize(ctx.ship, order.itemId);
                const oppSpendPct = (profit / order.priceEach >= 0.25 && sellData.sellVolume > 0) ? 0.75 : 0.50;
                const spendCap = Math.floor(ctx.player.credits * oppSpendPct);
                const maxQty = Math.min(
                  Math.floor(freeWeight / Math.max(1, itemSize)),
                  Math.floor(spendCap / order.priceEach),
                  order.quantity,
                );
                if (maxQty > 0 && profit * maxQty > 200) { // Only if total profit > 200cr
                  yield `opportunistic: buying ${maxQty} ${order.itemName ?? order.itemId} (+${profit}cr/unit)`;
                  try {
                    await ctx.api.buy(order.itemId, maxQty);
                    await ctx.refreshState();
                    item = order.itemId;
                    sellStation = sid;
                    lastBuyPrice = order.priceEach;
                    break;
                  } catch { /* continue looking */ }
                }
              }
            }
            if (ctx.cargo.getItemQuantity(ctx.ship, item) > 0) break;
          }
        }
      }

      // If opportunistic buy didn't land anything, try next candidate route
      if (ctx.cargo.getItemQuantity(ctx.ship, item) === 0) {
        routeIndex++;
        if (routeIndex < candidateRoutes.length) {
          const next = candidateRoutes[routeIndex];
          yield `route ${routeIndex}/${candidateRoutes.length} unprofitable, trying next: ${next.itemName} (+${next.profitPerUnit}cr/unit)`;
          item = next.itemId;
          buyStation = next.buyStation;
          sellStation = next.sellStation;
          maxBuyPrice = next.buyPrice;
          minSellPrice = next.sellPrice * 0.9;
          continue; // Re-enter loop with new route
        }
        yield "no profitable routes found — waiting for new opportunities";
        await refuelIfNeeded(ctx);
        await interruptibleSleep(ctx, 120_000);
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
        return;
      }
    }

    yield "traveling to sell station";
    try {
      await navigateAndDock(ctx, sellStation);
    } catch (err) {
      yield `navigation to sell station failed: ${err instanceof Error ? err.message : String(err)}`;
      // Find an alternate buyer from cached market data
      const altStation = findAlternateBuyer(ctx, sellStation);
      if (altStation) {
        yield `rerouting to alternate buyer: ${altStation}`;
        try {
          await navigateAndDock(ctx, altStation);
          // Fall through to normal sell logic below with the new station
          sellStation = altStation;
        } catch (altErr) {
          yield `alternate route also failed: ${altErr instanceof Error ? altErr.message : String(altErr)}`;
          // Try faction storage before selling at random station
          const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
          let depositedToFaction = false;
          if (factionStation) {
            try {
              yield "returning cargo to faction storage";
              await navigateAndDock(ctx, factionStation);
              const nDeposited = await depositAllToFaction(ctx);
              if (nDeposited > 0) {
                yield `deposited ${nDeposited} item type(s) to faction storage (failed trade return)`;
                depositedToFaction = true;
              }
            } catch (fErr) {
              yield `faction return failed: ${fErr instanceof Error ? fErr.message : String(fErr)}`;
            }
          }
          if (!depositedToFaction) {
            try {
              await findAndDock(ctx);
              await sellAllCargo(ctx);
              await ctx.refreshState();
              yield "sold cargo at nearest station";
            } catch { yield "all sell attempts failed — cargo stranded"; }
          }
          yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
          return;
        }
      } else {
        // No cached alternate — try faction storage first, then nearest station
        const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
        let depositedToFaction = false;
        if (factionStation) {
          yield "no alternate buyers known — returning cargo to faction storage";
          try {
            await navigateAndDock(ctx, factionStation);
            const nDeposited = await depositAllToFaction(ctx);
            if (nDeposited > 0) {
              yield `deposited ${nDeposited} item type(s) to faction storage (failed trade return)`;
              depositedToFaction = true;
            }
          } catch (fErr) {
            yield `faction return failed: ${fErr instanceof Error ? fErr.message : String(fErr)}`;
          }
        }
        if (!depositedToFaction) {
          yield "faction return failed — selling at nearest station";
          try {
            await findAndDock(ctx);
            await sellAllCargo(ctx);
            await ctx.refreshState();
            yield "sold cargo at fallback station";
          } catch { yield "fallback sell failed — cargo stranded"; }
        }
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
        return;
      }
    }

    if (ctx.shouldStop) return;

    // Track credits to calculate profit for faction tax
    const creditsBeforeSell = ctx.player.credits;

    // ── Scan sell station market & verify profit ──
    let sellMarketOrders: MarketOrder[] = [];
    try {
      sellMarketOrders = await ctx.api.viewMarket();
      if (sellMarketOrders.length > 0) {
        cacheMarketData(ctx, sellStation, sellMarketOrders);
      }
    } catch (err) {
      console.warn(`[${ctx.botId}] trader: sell market scan failed: ${err instanceof Error ? err.message : err}`);
    }

    const qty = ctx.cargo.getItemQuantity(ctx.ship, item);
    if (qty > 0) {
      // Check if sell price is profitable vs what we paid
      const buyOrdersAtSell = sellMarketOrders.filter(
        (m) => m.type === "buy" && m.itemId === item && m.quantity > 0
      );
      const liveSellPrice = buyOrdersAtSell.length > 0
        ? Math.max(...buyOrdersAtSell.map((o) => o.priceEach))
        : 0;

      // If we know the buy price and the sell price would be a loss, return to faction storage
      if (lastBuyPrice > 0 && liveSellPrice > 0 && liveSellPrice < lastBuyPrice) {
        yield `unprofitable: paid ${lastBuyPrice}cr, sell price ${liveSellPrice}cr — blacklisting ${item} fleet-wide`;
        blacklistedItems.add(item);
        ctx.cache.markUnsellable(item);

        // Try faction deposit
        const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
        let deposited = false;

        // If we're at a station with faction storage, deposit directly
        if (ctx.player.dockedAtBase) {
          try {
            await ctx.api.factionDepositItems(item, qty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
            yield `deposited ${qty} ${item} to faction storage (saved from loss)`;
            deposited = true;
          } catch {
            // No faction storage here — travel to faction station
          }
        }

        // Travel to faction storage station if needed
        if (!deposited && factionStation && factionStation !== ctx.player.dockedAtBase) {
          try {
            yield `traveling to faction storage to deposit`;
            await navigateAndDock(ctx, factionStation);
            await ctx.api.factionDepositItems(item, qty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
            yield `deposited ${qty} ${item} to faction storage (saved from loss)`;
            deposited = true;
          } catch (err) {
            yield `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // If all deposit attempts fail, sell anyway (better than holding forever)
        if (!deposited) {
          yield `cannot deposit, selling at loss to avoid holding`;
          try {
            const result = await ctx.api.sell(item, qty);
            await ctx.refreshState();
            yield `sold ${result.quantity} ${item} @ ${result.priceEach}cr (total: ${result.total}cr) [LOSS]`;
          } catch (err) {
            yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } else {
        // ── Sell goods (profitable or no price data) ──
        yield `selling ${qty} ${item}`;
        try {
          if (useOrders) {
            const orderPrice = minSellPrice > 0 ? minSellPrice : undefined;
            if (orderPrice) {
              await ctx.api.createSellOrder(item, qty, orderPrice);
              yield `sell order placed: ${qty}x @ ${orderPrice}cr`;
              try { const stn = getStationName(ctx); await ctx.api.chat("system", `Selling ${qty}x ${item} @ ${orderPrice}cr${stn ? ` at ${stn}` : ""}`); } catch { /* best effort */ }
            } else {
              const result = await ctx.api.sell(item, qty);
              await ctx.refreshState();
              yield `sold ${result.quantity} ${item} @ ${result.priceEach}cr (total: ${result.total}cr)`;
            }
          } else {
            const cargoBeforeSell = ctx.cargo.getItemQuantity(ctx.ship, item);
            const creditsBefore = ctx.player.credits;
            const result = await ctx.api.sell(item, qty);
            await ctx.refreshState();
            const cargoAfterSell = ctx.cargo.getItemQuantity(ctx.ship, item);
            const creditsGained = ctx.player.credits - creditsBefore;

            // Detect actual sell even if API returns 0 (check credit change)
            const actuallySold = creditsGained > 0 || (cargoAfterSell < cargoBeforeSell);

            if (!actuallySold && result.priceEach === 0 && result.total === 0) {
              yield `no demand for ${item} at this station — blacklisting fleet-wide`;
              blacklistedItems.add(item);
              ctx.cache.markUnsellable(item);

              // Zero out cached sell price so arbitrage won't rediscover this route
              adjustMarketCache(ctx, sellStation, item, "sell", qty, { zeroDemand: true });

              // Try other stations with cached demand before dumping
              const remainingQty = ctx.cargo.getItemQuantity(ctx.ship, item);
              if (remainingQty > 0) {
                let soldElsewhere = false;
                const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
                for (const altStation of cachedStationIds) {
                  if (altStation === sellStation) continue;
                  const altPrices = ctx.cache.getMarketPrices(altStation);
                  const altSellPrice = altPrices?.find((p) => p.itemId === item)?.sellPrice ?? 0;
                  if (altSellPrice > 0 && (lastBuyPrice === 0 || altSellPrice >= lastBuyPrice)) {
                    yield `trying alternate station (sell @${altSellPrice}cr)`;
                    try {
                      await navigateAndDock(ctx, altStation);
                      const altResult = await ctx.api.sell(item, remainingQty);
                      await ctx.refreshState();
                      if (altResult.total > 0) {
                        yield `sold ${altResult.quantity} ${item} @ ${altResult.priceEach}cr at alternate station (total: ${altResult.total}cr)`;
                        recordSellResult(ctx, altStation, altResult.itemId || item, item, altResult.priceEach, altResult.quantity);
                        soldElsewhere = true;
                        break;
                      }
                    } catch {
                      // Try next station
                    }
                  }
                }

                // Last resort: deposit to faction storage
                if (!soldElsewhere) {
                  const finalQty = ctx.cargo.getItemQuantity(ctx.ship, item);
                  if (finalQty > 0 && ctx.player.dockedAtBase) {
                    try {
                      await ctx.api.factionDepositItems(item, finalQty);
                      ctx.cache.invalidateFactionStorage();
                      await ctx.refreshState();
                      yield `deposited ${finalQty} ${item} to faction storage (no buyers found)`;
                    } catch {
                      // Not a faction storage station — will try next cycle
                    }
                  }
                }
              }
            } else {
              // Successful sell — use actual credit gain if API response was weird
              const soldQty = actuallySold && result.quantity === 0
                ? cargoBeforeSell - cargoAfterSell
                : result.quantity;
              const soldPrice = creditsGained > 0 && result.priceEach === 0
                ? Math.round(creditsGained / Math.max(1, soldQty))
                : result.priceEach;
              const soldTotal = creditsGained > 0 ? creditsGained : result.total;

              if (cargoAfterSell >= cargoBeforeSell && result.quantity > 0) {
                yield `sell warning: API reports ${result.quantity} sold but cargo unchanged (${cargoBeforeSell} → ${cargoAfterSell})`;
              }
              yield typedYield(`sold ${soldQty} ${item} @ ${soldPrice}cr (total: ${soldTotal}cr)`, {
                type: "trade_sell", botId: ctx.botId, itemId: item,
                quantity: soldQty, priceEach: soldPrice, total: soldTotal, stationId: sellStation,
              });
              recordSellResult(ctx, sellStation, result.itemId || item, item, soldPrice, soldQty);
              adjustMarketCache(ctx, sellStation, item, "sell", soldQty);
            }
          }
        } catch (err) {
          yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // Also sell any other cargo items we might have picked up
    if (ctx.ship.cargo.length > 0) {
      const otherItems = ctx.ship.cargo.filter((c) => c.itemId !== item && !isProtectedItem(c.itemId));
      let soldOther = false;
      for (const other of otherItems) {
        try {
          const result = await ctx.api.sell(other.itemId, other.quantity);
          if (result.quantity > 0 && result.total > 0) {
            yield `sold ${result.quantity} ${other.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
            soldOther = true;
          }
        } catch {
          // Non-critical — some items may not be sellable here
        }
      }
      if (soldOther) await ctx.refreshState();
    }

    // ── Multi-hop: buy something here for the return trip ──
    if (!ctx.shouldStop && ctx.player.dockedAtBase && ctx.cargo.freeSpace(ctx.ship) > 0) {
      const returnMarket = await ctx.api.viewMarket();
      if (returnMarket.length > 0) {
        cacheMarketData(ctx, sellStation, returnMarket);
        // Check if anything here sells for more at the buy station (or any known station)
        const freeWeight = ctx.cargo.freeSpace(ctx.ship);
        const cachedStations = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
        let bestReturnItem: { itemId: string; buyPrice: number; sellPrice: number; targetStation: string; qty: number; name: string } | null = null;
        let bestReturnProfit = 0;
        for (const order of returnMarket.filter((m) => m.type === "sell" && m.quantity > 0 && m.priceEach > 0 && !isOre(m.itemId) && !blacklistedItems.has(m.itemId))) {
          for (const sid of cachedStations) {
            if (sid === sellStation) continue;
            // Insight-gated price check (sell destination = sid)
            const gateCheck = isInsightGatedBuyAllowed(ctx, order.itemId, order.priceEach, sid);
            if (!gateCheck.allowed) continue;
            // Verify target station data is fresh (<30min)
            const freshness = ctx.cache.getAllMarketFreshness().find((f) => f.stationId === sid);
            if (!freshness || freshness.ageMs > 30 * 60_000) continue;
            const prices = ctx.cache.getMarketPrices(sid);
            const sellData = prices?.find((p) => p.itemId === order.itemId);
            if (sellData?.sellPrice && sellData.sellPrice > order.priceEach) {
              const profitPerUnit = sellData.sellPrice - order.priceEach;
              // Require 12%+ margin to guard against stale data (was 20% — too restrictive)
              if (profitPerUnit / order.priceEach < 0.12 || profitPerUnit < 10) continue;
              const itemSize = ctx.cargo.getItemSize(ctx.ship, order.itemId);
              const retSpendPct = (profitPerUnit / order.priceEach >= 0.25 && sellData.sellVolume > 0) ? 0.75 : 0.50;
              const returnSpendCap = Math.floor(ctx.player.credits * retSpendPct);
              const maxQty = Math.min(
                Math.floor(freeWeight / Math.max(1, itemSize)),
                Math.floor(returnSpendCap / order.priceEach),
                order.quantity,
              );
              const totalProfit = profitPerUnit * maxQty;
              if (totalProfit > bestReturnProfit && totalProfit > 200) {
                bestReturnProfit = totalProfit;
                bestReturnItem = { itemId: order.itemId, buyPrice: order.priceEach, sellPrice: sellData.sellPrice, targetStation: sid, qty: maxQty, name: order.itemName ?? order.itemId };
              }
            }
          }
        }
        if (bestReturnItem) {
          yield `multi-hop: buying ${bestReturnItem.qty} ${bestReturnItem.name} (+${bestReturnItem.sellPrice - bestReturnItem.buyPrice}cr/unit) for return trip`;
          try {
            await ctx.api.buy(bestReturnItem.itemId, bestReturnItem.qty);
            await ctx.refreshState();
            // Set up for next iteration to sell at the target station
            item = bestReturnItem.itemId;
            buyStation = sellStation;
            sellStation = bestReturnItem.targetStation;
            lastBuyPrice = bestReturnItem.buyPrice;
            maxBuyPrice = bestReturnItem.buyPrice;
            minSellPrice = bestReturnItem.sellPrice * 0.9;
          } catch (err) {
            yield `return buy failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    // ── Faction tax on profit ──
    const profit = ctx.player.credits - creditsBeforeSell;
    if (profit > 0) {
      const tax = await payFactionTax(ctx, profit);
      if (tax.message) yield tax.message;
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    // ── Service ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    // ── Collect scattered cargo on empty return trip ──
    // If cargo is now empty, pick up any personal storage items at current station
    if (ctx.player.dockedAtBase) {
      const nonProtectedCargo = ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId) && c.quantity > 0);
      if (nonProtectedCargo.length === 0) {
        const nCollected = await collectScatteredCargo(ctx);
        if (nCollected > 0) {
          yield `collected ${nCollected} scattered item type(s) from station storage`;
        }
      }
    }

    tripCount++;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
  }

  if (tripCount >= maxRoundTrips) {
    yield `completed ${tripCount} round trips`;
  }
}

// ── Insight-Gated Arbitrage Trip ──

/**
 * Single-trip arbitrage: find a route gated by demand insights, buy, sell.
 * Safety: pre-buy profit verify, 50% credit cap, demand volume cap,
 * loss prevention (deposit to faction instead of selling at a loss).
 */
async function* insightGatedArbitrageTrip(
  ctx: BotContext,
  blacklistedItems: Set<string> = new Set(),
): AsyncGenerator<RoutineYield, void, void> {
  // Refresh to clear stale state from faction sell loop
  await ctx.refreshState();

  const issue = safetyCheck(ctx);
  if (issue) {
    yield `emergency: ${issue}`;
    const handled = await handleEmergency(ctx);
    if (!handled) return;
  }

  // Discover arbitrage routes from cached market data
  const cachedStationIds = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
  if (cachedStationIds.length < 2) {
    yield "arbitrage: insufficient market data (need 2+ stations)";
    return;
  }

  const estFuelCost = ctx.nav?.estimateJumpFuel?.(ctx.ship) ?? 50;
  const routes = ctx.market.findArbitrage(
    cachedStationIds, ctx.player.currentSystem, ctx.cargo.freeSpace(ctx.ship), estFuelCost,
  ).filter((r) => !isOre(r.itemId) && !blacklistedItems.has(r.itemId));

  // Filter routes through insight gate
  const gatedRoutes = routes.filter((r) => {
    const gate = isInsightGatedBuyAllowed(ctx, r.itemId, r.buyPrice, r.sellStationId);
    return gate.allowed;
  });

  if (gatedRoutes.length === 0) {
    yield "arbitrage: no insight-gated routes available";
    return;
  }

  // Pick first unclaimed route (prevents fleet stampede — multiple traders racing same route)
  let route = gatedRoutes[0];
  for (const candidate of gatedRoutes) {
    if (await ctx.cache.claimArbitrageRoute(candidate.itemId, candidate.buyStationId, candidate.sellStationId, ctx.botId)) {
      route = candidate;
      break;
    }
    yield `arbitrage: ${candidate.itemName} @ ${candidate.buyStationId} → ${candidate.sellStationId} already claimed, trying next`;
  }
  // If all routes were claimed, the last candidate's claim attempt failed — skip
  if (await ctx.cache.isArbitrageRouteClaimed(route.itemId, route.buyStationId, route.sellStationId, ctx.botId)) {
    yield "arbitrage: all routes claimed by other traders";
    return;
  }

  yield `arbitrage: ${route.itemName} buy@${route.buyPrice}cr → sell@${route.sellPrice}cr (+${route.profitPerUnit}cr/unit, ${route.jumps} jumps)`;

  // Release claim helper — called on every exit path
  const releaseClaim = () => ctx.cache.releaseArbitrageRoute(route.itemId, route.buyStationId, route.sellStationId);

  // ── Navigate to buy station ──
  try {
    await navigateAndDock(ctx, route.buyStationId);
  } catch (err) {
    yield `arbitrage: buy station nav failed: ${err instanceof Error ? err.message : String(err)}`;
    releaseClaim();
    return;
  }
  if (ctx.shouldStop) { releaseClaim(); return; }

  // ── Scan live market and re-verify ──
  const liveMarket = await ctx.api.viewMarket();
  if (liveMarket.length > 0) {
    cacheMarketData(ctx, route.buyStationId, liveMarket);
  }

  const liveOrder = liveMarket.find(
    (m) => m.type === "sell" && m.itemId === route.itemId && m.quantity > 0 && m.priceEach > 0,
  );
  if (!liveOrder) {
    yield `arbitrage: ${route.itemName} no longer available at buy station`;
    releaseClaim();
    return;
  }

  // Re-check gate with live price
  const liveGate = isInsightGatedBuyAllowed(ctx, route.itemId, liveOrder.priceEach, route.sellStationId);
  if (!liveGate.allowed) {
    yield `arbitrage: buy blocked (live price): ${liveGate.reason}`;
    releaseClaim();
    return;
  }

  // Pre-buy profit check
  const sellStationPrices = ctx.cache.getMarketPrices(route.sellStationId);
  const expectedSellPrice = sellStationPrices?.find((p) => p.itemId === route.itemId)?.sellPrice ?? 0;
  if (expectedSellPrice <= liveOrder.priceEach) {
    yield `arbitrage: unprofitable at live prices (buy ${liveOrder.priceEach}cr >= sell ${expectedSellPrice}cr)`;
    releaseClaim();
    return;
  }

  // Calculate buy quantity with all guards
  const freeWeight = ctx.cargo.freeSpace(ctx.ship);
  const itemSize = ctx.cargo.getItemSize(ctx.ship, route.itemId);
  const sellDemandVol = sellStationPrices?.find((p) => p.itemId === route.itemId)?.sellVolume ?? 0;
  // Conservative spend cap — limit exposure on stale market data.
  // High-value items (>5k/unit) get tighter cap to prevent 1M credit wipeouts.
  const highValue = liveOrder.priceEach > 5000;
  const arbSpendPct = highValue ? 0.15 : (sellDemandVol > 0 ? 0.40 : 0.25);
  const spendCap = Math.floor(ctx.player.credits * arbSpendPct);
  let buyQty = Math.floor(freeWeight / Math.max(1, itemSize));
  if (liveOrder.priceEach > 0) {
    buyQty = Math.min(buyQty, Math.floor(spendCap / liveOrder.priceEach));
  }
  buyQty = Math.min(buyQty, liveOrder.quantity);
  if (sellDemandVol > 0) {
    buyQty = Math.min(buyQty, sellDemandVol);
  }

  if (buyQty <= 0) {
    yield `arbitrage: cannot afford ${route.itemName} (${liveOrder.priceEach}cr each, have ${ctx.player.credits}cr)`;
    return;
  }

  // ── Buy ──
  yield `arbitrage: buying ${buyQty} ${route.itemName} @ ${liveOrder.priceEach}cr`;
  let actualBuyPrice = liveOrder.priceEach;
  try {
    const result = await ctx.api.buy(route.itemId, buyQty);
    await ctx.refreshState();
    actualBuyPrice = result.priceEach > 0 ? result.priceEach : liveOrder.priceEach;
    adjustMarketCache(ctx, route.buyStationId, route.itemId, "buy", result.quantity);
    yield `arbitrage: bought ${result.quantity} @ ${actualBuyPrice}cr each`;
  } catch (err) {
    yield `arbitrage: buy failed: ${err instanceof Error ? err.message : String(err)}`;
    releaseClaim();
    return;
  }
  if (ctx.shouldStop) { releaseClaim(); return; }

  // ── Navigate to sell station ──
  try {
    await navigateAndDock(ctx, route.sellStationId);
  } catch (err) {
    yield `arbitrage: sell station nav failed: ${err instanceof Error ? err.message : String(err)}`;
    // Try to deposit to faction storage instead of losing cargo
    try {
      await findAndDock(ctx);
      await sellAllCargo(ctx);
      yield "arbitrage: sold at fallback station";
    } catch { yield "arbitrage: cargo stranded"; }
    releaseClaim();
    return;
  }
  if (ctx.shouldStop) { releaseClaim(); return; }

  // ── Scan sell market and verify profit ──
  const sellMarket = await ctx.api.viewMarket();
  if (sellMarket.length > 0) {
    cacheMarketData(ctx, route.sellStationId, sellMarket);
  }

  const cargoQty = ctx.cargo.getItemQuantity(ctx.ship, route.itemId);
  if (cargoQty <= 0) {
    yield "arbitrage: no cargo to sell (lost in transit?)";
    releaseClaim();
    return;
  }

  // Loss prevention: if no buy orders or sell price < buy price, deposit to faction instead
  const liveSellOrder = sellMarket.find(
    (m) => m.type === "buy" && m.itemId === route.itemId && m.quantity > 0,
  );
  const liveSellPrice = liveSellOrder?.priceEach ?? 0;
  if (liveSellPrice <= 0) {
    yield `arbitrage: no buy orders for ${route.itemName} at sell station — depositing to faction`;
    try {
      await ctx.api.depositItems(route.itemId, cargoQty);
      await ctx.refreshState();
      yield `arb deposited ${cargoQty} ${route.itemName} to faction (buy order gone)`;
    } catch {
      // Fallback: sell at whatever price is available
      try {
        const result = await ctx.api.sell(route.itemId, cargoQty);
        await ctx.refreshState();
        if (result.quantity > 0) {
          recordSellResult(ctx, route.sellStationId, route.itemId, route.itemName, result.priceEach, result.quantity);
          yield `arbitrage: sold ${result.quantity} @ ${result.priceEach}cr (no buy order, best-effort)`;
        } else {
          yield `arbitrage: sell returned 0 — blacklisting ${route.itemName} this session`;
        }
      } catch { /* cargo stranded */ }
    }
    releaseClaim();
    return;
  }
  if (liveSellPrice < actualBuyPrice) {
    yield `arbitrage: would sell at loss (${liveSellPrice}cr < ${actualBuyPrice}cr) — depositing to faction`;
    try {
      await ctx.api.depositItems(route.itemId, cargoQty);
      await ctx.refreshState();
      yield `arb deposited ${cargoQty} items to faction (saved from loss)`;
    } catch {
      // Fallback: sell anyway rather than waste cargo space
      yield "arbitrage: faction deposit failed — selling at reduced price";
      try {
        const result = await ctx.api.sell(route.itemId, cargoQty);
        await ctx.refreshState();
        recordSellResult(ctx, route.sellStationId, route.itemId, route.itemName, result.priceEach, result.quantity);
        yield `arbitrage: sold ${result.quantity} @ ${result.priceEach}cr (loss accepted)`;
      } catch { /* cargo stranded */ }
    }
    releaseClaim();
    return;
  }

  // ── Sell ──
  const creditsBeforeSell = ctx.player.credits;
  try {
    const result = await ctx.api.sell(route.itemId, cargoQty);
    await ctx.refreshState();
    adjustMarketCache(ctx, route.sellStationId, route.itemId, "sell", result.quantity);

    if (result.quantity > 0) {
      recordSellResult(ctx, route.sellStationId, route.itemId, route.itemName, result.priceEach, result.quantity);
      const actualPrice = result.priceEach > 0 ? result.priceEach : liveSellPrice;
      yield `arbitrage: sold ${result.quantity} ${route.itemName} @ ${actualPrice}cr each (${result.total}cr)`;
    } else {
      // Sell returned 0 — buy order was ghost/filled. Deposit to faction instead of wasting the trip.
      yield `arbitrage: sell returned 0 for ${route.itemName} — buy order gone, depositing to faction`;
      adjustMarketCache(ctx, route.sellStationId, route.itemId, "sell", 0, { zeroDemand: true });
      const remainingQty = ctx.cargo.getItemQuantity(ctx.ship, route.itemId);
      if (remainingQty > 0) {
        try {
          await ctx.api.factionDepositItems(route.itemId, remainingQty);
          ctx.cache.invalidateFactionStorage();
          await ctx.refreshState();
          yield `arb deposited ${remainingQty} ${route.itemName} to faction (will sell later)`;
        } catch {
          try {
            await ctx.api.depositItems(route.itemId, remainingQty);
            await ctx.refreshState();
            yield `arb deposited ${remainingQty} ${route.itemName} to station storage`;
          } catch { /* cargo stranded — will be handled by disposal */ }
        }
      }
    }
  } catch (err) {
    yield `arbitrage: sell failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  releaseClaim();

  // ── Faction tax on profit ──
  const profit = ctx.player.credits - creditsBeforeSell;
  if (profit > 0) {
    const tax = await payFactionTax(ctx, profit);
    if (tax.message) yield tax.message;
  }

  // ── Service ──
  await refuelIfNeeded(ctx);
}

// ── Faction Supply Chain Selling ──

/**
 * Withdraw crafted goods from faction storage, sell at best station.
 * Flow: dock at faction station → check storage → withdraw most valuable → sell at station with demand
 */
async function* factionSellLoop(
  ctx: BotContext,
  maxTrips: number,
  blacklistedItems: Set<string> = new Set(),
): AsyncGenerator<RoutineYield, void, void> {
  let tripCount = 0;
  let navFailures = 0;

  while (!ctx.shouldStop && tripCount < maxTrips) {
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // ── Navigate to faction storage station ──
    const factionStation = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
    if (!factionStation) {
      yield "no faction storage station configured";
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
      return;
    }

    yield "traveling to faction storage";
    try {
      await navigateAndDock(ctx, factionStation);
      navFailures = 0; // Reset on success
    } catch (err) {
      navFailures++;
      yield `navigation failed (${navFailures}/3): ${err instanceof Error ? err.message : String(err)}`;
      if (navFailures >= 3) {
        yield "navigation to faction storage failed 3 times — aborting";
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
        return;
      }
      await interruptibleSleep(ctx, 60_000);
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
      continue;
    }

    if (ctx.shouldStop) return;

    // ── Opportunistic market scan (populates cache for route finding) ──
    if (ctx.player.dockedAtBase) {
      const freshness = ctx.cache.getMarketFreshness(ctx.player.dockedAtBase);
      if (!freshness.fresh) {
        try {
          await fleetViewMarket(ctx, ctx.player.dockedAtBase);
        } catch { /* non-critical */ }
      }
    }

    // ── Check faction storage for valuable items ──
    let storageItems: Array<{ itemId: string; quantity: number }> = [];
    try {
      const { items: storage } = await fleetViewFactionStorage(ctx);
      storageItems = storage
        .filter((s) => s.quantity > 0)
        .map((s) => ({ itemId: s.itemId, quantity: s.quantity }));
    } catch (err) {
      yield `faction storage check failed: ${err instanceof Error ? err.message : String(err)}`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
      return;
    }

    if (storageItems.length === 0) {
      yield "faction storage empty — nothing to sell";
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
      return; // Exit entirely — rapid-complete will flag for reassignment
    }

    // ── Pre-select sell station BEFORE withdrawing ──
    // Only consider items with KNOWN buyers (cached sellPrice > 0 at some station).
    // This prevents blind withdrawals that end up re-deposited.
    const cachedStations = ctx.cache.getAllMarketFreshness().map((f) => f.stationId);
    // Prioritize refined/crafted goods — ore is worth far more processed
    // Only include ores when massively overstocked (10k+ per type)
    const facilityNeeds = ctx.cache.getFacilityMaterialNeeds();
    let nonOreStorage = storageItems.filter((s) =>
      s.quantity > 0 && !isOre(s.itemId)
      && !blacklistedItems.has(s.itemId)
      && !facilityNeeds.has(s.itemId)
    );

    // Never sell raw ore — always refine through crafters first
    // Ore is worth far more as crafted goods

    if (nonOreStorage.length === 0) {
      const blCount = blacklistedItems.size;
      yield `all sellable items blacklisted (${blCount} item${blCount !== 1 ? "s" : ""}) — nothing tradeable`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
      return; // Exit entirely — rapid-complete will flag for reassignment
    }

    // Build a ranked list of stations by total revenue for items in storage
    const stationBids: Array<{
      stationId: string;
      revenue: number;
      jumps: number;
      items: Array<{ itemId: string; name: string; qty: number; price: number }>;
    }> = [];

    for (const stationId of cachedStations) {
      if (stationId === factionStation) continue;
      const prices = ctx.cache.getMarketPrices(stationId);
      if (!prices) continue;
      const sellSystemId = ctx.galaxy.getSystemForBase(stationId);
      const jumps = sellSystemId ? ctx.galaxy.getDistance(ctx.player.currentSystem, sellSystemId) : -1;
      if (jumps < 0) continue;

      const stationItems: typeof stationBids[0]["items"] = [];
      let revenue = 0;
      for (const si of nonOreStorage) {
        const priceData = prices.find((p) => p.itemId === si.itemId);
        if (priceData?.sellPrice && priceData.sellPrice > 0) {
          // Cap quantity by sellVolume (actual buy order volume) — don't assume infinite demand
          const qty = priceData.sellVolume > 0 ? Math.min(si.quantity, priceData.sellVolume) : si.quantity;
          const total = priceData.sellPrice * qty;
          revenue += total;
          stationItems.push({ itemId: si.itemId, name: ctx.crafting.getItemName(si.itemId), qty, price: priceData.sellPrice });
        }
      }

      if (revenue <= 0) continue;
      // Fuel cost: round trip × estimated fuel/jump × ~15cr per fuel unit
      const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);
      const fuelCost = jumps * 2 * fuelPerJump * 15;
      const netRevenue = revenue - fuelCost;

      // Boost from market insights: demand signals increase station attractiveness
      let insightBoost = 0;
      const stationInsights = ctx.cache.getMarketInsights(stationId);
      if (stationInsights) {
        for (const insight of stationInsights) {
          if (insight.category === "demand" && stationItems.some((si) => si.itemId === insight.item_id)) {
            insightBoost += insight.priority * 10;
          }
        }
        // Discover sell opportunities from insights for items not in cached prices
        for (const insight of stationInsights) {
          if (insight.category !== "demand") continue;
          if (stationItems.some((si) => si.itemId === insight.item_id)) continue;
          const storageItem = nonOreStorage.find((s) => s.itemId === insight.item_id);
          if (!storageItem) continue;
          const estPrice = ctx.crafting.getEffectiveSellPrice(insight.item_id);
          if (estPrice > 0) {
            revenue += estPrice * storageItem.quantity;
            stationItems.push({ itemId: insight.item_id, name: insight.item, qty: storageItem.quantity, price: estPrice });
          }
        }
      }

      const boostedRevenue = netRevenue + insightBoost;
      // Minimum trip profit: 500cr base + 200cr per jump (round trip)
      // A 10-jump route must earn at least 4500cr net to be worth the fuel + time
      const minTripProfit = 500 + jumps * 2 * 200;
      if (boostedRevenue >= minTripProfit) {
        stationBids.push({ stationId, revenue: boostedRevenue, jumps, items: stationItems });
      }
    }

    // Rank by revenue per tick (travel-time-adjusted, speed-aware since v0.188.0)
    const ticksPerJump = ctx.nav.estimateJumpTicks(ctx.ship);
    stationBids.sort((a, b) => {
      const aTicks = Math.max(1, a.jumps * 2 * ticksPerJump + 4); // round trip + overhead
      const bTicks = Math.max(1, b.jumps * 2 * ticksPerJump + 4);
      return (b.revenue / bTicks) - (a.revenue / aTicks);
    });

    if (stationBids.length === 0) {
      yield "no known buyers — will try sell orders at home station";
      // Fall through: withdraw goods, skip station loop, sell order fallback handles listing
    }

    // Use the top bid's items as what to withdraw (only items with confirmed buyers)
    // When no bids exist, withdraw all non-ore items for sell order listing at home
    const topBid = stationBids[0] ?? null;
    const sellable = topBid
      ? topBid.items.map((i) => ({
          itemId: i.itemId,
          quantity: i.qty,
          basePrice: i.price,
          name: i.name,
        }))
      : nonOreStorage
          .map((s) => ({
            itemId: s.itemId,
            quantity: s.quantity,
            basePrice: ctx.crafting.getEffectiveSellPrice(s.itemId),
            name: ctx.crafting.getItemName(s.itemId),
          }))
          .filter((s) => s.basePrice > 0 && !ctx.cache.isUnsellable(s.itemId)) // Skip zero-value & blacklisted items
          .sort((a, b) => {
            // Raw materials last, then by value descending (highest-tier first)
            const aRaw = ctx.crafting.isRawMaterial(a.itemId) ? 1 : 0;
            const bRaw = ctx.crafting.isRawMaterial(b.itemId) ? 1 : 0;
            if (aRaw !== bRaw) return aRaw - bRaw;
            return b.basePrice - a.basePrice;
          });

    if (topBid) {
      yield `${stationBids.length} station(s) want our goods — best: ~${topBid.revenue}cr net (${topBid.jumps} jumps)`;
    }

    // ── Free up cargo space if needed (leftover from previous routine) ──
    if (ctx.cargo.freeSpace(ctx.ship) <= 0 && ctx.ship.cargo.length > 0 && ctx.player.dockedAtBase) {
      yield "clearing cargo before faction withdrawal";
      let clearedAny = false;
      for (const c of [...ctx.ship.cargo]) {
        if (isProtectedItem(c.itemId)) continue;
        // Deposit to faction storage first (free, keeps goods in supply chain)
        try {
          await ctx.api.factionDepositItems(c.itemId, c.quantity);
          ctx.cache.invalidateFactionStorage();
          yield `deposited ${c.quantity} ${c.itemId} to faction storage`;
          clearedAny = true;
          continue;
        } catch { /* try sell */ }
        // Sell as fallback
        try {
          const result = await ctx.api.sell(c.itemId, c.quantity);
          if (result.total > 0) {
            yield `sold ${result.quantity} ${c.itemId} @ ${result.priceEach}cr`;
            clearedAny = true;
          }
        } catch { /* skip */ }
      }
      if (clearedAny) await ctx.refreshState();
    }

    // ── Withdraw valuable items — fill cargo with multiple types ──
    const withdrawnItems: Array<{ itemId: string; qty: number; name: string }> = [];

    for (const item of sellable) {
      if (ctx.shouldStop) return;
      // Only withdraw ore with confirmed buyer or when massively overstocked (10k+)
      // Ore is worth far more refined — keep it for crafters
      if (!topBid && isOre(item.itemId)) continue;
      const freeWeight = ctx.cargo.freeSpace(ctx.ship); // Recalculate each iteration
      if (freeWeight <= 0) break; // Cargo full

      const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
      const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
      const withdrawQty = Math.min(item.quantity, maxByWeight);

      if (withdrawQty <= 0) continue;

      yield `withdrawing ${withdrawQty} ${item.name} from faction storage`;
      let actualQty = withdrawQty;
      try {
        const cargoBefore = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        await withdrawFromFaction(ctx, item.itemId, actualQty);
        await ctx.refreshState();
        const cargoAfter = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
        const actualReceived = cargoAfter - cargoBefore;
        if (actualReceived <= 0) {
          yield `withdraw warning: cargo unchanged after withdrawing ${actualQty} ${item.name}`;
          continue; // Try next item
        }
        withdrawnItems.push({ itemId: item.itemId, qty: actualReceived, name: item.name });
        yield `withdrew ${actualReceived} ${item.name} (${item.basePrice}cr base value)`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // cargo_full: item weighs more than 1 per unit — retry with halved qty
        if (msg.includes("cargo_full") && actualQty > 1) {
          actualQty = Math.max(1, Math.floor(actualQty / 2));
          yield `retrying with ${actualQty} ${item.name} (item heavier than expected)`;
          try {
            const cargoBefore = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
            await withdrawFromFaction(ctx, item.itemId, actualQty);
            await ctx.refreshState();
            const cargoAfter = ctx.cargo.getItemQuantity(ctx.ship, item.itemId);
            const actualReceived = cargoAfter - cargoBefore;
            if (actualReceived > 0) {
              withdrawnItems.push({ itemId: item.itemId, qty: actualReceived, name: item.name });
              yield `withdrew ${actualReceived} ${item.name}`;
            }
          } catch (retryErr) {
            yield `retry withdraw failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`;
          }
        } else {
          yield `withdraw failed: ${msg}`;
        }
      }
    }

    if (withdrawnItems.length === 0) {
      yield "could not withdraw any items — nothing tradeable";
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
      return; // Exit entirely — rapid-complete will flag for reassignment
    }

    if (withdrawnItems.length > 1) {
      yield `loaded ${withdrawnItems.length} item types (${withdrawnItems.reduce((s, w) => s + w.qty, 0)} total units)`;
    }

    if (ctx.shouldStop) return;

    // ── Direct sell at home station when no known buyers ──
    // We're already docked — try selling here before traveling anywhere
    let sold = false;
    const factionSellCreditsBefore = ctx.player.credits;

    if (!topBid && ctx.player.dockedAtBase) {
      for (const wi of withdrawnItems) {
        if (ctx.shouldStop) return;
        const qty = ctx.cargo.getItemQuantity(ctx.ship, wi.itemId);
        if (qty <= 0) continue;
        try {
          const result = await ctx.api.sell(wi.itemId, qty);
          await ctx.refreshState();
          if (result.total > 0) {
            yield `sold ${result.quantity} ${wi.name} @ ${result.priceEach}cr (${result.total}cr) — home station direct`;
            recordSellResult(ctx, factionStation, wi.itemId, wi.itemId, result.priceEach, result.quantity);
            sold = true;
          }
        } catch (err) {
          yield `home sell failed for ${wi.name}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // ── Try sell stations in ranked order (best revenue first) ──
    // If first station fails (nav error, no demand), try the next one.
    // Only re-deposit as last resort after all known buyers exhausted.
    for (let bidIdx = 0; bidIdx < Math.min(stationBids.length, 3); bidIdx++) {
      if (ctx.shouldStop) return;
      const bid = stationBids[bidIdx];

      yield `trying station ${bidIdx + 1}/${Math.min(stationBids.length, 3)}: ~${bid.revenue}cr expected (${bid.jumps} jumps)`;
      try {
        await navigateAndDock(ctx, bid.stationId);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        continue; // Try next station
      }

      // Refresh market cache while docked (helps future route finding)
      if (ctx.player.dockedAtBase) {
        try {
          await fleetViewMarket(ctx, ctx.player.dockedAtBase);
        } catch { /* non-critical */ }
      }

      // Sell all withdrawn items at this station
      let stationSoldAny = false;
      const withdrawnIds = new Set(withdrawnItems.map((w) => w.itemId));
      for (const wi of withdrawnItems) {
        const qty = ctx.cargo.getItemQuantity(ctx.ship, wi.itemId);
        if (qty <= 0) continue;
        yield `selling ${qty} ${wi.name}`;
        try {
          const result = await ctx.api.sell(wi.itemId, qty);
          await ctx.refreshState();
          if (result.total > 0) {
            yield `sold ${result.quantity} ${wi.itemId} @ ${result.priceEach}cr (total: ${result.total}cr)`;
            recordSellResult(ctx, bid.stationId, wi.itemId, wi.itemId, result.priceEach, result.quantity);
            stationSoldAny = true;
          } else {
            yield `no demand for ${wi.name} at this station`;
          }
        } catch (err) {
          yield `sell failed for ${wi.name}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Also sell any other non-ore cargo while docked
      for (const cargo of ctx.ship.cargo) {
        if (withdrawnIds.has(cargo.itemId) || isOre(cargo.itemId) || isProtectedItem(cargo.itemId)) continue;
        try {
          const result = await ctx.api.sell(cargo.itemId, cargo.quantity);
          await ctx.refreshState();
          if (result.total > 0) {
            yield `sold ${result.quantity} ${cargo.itemId} @ ${result.priceEach}cr = ${result.total}cr`;
            stationSoldAny = true;
          }
        } catch { /* non-critical */ }
      }

      if (stationSoldAny) {
        sold = true;
        // Check if cargo is empty — no need to try more stations
        const remainingCargo = ctx.ship.cargo.filter((c) => !isOre(c.itemId) && !isProtectedItem(c.itemId) && c.quantity > 0);
        if (remainingCargo.length === 0) break;
        yield `${remainingCargo.length} item(s) unsold — trying next station`;
      } else {
        yield "nothing sold here — trying next station";
      }
    }

    // ── Sell order fallback for unsold cargo ──
    // Before re-depositing, try to create sell orders at current station
    const unsoldForOrders = ctx.ship.cargo
      .filter((c) => !isOre(c.itemId) && !isProtectedItem(c.itemId) && c.quantity > 0)
      .sort((a, b) => {
        const aRaw = ctx.crafting.isRawMaterial(a.itemId) ? 1 : 0;
        const bRaw = ctx.crafting.isRawMaterial(b.itemId) ? 1 : 0;
        if (aRaw !== bRaw) return aRaw - bRaw;
        return ctx.crafting.getEffectiveSellPrice(b.itemId) - ctx.crafting.getEffectiveSellPrice(a.itemId);
      });
    if (unsoldForOrders.length > 0 && ctx.player.dockedAtBase) {
      const orderStationIds = cachedStations.filter((id) => id !== ctx.player.dockedAtBase);
      for (const c of unsoldForOrders) {
        if (ctx.shouldStop) return;
        const costBasis = estimateCostBasis(ctx, c.itemId);
        const pricing = calculateSellPrice(ctx, c.itemId, costBasis, orderStationIds, ctx.player.dockedAtBase!, 0.15);
        if (!pricing || pricing.listPrice * c.quantity < 100) continue; // Skip low-value listings
        try {
          await ctx.api.createSellOrder(c.itemId, c.quantity, pricing.listPrice);
          await ctx.refreshState();
          const itemName = ctx.crafting.getItemName(c.itemId) || c.itemId;
          yield `listed ${c.quantity} ${itemName} @ ${pricing.listPrice}cr (sell order fallback)`;
          sold = true;
        } catch (err) {
          yield `sell order failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // Re-deposit anything still in cargo after sell orders
    const unsoldCargo = ctx.ship.cargo.filter((c) => !isOre(c.itemId) && !isProtectedItem(c.itemId) && c.quantity > 0);
    if (unsoldCargo.length > 0) {
      // Blacklist unsold items so we don't loop on them
      for (const c of unsoldCargo) {
        if (withdrawnItems.some((w) => w.itemId === c.itemId)) {
          blacklistedItems.add(c.itemId);
          ctx.cache.markUnsellable(c.itemId);
          yield `blacklisted ${ctx.crafting.getItemName(c.itemId)} — unsellable fleet-wide`;
        }
      }
      if (!sold) {
        yield "all sell attempts failed — re-depositing cargo";
      }
      // Navigate back to faction station if not already there
      const atFaction = ctx.player.dockedAtBase === factionStation;
      try {
        if (!atFaction) await navigateAndDock(ctx, factionStation);
        for (const c of unsoldCargo) {
          try {
            await ctx.api.factionDepositItems(c.itemId, c.quantity);
            ctx.cache.invalidateFactionStorage();
            yield `re-deposited ${c.quantity} ${ctx.crafting.getItemName(c.itemId)}`;
          } catch { /* best effort */ }
        }
        await ctx.refreshState();
      } catch {
        yield "could not return to faction station — cargo stranded";
      }
    }

    // Faction tax on sell profits
    const factionSellProfit = ctx.player.credits - factionSellCreditsBefore;
    if (factionSellProfit > 0) {
      const tax = await payFactionTax(ctx, factionSellProfit);
      if (tax.message) yield tax.message;
    }

    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    tripCount++;

    // If nothing sold this cycle, exit loop so hybrid arbitrage can fire
    if (!sold) {
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
      return;
    }

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "trader" });
  }
}
