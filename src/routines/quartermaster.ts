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
  MAX_MATERIAL_BUY_PRICE,
} from "./helpers";

// Equipment modules to accumulate for fleet use
const MODULE_TARGETS = [
  { pattern: "ice_harvester", target: 4, label: "Ice Harvester", fallbackIds: ["ice_harvester_1", "ice_harvester_2"], fallbackPrice: 15000 },
  { pattern: "gas_harvester", target: 4, label: "Gas Harvester", fallbackIds: ["gas_harvester_1", "gas_harvester_2"], fallbackPrice: 15000 },
  { pattern: "survey", target: 3, label: "Survey Scanner", fallbackIds: ["survey_scanner_1", "survey_scanner_2"], fallbackPrice: 20000 },
];

// Items that look like ship modules (don't sell these from faction storage)
const MODULE_PATTERNS = [
  "harvester", "scanner", "laser", "cannon", "turret",
  "shield", "armor", "engine", "thruster", "cloak",
  "tow", "salvage", "drill", "weapon", "mod_", "module",
];

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

    // ── 1. Sell faction goods at competitive prices ──
    yield* manageFactionSales(ctx, homeBase, market, undercutPct, listedItems, oversizedItems, trackedSellOrders, adState);

    if (ctx.shouldStop) return;

    // ── 2. Buy equipment modules for fleet ──
    yield* buyEquipmentModules(ctx, homeBase, market, moduleTarget);

    if (ctx.shouldStop) return;

    // ── 3. Check and collect filled buy orders ──
    // Modules bought via buy orders arrive in cargo — deposit them to faction storage
    yield* collectFilledOrders(ctx);

    if (ctx.shouldStop) return;

    // ── 4. Manage supply chain buy orders ──
    yield* manageMaterialBuyOrders(
      ctx, homeBase, market, trackedMaterialOrders,
      buyOrderBudgetPct, maxOrderAge, adState,
    );

    if (ctx.shouldStop) return;

    // ── 5. Faction facility management (check & upgrade) ──
    yield* manageFactionFacilities(ctx);

    if (ctx.shouldStop) return;

    await refuelIfNeeded(ctx);

    // Moderate cycle — shorter sleep to capitalize on opportunities faster
    await interruptibleSleep(ctx, 30_000);
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
): AsyncGenerator<RoutineYield, void, void> {
  const now = Date.now();

  // Get faction storage
  let storageItems: Array<{ itemId: string; quantity: number }> = [];
  try {
    const storage = await ctx.api.viewFactionStorage();
    storageItems = (storage ?? []).filter((s) => s.quantity > 0);
  } catch (err) {
    yield `faction storage check failed: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  if (storageItems.length === 0) {
    yield "faction storage empty";
    return;
  }

  // Filter for sellable goods (not raw ores unless 5000+; modules only if excess above fleet targets)
  const sellable: Array<{ itemId: string; quantity: number }> = [];
  for (const s of storageItems) {
    const isOre = s.itemId.startsWith("ore_") || s.itemId.endsWith("_ore");
    if (isOre && s.quantity < 5000) continue; // Keep ores for crafters unless overstocked

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

  if (sellable.length === 0) {
    const oreCount = storageItems.filter((s) => s.itemId.startsWith("ore_") || s.itemId.endsWith("_ore")).length;
    const modCount = storageItems.filter((s) => isModuleItem(s.itemId)).length;
    yield `faction storage: ${oreCount} ore type(s), ${modCount} module type(s) — nothing to sell`;
    return;
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

    const priceResult = calculateSellPrice(ctx, tracked.itemId, tracked.costBasis, cachedStationIds, homeBase, undercutPct);
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

  // ── Cancel truly stale sell orders (>2 hours unfilled) ──
  let cancelActions = 0;
  for (const [orderId, tracked] of trackedSellOrders) {
    if (ctx.shouldStop || cancelActions >= 2) break;

    const age = now - tracked.placedAt;
    if (age < 7_200_000) continue; // < 2 hours — keep trying

    try {
      await ctx.api.cancelOrder(orderId);
      alreadyListed.delete(tracked.itemId);
      listedItems.delete(tracked.itemId);
      trackedSellOrders.delete(orderId);
      cancelActions++;
      yield `cancelled stale sell order: ${tracked.quantity}x ${tracked.itemName} @ ${tracked.priceEach}cr (>2h unfilled)`;
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
    const costBasis = estimateCostBasis(ctx, item.itemId);

    if (costBasis <= 0) {
      // Fallback: use any known market price as cost basis
      let fallbackCost = 0;
      for (const stationId of [...cachedStationIds, homeBase]) {
        const prices = ctx.cache.getMarketPrices(stationId);
        const p = prices?.find((pd) => pd.itemId === item.itemId);
        if (p?.sellPrice && p.sellPrice > fallbackCost) fallbackCost = p.sellPrice;
        if (p?.buyPrice && p.buyPrice > fallbackCost) fallbackCost = p.buyPrice;
      }
      if (fallbackCost <= 0) continue; // Truly unknown — can't price it
    }

    const effectiveCostBasis = costBasis > 0 ? costBasis : (() => {
      let fb = 0;
      for (const stationId of [...cachedStationIds, homeBase]) {
        const prices = ctx.cache.getMarketPrices(stationId);
        const p = prices?.find((pd) => pd.itemId === item.itemId);
        if (p?.sellPrice && p.sellPrice > fb) fb = p.sellPrice;
        if (p?.buyPrice && p.buyPrice > fb) fb = p.buyPrice;
      }
      return fb;
    })();

    const priceResult = calculateSellPrice(ctx, item.itemId, effectiveCostBasis, cachedStationIds, homeBase, undercutPct);
    if (!priceResult) continue;

    const { listPrice, cheapestElsewhere } = priceResult;

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
        await ctx.api.factionWithdrawItems(item.itemId, listQty);
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
            await ctx.api.factionWithdrawItems(item.itemId, listQty);
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

      // ALWAYS try direct sell first — instant revenue at whatever the station pays.
      // Any sale > 0cr is better than a sell order sitting unfilled for hours.
      const directResult = await ctx.api.sell(item.itemId, sellQty);
      await ctx.refreshState();

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
            await ctx.refreshState();
          } catch { /* best effort */ }
        }
      } else {
        // No NPC buyer at this station — create a sell order as fallback
        // Check if ANY station has buy orders for this item (someone wants it)
        let hasBuyOrders = false;
        for (const sid of cachedStationIds) {
          const prices = ctx.cache.getMarketPrices(sid);
          const p = prices?.find((pd) => pd.itemId === item.itemId);
          if (p?.buyPrice && p.buyPrice > 0 && p.buyVolume > 0) { hasBuyOrders = true; break; }
        }

        // List if: buy orders exist anywhere (demand confirmed), or per-unit price is reasonable
        const worthListing = hasBuyOrders || listPrice >= 10;
        if (worthListing) {
          // Re-deposit to faction storage first, then create faction sell order
          try {
            await ctx.api.factionDepositItems(item.itemId, sellQty);
            await ctx.refreshState();
          } catch { /* best effort — may already be deposited */ }

          let result: Record<string, unknown>;
          try {
            result = await ctx.api.factionCreateSellOrder(item.itemId, listPrice, sellQty);
          } catch {
            // Faction orders not supported — fall back to personal sell order
            try {
              await ctx.api.factionWithdrawItems(item.itemId, sellQty);
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
          await ctx.refreshState();
        } catch { /* best effort */ }
      }
    }
  }

  if (ordersCreated === 0 && sellable.length > 0) {
    yield `${sellable.length} sellable item(s) in faction — no profitable listings found`;
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
  homeBase: string,
  localMarket: MarketOrder[],
  targetCount: number,
): AsyncGenerator<RoutineYield, void, void> {
  // Check faction storage for existing modules
  let storageItems: Array<{ itemId: string; quantity: number }> = [];
  try {
    const storage = await ctx.api.viewFactionStorage();
    storageItems = (storage ?? []).filter((s) => s.quantity > 0);
  } catch {
    return;
  }

  // Count modules per target type (faction storage + equipped on fleet bots)
  const fleet = ctx.getFleetStatus();
  const targets = MODULE_TARGETS.map((t) => {
    const inStorage = storageItems
      .filter((s) => s.itemId.includes(t.pattern))
      .reduce((sum, s) => sum + s.quantity, 0);
    const equippedOnBots = fleet.bots
      .filter((b) => b.moduleIds.some((m) => m.includes(t.pattern)))
      .length;
    return {
      ...t,
      target: Math.min(t.target, targetCount), // Respect param override
      count: inStorage + equippedOnBots,
      inStorage,
      equippedOnBots,
    };
  });

  // Report inventory
  const inv = targets.map((t) =>
    `${t.label}: ${t.count}/${t.target} (${t.inStorage} stored, ${t.equippedOnBots} equipped)`
  ).join(", ");
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
  for (const item of ctx.ship.cargo) {
    if (ctx.shouldStop) return;
    if (!isModuleItem(item.itemId)) continue;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      await ctx.refreshState();
      yield `deposited ${item.quantity}x ${item.itemId} to faction storage (filled order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
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
  homeBase: string,
  localMarket: MarketOrder[],
  tracked: Map<string, MaterialBuyOrder>,
  budgetPct: number,
  maxAge: number,
  adState: AdChatState,
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
  for (const item of ctx.ship.cargo) {
    if (ctx.shouldStop) return;
    if (isModuleItem(item.itemId)) continue; // Handled by collectFilledOrders
    if (item.itemId.startsWith("ore_") || item.itemId.endsWith("_ore")) continue;
    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      await ctx.refreshState();
      const itemName = ctx.crafting.getItemName(item.itemId) || item.itemId;
      yield `deposited ${item.quantity}x ${itemName} to faction (from buy order)`;
    } catch (err) {
      yield `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Update tracking for partially filled orders
  for (const order of myBuyOrders) {
    const t = tracked.get(order.id);
    if (t && order.remaining < t.quantity) {
      const filled = t.quantity - order.remaining;
      yield `buy order partial fill: ${t.itemName} x${filled}/${t.quantity}`;
      t.quantity = order.remaining;
    }
  }

  // ── Get faction storage for stock checks ──
  let factionStock = new Map<string, number>();
  try {
    const storage = await ctx.api.viewFactionStorage();
    for (const s of storage ?? []) {
      if (s.quantity > 0) factionStock.set(s.itemId, s.quantity);
    }
  } catch { /* proceed with empty stock */ }

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

    const priceInfo = calculateBuyPrice(ctx, order.itemId, recipe);
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
  const targets = identifyBuyOrderTargets(ctx, factionStock, remainingBudget);
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
 * Identify gap materials the fleet can't self-produce.
 * Walks all profitable recipes, finds inputs that aren't ores and aren't craftable.
 * Returns top 5 targets sorted by expected margin descending.
 */
function identifyBuyOrderTargets(
  ctx: BotContext,
  factionStock: Map<string, number>,
  budget: number,
): BuyOrderTarget[] {
  const recipes = ctx.crafting.getAllRecipes();
  const targets = new Map<string, BuyOrderTarget>();

  for (const recipe of recipes) {
    const { profit } = ctx.crafting.estimateMarketProfit(recipe.id);
    if (profit <= 0) continue;

    const rawMaterials = ctx.crafting.getRawMaterials(recipe.id);

    for (const [itemId, _qty] of rawMaterials) {
      // Skip ores (miners produce these)
      if (itemId.startsWith("ore_") || itemId.endsWith("_ore")) continue;
      // Skip craftable items (crafters handle these)
      if (ctx.crafting.isCraftable(itemId)) continue;

      // Check faction stock — skip if well-stocked
      const stock = factionStock.get(itemId) ?? 0;
      if (stock >= 20) continue;

      const quantityNeeded = Math.max(1, 20 - stock);

      // Calculate price from recipe profitability
      const priceInfo = calculateBuyPrice(ctx, itemId, recipe);
      if (!priceInfo) continue;

      const existing = targets.get(itemId);
      if (existing) {
        existing.recipeIds.push(recipe.id);
        // Use lowest maxBuyPrice across recipes (most conservative)
        if (priceInfo.maxBuyPrice < existing.maxBuyPrice) {
          existing.maxBuyPrice = priceInfo.maxBuyPrice;
          existing.recommendedPrice = priceInfo.recommendedPrice;
          existing.expectedMargin = priceInfo.expectedMargin;
        }
      } else {
        targets.set(itemId, {
          itemId,
          itemName: ctx.crafting.getItemName(itemId) || itemId,
          quantityNeeded,
          maxBuyPrice: priceInfo.maxBuyPrice,
          recommendedPrice: priceInfo.recommendedPrice,
          recipeIds: [recipe.id],
          expectedMargin: priceInfo.expectedMargin,
        });
      }
    }
  }

  return [...targets.values()]
    .sort((a, b) => b.expectedMargin - a.expectedMargin)
    .slice(0, 5);
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

  // Find cheapest sell price across all cached stations
  let cheapestSellPrice = Infinity;
  const freshness = ctx.cache.getAllMarketFreshness();
  for (const { stationId } of freshness) {
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;
    const p = prices.find((pd) => pd.itemId === gapItemId);
    if (p?.buyPrice && p.buyPrice > 0 && p.buyPrice < cheapestSellPrice) {
      cheapestSellPrice = p.buyPrice;
    }
  }

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
 * Runs once per cycle — checks for available upgrades on existing facilities,
 * and builds essential missing facilities if the faction can afford it.
 */
async function* manageFactionFacilities(
  ctx: BotContext,
): AsyncGenerator<RoutineYield, void, void> {
  // List faction facilities at current station
  let facilities: Array<Record<string, unknown>> = [];
  try {
    facilities = await ctx.api.factionListFacilities();
  } catch {
    return; // No faction facilities access
  }

  if (facilities.length === 0) {
    yield "no faction facilities at this station";
    return;
  }

  // Check each facility for available upgrades
  for (const fac of facilities) {
    if (ctx.shouldStop) return;

    const facId = String(fac.id ?? fac.facility_id ?? "");
    const facName = String(fac.name ?? fac.type ?? "facility");
    const facLevel = Number(fac.level ?? fac.tier ?? 1);

    if (!facId) continue;

    // Check available upgrades
    let upgradeInfo: Record<string, unknown>;
    try {
      upgradeInfo = await ctx.api.facilityUpgrades(facId);
    } catch {
      continue; // No upgrades available or no permission
    }

    const upgrades = (upgradeInfo.upgrades ?? upgradeInfo.available ?? []) as Array<Record<string, unknown>>;
    if (upgrades.length === 0) continue;

    // Find the next tier upgrade
    const nextUpgrade = upgrades[0];
    const upgradeCost = Number(nextUpgrade.cost ?? nextUpgrade.credits ?? nextUpgrade.price ?? 0);
    const upgradeType = String(nextUpgrade.type ?? nextUpgrade.facility_type ?? "");
    const upgradeLevel = Number(nextUpgrade.level ?? nextUpgrade.tier ?? facLevel + 1);

    // Check if faction treasury can afford it
    let factionCredits = 0;
    try {
      factionCredits = await ctx.api.viewFactionStorageCredits();
    } catch { /* ok */ }

    // Only upgrade if faction has 2x the cost (keep reserves)
    if (upgradeCost > 0 && factionCredits >= upgradeCost * 2) {
      yield `upgrading ${facName} (Lv${facLevel} → Lv${upgradeLevel}) for ${upgradeCost}cr`;
      try {
        await ctx.api.factionFacilityUpgrade(facId, upgradeType || undefined);
        await ctx.refreshState();
        yield `upgraded ${facName} to level ${upgradeLevel}`;
      } catch (err) {
        yield `facility upgrade failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return; // Max one upgrade per cycle (expensive + rate limited)
    } else if (upgradeCost > 0) {
      yield `${facName} upgrade available (Lv${upgradeLevel}, ${upgradeCost}cr) — faction funds: ${factionCredits}cr`;
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
  cachedStationIds: string[],
  homeBase: string,
  undercutPct: number,
): { listPrice: number; cheapestElsewhere: number } | null {
  // Find cheapest buy price at OTHER stations
  let cheapestElsewhere = Infinity;
  for (const stationId of cachedStationIds) {
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;
    const p = prices.find((pd) => pd.itemId === itemId);
    if (p?.buyPrice && p.buyPrice > 0 && p.buyPrice < cheapestElsewhere) {
      cheapestElsewhere = p.buyPrice;
    }
  }

  // Also check demand prices (what buyers will pay when selling to buy orders)
  let bestDemandPrice = 0;
  for (const stationId of cachedStationIds) {
    const prices = ctx.cache.getMarketPrices(stationId);
    if (!prices) continue;
    const p = prices.find((pd) => pd.itemId === itemId);
    if (p?.sellPrice && p.sellPrice > bestDemandPrice) {
      bestDemandPrice = p.sellPrice;
    }
  }

  // Skip items where market value is far below crafting cost AND no demand exists
  // If demand exists (bestDemandPrice > 0), let market price drive the listing
  if (cheapestElsewhere < Infinity && cheapestElsewhere < costBasis * 0.5 && bestDemandPrice <= 0) {
    return null;
  }

  // Calculate list price: undercut competitors to attract buyers
  let listPrice: number;
  if (cheapestElsewhere < Infinity) {
    listPrice = Math.floor(cheapestElsewhere * (1 - undercutPct));
  } else if (bestDemandPrice > 0) {
    listPrice = Math.floor(bestDemandPrice * (1 - undercutPct / 2));
  } else {
    listPrice = Math.ceil(costBasis * 1.25);
  }

  // Insight-aware pricing: reduce undercut when demand is confirmed
  const stationInsights = ctx.cache.getMarketInsights(homeBase);
  if (stationInsights) {
    const demandInsight = stationInsights.find(
      (i) => i.item_id === itemId && (i.category === "demand" || i.category === "arbitrage")
    );
    if (demandInsight && demandInsight.priority >= 5) {
      listPrice = Math.ceil(listPrice * 1.10); // +10% premium for high-demand items
    }
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
