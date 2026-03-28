/**
 * Crafter routine - converts raw materials into finished goods.
 *
 * Smart enough to:
 * 1. Auto-discover the most profitable recipe based on skills
 * 2. Resolve the full material chain (ores → intermediates → final product)
 * 3. Source materials: cargo → storage → market
 * 4. Craft intermediates before the final product
 *
 * Params:
 *   recipeId?: string          - Recipe to craft (auto-discovered if empty)
 *   count?: number             - Number of batches per cycle (default: 1)
 *   craftStation?: string      - Base ID with crafting facilities
 *   materialSource?: string    - "cargo" | "storage" | "market" (priority order)
 *   sellOutput?: boolean       - Sell finished goods (default: true)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  sellItem,
  getParam,
  recordSellResult,
  payFactionTax,
  ensureMinCredits,
  depositExcessCredits,
  interruptibleSleep,
  isProtectedItem,
  withdrawFromFaction,
  fleetViewFactionStorage,
  MAX_MATERIAL_BUY_PRICE,
} from "./helpers";

export async function* crafter(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  let recipeId = getParam(ctx, "recipeId", "");
  const count = getParam(ctx, "count", 1);
  const craftStation = getParam(ctx, "craftStation", "");
  // Default to "storage" so crafters pull from faction storage (not just cargo)
  const materialSource = getParam<string>(ctx, "materialSource", "storage");
  const sellOutput = getParam(ctx, "sellOutput", true);
  // v0.227.0: skill requirements removed from all recipes
  // Seed from persistent cache so we never retry known facility-only recipes
  const facilityOnlyRecipes = new Set<string>(ctx.cache.getFacilityOnlyRecipes());
  // Track recipes that failed due to missing materials — skip them for a while
  const failedRecipes = new Set<string>();
  // Track materials that couldn't be sourced — skip any recipe needing them
  // Seeded from persistent cache so blacklist survives routine restarts
  const unavailableMaterials = new Set<string>(ctx.cache.getUnavailableMaterials(ctx.botId));
  if (unavailableMaterials.size > 0) {
    console.log(`[${ctx.botId}] crafter: restored ${unavailableMaterials.size} unavailable materials from cache: ${[...unavailableMaterials].join(", ")}`);
  }

  // ── Recipe discovery ──
  // Fetch faction storage inventory for material-aware recipe selection
  let factionInventory = new Map<string, number>();
  try {
    const storage = await fleetViewFactionStorage(ctx);
    for (const item of storage.items) {
      factionInventory.set(item.itemId, (factionInventory.get(item.itemId) ?? 0) + item.quantity);
    }
  } catch { /* non-critical — will fall back to profit-only selection */ }

  if (!recipeId || facilityOnlyRecipes.has(recipeId)) {
    if (facilityOnlyRecipes.has(recipeId)) recipeId = ""; // Reset blacklisted recipe
    yield "analyzing recipes...";

    // Priority 0: check if facility builds need materials (e.g., steel plates for faction quarters)
    const facilityNeeds = ctx.cache.getFacilityMaterialNeeds();
    if (facilityNeeds.size > 0) {
      const needsRecipe = ctx.crafting.findRecipeForNeeds(ctx.player.skills, facilityNeeds);
      if (needsRecipe && !facilityOnlyRecipes.has(needsRecipe.id)) {
        recipeId = needsRecipe.id;
        const needed = facilityNeeds.get(needsRecipe.outputItem) ?? 0;
        yield `facility needs ${needed}x ${ctx.crafting.getItemName(needsRecipe.outputItem)} — crafting ${needsRecipe.name}`;
      }
    }

    if (!recipeId) {
      // Priority 1: craft something immediately from cargo
      const immediate = ctx.crafting.findCraftableNow(ctx.ship, ctx.player.skills);
      if (immediate && !facilityOnlyRecipes.has(immediate.id) && !ctx.cache.isRecipeNoDemand(immediate.id)) {
        recipeId = immediate.id;
        const { profit, hasMarketData } = ctx.crafting.estimateMarketProfit(immediate.id);
        yield `ready to craft: ${immediate.name} (est. profit ${profit}cr${hasMarketData ? " mkt" : ""})`;
      }
    }

    // Priority 2: find the best recipe we can source from faction storage
    // Loop to skip recipes blocked by unavailable materials
    for (let attempt = 0; !recipeId && attempt < 20; attempt++) {
      // Exclude facility-only, locally failed, and globally-flagged no-demand recipes
      const allRecipeIds = ctx.crafting.getAllRecipes().map(r => r.id);
      const globalNoDemand = allRecipeIds.filter(id => ctx.cache.isRecipeNoDemand(id));
      const excludeIds = new Set([...facilityOnlyRecipes, ...failedRecipes, ...globalNoDemand]);
      const sourced = ctx.crafting.findBestSourceableRecipe(ctx.player.skills, factionInventory, excludeIds);
      if (!sourced) {
        if (failedRecipes.size > 0) {
          failedRecipes.clear();
          unavailableMaterials.clear();
          yield "all recipes failed — clearing blacklist, will retry";
        }
        break;
      }
      // Check if recipe chain requires any unavailable materials
      const rawMats = ctx.crafting.getRawMaterials(sourced.recipe.id, 1);
      const blockedMat = [...rawMats.keys()].find(m => unavailableMaterials.has(m));
      if (blockedMat) {
        failedRecipes.add(sourced.recipe.id);
        yield `${sourced.recipe.name} needs unavailable ${ctx.crafting.getItemName(blockedMat)} — skipping`;
        continue; // Try next recipe
      }
      recipeId = sourced.recipe.id;
      yield `target recipe: ${sourced.recipe.name} (profit ${sourced.profit}cr, materials ${Math.round(sourced.availability * 100)}% available, ${failedRecipes.size} skipped)`;
    }
  }

  if (!recipeId) {
    const total = ctx.crafting.recipeCount;
    const available = ctx.crafting.getAvailableRecipes().length;
    yield `no craftable recipes (${available} non-facility of ${total} total)`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
    return;
  }

  // Get recipe info
  let recipe = ctx.crafting.getRecipe(recipeId);
  if (!recipe) {
    yield `unknown recipe: ${recipeId}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
    return;
  }

  // Build the crafting chain (ordered steps, deepest deps first)
  let chain = ctx.crafting.buildChain(recipeId, count);
  let rawMaterials = ctx.crafting.getRawMaterials(recipeId, count);

  // Pre-check: abort if any chain step is a known facility-only recipe
  const brokenStep = chain.find(step => facilityOnlyRecipes.has(step.recipeId));
  if (brokenStep) {
    yield `chain broken: ${brokenStep.recipeName} is facility-only — skipping ${recipe.name}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
    return;
  }

  if (chain.length > 1) {
    const rawList = [...rawMaterials.entries()]
      .map(([id, qty]) => `${qty}x ${ctx.crafting.getItemName(id)}`)
      .join(", ");
    yield `chain: ${chain.length} steps. Raw materials needed: ${rawList}`;
  }

  let noSellCount = 0; // Track consecutive no-demand cycles — bail after 3 to avoid infinite loops

  while (!ctx.shouldStop) {
    // ── Sync material blacklist with cache TTLs (expired entries = retry) ──
    const currentBlacklist = ctx.cache.getUnavailableMaterials(ctx.botId);
    const currentSet = new Set(currentBlacklist);
    for (const mat of unavailableMaterials) {
      if (!currentSet.has(mat)) {
        unavailableMaterials.delete(mat); // TTL expired in cache → allow retry
      }
    }

    // ── Clear leftover cargo from previous failed cycles ──
    // Without this, intermediates and materials pile up until cargo is 100% full,
    // blocking all future sourcing and crafting (infinite stuck loop).
    const cargoUsedPct = ctx.ship.cargoCapacity > 0
      ? (ctx.ship.cargoUsed / ctx.ship.cargoCapacity) * 100 : 0;
    if (ctx.player.dockedAtBase && cargoUsedPct > 50) {
      yield* clearCrafterCargo(ctx, recipe);
    }

    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // ── Dock at crafting station ──
    if (craftStation && ctx.player.dockedAtBase !== craftStation) {
      yield "traveling to crafting station";
      try {
        await navigateAndDock(ctx, craftStation);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
        return;
      }
    } else if (!ctx.player.dockedAtBase) {
      try {
        await findAndDock(ctx);
      } catch (err) {
        yield `no dockable station: ${err instanceof Error ? err.message : String(err)}`;
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
        return;
      }
    }

    if (ctx.shouldStop) return;

    // ── Source materials ──
    // For chain recipes (multi-step), skip pre-sourcing the top-level recipe —
    // the chain loop below handles each step individually, avoiding cargo overflow
    // from loading intermediates + raw materials simultaneously
    if (chain.length <= 1) {
      const sourced = await sourceMaterials(ctx, recipe, count, materialSource);
      if (!sourced.ok) {
        // Track the missing material so we skip ALL recipes needing it (persists across restarts)
        if (sourced.missingItemId) {
          unavailableMaterials.add(sourced.missingItemId);
          ctx.cache.markMaterialUnavailable(ctx.botId, sourced.missingItemId);
        }
        yield `${sourced.reason} — blacklisting recipe, trying another`;
        ctx.cache.markRecipeFailed(recipeId);
        failedRecipes.add(recipeId);
        recipeId = "";
        await interruptibleSleep(ctx, 10_000);
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
        continue;
      }
      for (const msg of sourced.messages) {
        yield msg;
      }
    }

    if (ctx.shouldStop) return;

    // ── Craft chain (intermediates first, then final product) ──
    let chainFailed = false;
    for (const step of chain) {
      if (ctx.shouldStop) return;

      // Check if we have the inputs for this step
      const plan = ctx.crafting.planCraft(step.recipeId, step.batchCount, ctx.ship);
      if (!plan) {
        yield `cannot plan: ${step.recipeName}`;
        continue;
      }

      if (!plan.canCraft) {
        // Try sourcing missing materials for this specific step
        const stepRecipe = ctx.crafting.getRecipe(step.recipeId);
        if (stepRecipe) {
          const stepSourced = await sourceMaterials(ctx, stepRecipe, step.batchCount, materialSource);
          if (!stepSourced.ok) {
            if (stepSourced.missingItemId) {
              unavailableMaterials.add(stepSourced.missingItemId);
              ctx.cache.markMaterialUnavailable(ctx.botId, stepSourced.missingItemId);
            }
            yield `missing materials for ${step.recipeName}: ${stepSourced.reason} — blacklisting`;
            chainFailed = true;
            break; // Exit chain loop
          }
          for (const msg of stepSourced.messages) {
            yield msg;
          }
        }
      }

      yield `crafting ${step.batchCount}x ${step.recipeName}`;
      try {
        // v0.226.0: batch size = skill level (was hardcoded to 10)
        const craftingSkill = ctx.player.skills?.crafting ?? ctx.player.skills?.refining ?? 10;
        const batchSize = Math.min(step.batchCount, Math.max(1, craftingSkill));
        let remaining = step.batchCount;
        while (remaining > 0) {
          const batch = Math.min(remaining, batchSize);
          const result = await ctx.api.craft(step.recipeId, batch);
          await ctx.refreshState();
          remaining -= batch;

          if (remaining > 0) {
            yield `crafted ${batch}x ${result.outputItem} (${remaining} remaining)`;
          } else {
            yield typedYield(`crafted ${result.outputQuantity} ${ctx.crafting.getItemName(result.outputItem)}`, {
              type: "craft", botId: ctx.botId, recipeId: step.recipeId,
              outputItem: result.outputItem, outputQuantity: result.outputQuantity,
            });
            const xpEntries = Object.entries(result.xpGained);
            if (xpEntries.length > 0) {
              yield `XP: ${xpEntries.map(([s, x]) => `${s}:+${x}`).join(", ")}`;
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        yield `craft failed: ${errMsg}`;

        // Facility-only recipes can never be manually crafted — blacklist and abort
        if (errMsg.includes("facility-only") || errMsg.includes("facility_only")) {
          facilityOnlyRecipes.add(step.recipeId);
          ctx.cache.markFacilityOnly(step.recipeId);
          ctx.crafting.markFacilityOnly(step.recipeId);
          yield `blacklisted ${step.recipeName} (facility-only recipe, persisted)`;
          // Bail out entirely — the chain is broken (sub-step or top-level)
          // Returning lets Commander re-assign with fresh recipe discovery
          yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
          return;
        }

        chainFailed = true;
        // Tell scoring brain not to re-assign this recipe (10 min cooldown)
        ctx.cache.markRecipeFailed(step.recipeId);
        if (step.recipeId !== recipeId) ctx.cache.markRecipeFailed(recipeId);
        break; // Exit chain loop — will wait and retry
      }
    }

    if (ctx.shouldStop) return;

    // Chain failed — blacklist recipe and re-discover a different one
    if (chainFailed) {
      failedRecipes.add(recipeId);
      yield `chain failed (${failedRecipes.size} blocked) — finding alternative recipe`;
      recipeId = "";
      await interruptibleSleep(ctx, 15_000);

      // Re-discover recipe using material availability (refresh faction inventory)
      try {
        factionInventory = new Map<string, number>();
        const storage = await fleetViewFactionStorage(ctx);
        for (const item of storage.items) {
          factionInventory.set(item.itemId, (factionInventory.get(item.itemId) ?? 0) + item.quantity);
        }
      } catch { /* use stale inventory */ }

      // Find alternative recipe, skipping ones that need unavailable materials
      let foundAlt = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const excludeIds = new Set([...facilityOnlyRecipes, ...failedRecipes]);
        const alt = ctx.crafting.findBestSourceableRecipe(ctx.player.skills, factionInventory, excludeIds);
        if (!alt) break;
        // Check if recipe chain requires any unavailable materials
        const altRawMats = ctx.crafting.getRawMaterials(alt.recipe.id, 1);
        const blockedMat = [...altRawMats.keys()].find(m => unavailableMaterials.has(m));
        if (blockedMat) {
          failedRecipes.add(alt.recipe.id);
          yield `${alt.recipe.name} needs unavailable ${ctx.crafting.getItemName(blockedMat)} — skipping`;
          continue;
        }
        recipeId = alt.recipe.id;
        recipe = ctx.crafting.getRecipe(recipeId)!;
        chain = ctx.crafting.buildChain(recipeId, count);
        rawMaterials = ctx.crafting.getRawMaterials(recipeId, count);
        yield `switching to: ${alt.recipe.name} (profit ${alt.profit}cr, materials ${Math.round(alt.availability * 100)}%)`;
        foundAlt = true;
        break;
      }
      if (!foundAlt) {
        if (failedRecipes.size > 0) {
          failedRecipes.clear();
          unavailableMaterials.clear();
          yield "all recipes failed — clearing blacklist, will retry next cycle";
        } else {
          yield "no alternative recipes available";
          yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
          return;
        }
      }
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
      continue;
    }

    // ── Sell or deposit output ──
    // If crafting for facility needs, always deposit to faction storage (don't sell)
    const isFacilityMaterial = ctx.cache.isFacilityMaterial(recipe.outputItem);
    if (isFacilityMaterial) {
      const qty = ctx.cargo.getItemQuantity(ctx.ship, recipe.outputItem);
      if (qty > 0) {
        try {
          await ctx.api.factionDepositItems(recipe.outputItem, qty);
          ctx.cache.invalidateFactionStorage();
          await ctx.refreshState();
          yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to faction (facility build material)`;
        } catch (err) {
          yield `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } else if (sellOutput) {
      yield `selling ${ctx.crafting.getItemName(recipe.outputItem)}`;
      const result = await sellItem(ctx, recipe.outputItem);
      if (result && result.total > 0) {
        noSellCount = 0; // Reset — demand exists
        ctx.cache.clearRecipeNoDemand(recipe.id); // Clear global no-demand flag
        yield `sold ${result.quantity} ${recipe.outputItem} @ ${result.priceEach}cr (total: ${result.total}cr)`;
        // Record sell as demand signal for arbitrage
        if (ctx.player.dockedAtBase) {
          recordSellResult(ctx, ctx.player.dockedAtBase, recipe.outputItem,
            ctx.crafting.getItemName(recipe.outputItem), result.priceEach, result.quantity);
        }
        // Pay faction tax on crafting profit
        const tax = await payFactionTax(ctx, result.total);
        if (tax.message) yield tax.message;
      } else {
        // No direct buyers — deposit to faction storage instead of leaving in cargo
        const unsoldQty = ctx.cargo.getItemQuantity(ctx.ship, recipe.outputItem);
        if (unsoldQty > 0) {
          try {
            await ctx.api.factionDepositItems(recipe.outputItem, unsoldQty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
            yield `no demand — deposited ${unsoldQty} ${ctx.crafting.getItemName(recipe.outputItem)} to faction storage`;
          } catch {
            yield `no demand for ${ctx.crafting.getItemName(recipe.outputItem)} (deposit also failed)`;
            // Can't sell AND can't deposit — recipe is completely unproductive, bail out
            yield "stopping: output unsellable and storage full";
            return;
          }
        } else {
          yield `no demand for ${ctx.crafting.getItemName(recipe.outputItem)}`;
        }
        // Track consecutive no-demand cycles — bail after 3 to avoid infinite algae loops
        noSellCount++;
        ctx.cache.markRecipeNoDemand(recipe.id); // Global flag so other crafters skip this recipe too
        if (noSellCount >= 3) {
          yield `stopping: ${noSellCount} consecutive cycles with no demand for ${ctx.crafting.getItemName(recipe.outputItem)}`;
          return;
        }
      }
    } else {
      const qty = ctx.cargo.getItemQuantity(ctx.ship, recipe.outputItem);
      if (qty > 0) {
        const useFaction = ctx.settings.factionStorage
          || ctx.fleetConfig.defaultStorageMode === "faction_deposit";

        if (useFaction) {
          // Deposit to faction storage
          try {
            await ctx.api.factionDepositItems(recipe.outputItem, qty);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
            yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to faction storage`;
          } catch (err) {
            yield `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`;
            // Fallback: try personal storage
            try {
              await ctx.api.depositItems(recipe.outputItem, qty);
              await ctx.refreshState();
              yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)} to personal storage`;
            } catch (err2) {
              yield `deposit failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
            }
          }
        } else {
          // Personal storage
          try {
            await ctx.api.depositItems(recipe.outputItem, qty);
            await ctx.refreshState();
            yield `deposited ${qty} ${ctx.crafting.getItemName(recipe.outputItem)}`;
          } catch (err) {
            yield `deposit failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    // ── Service ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "crafter" });
  }
}

// ── Material Sourcing ──

interface SourceResult {
  ok: boolean;
  reason: string;
  /** The material ID that couldn't be sourced (only set when material is truly absent, not transient failures) */
  missingItemId?: string;
  messages: string[];
}

async function sourceMaterials(
  ctx: BotContext,
  recipe: { id: string; ingredients: Array<{ itemId: string; quantity: number }> },
  batchCount: number,
  preferredSource: string,
): Promise<SourceResult> {
  const plan = ctx.crafting.planCraft(recipe.id, batchCount, ctx.ship);
  if (!plan) return { ok: false, reason: "could not create crafting plan", messages: [] };
  if (plan.canCraft) return { ok: true, reason: "", messages: [] };

  const missing = plan.ingredients.filter((i) => i.missing > 0);
  const messages: string[] = [];

  // Build source order based on preference
  // "storage" = faction storage only (no market fallback — don't burn credits)
  // "market" = market first, storage fallback
  // "cargo" = don't source externally
  const sources: Array<"storage" | "market"> =
    preferredSource === "market" ? ["market", "storage"] :
    preferredSource === "storage" ? ["storage"] :
    []; // "cargo" = don't source externally

  for (const ing of missing) {
    let got = 0;

    for (const source of sources) {
      if (got >= ing.missing) break;
      const stillMissing = ing.missing - got;

      if (source === "storage") {
        // Cap withdrawal by available cargo space (same as market buys)
        const itemSize = ctx.cargo.getItemSize(ctx.ship, ing.itemId);
        const freeWeight = ctx.cargo.freeSpace(ctx.ship);
        const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
        const safeQty = Math.min(stillMissing, maxByWeight);
        if (safeQty <= 0) {
          console.warn(`[${ctx.botId}] no cargo space for ${ing.itemId} from storage (size ${itemSize}, free ${freeWeight})`);
        } else {
          const isFaction = ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit";
          try {
            if (isFaction) {
              await withdrawFromFaction(ctx, ing.itemId, safeQty);
            } else {
              await ctx.api.withdrawItems(ing.itemId, safeQty);
            }
            got += safeQty;
            messages.push(`withdrew ${safeQty} ${ctx.crafting.getItemName(ing.itemId)} from ${isFaction ? "faction" : "personal"} storage`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // cargo_full: item weighs more than 1 per unit — retry with halved qty
            if (msg.includes("cargo_full") && safeQty > 1) {
              const retryQty = Math.max(1, Math.floor(safeQty / 2));
              try {
                if (isFaction) {
                  await withdrawFromFaction(ctx, ing.itemId, retryQty);
                } else {
                  await ctx.api.withdrawItems(ing.itemId, retryQty);
                }
                got += retryQty;
                messages.push(`withdrew ${retryQty} ${ctx.crafting.getItemName(ing.itemId)} (retry, item heavier than expected)`);
              } catch {
                console.warn(`[${ctx.botId}] storage withdraw retry failed for ${ing.itemId}`);
              }
            } else {
              console.warn(`[${ctx.botId}] storage withdraw failed for ${ing.itemId}: ${msg}`);
            }
          }
        }
      } else if (source === "market") {
        try {
          // Price check: refuse expensive materials that may never produce ROI
          const basePrice = ctx.crafting.getItemBasePrice(ing.itemId);
          if (basePrice > MAX_MATERIAL_BUY_PRICE) {
            console.warn(`[${ctx.botId}] skipping ${ing.itemId} — base price ${basePrice}cr exceeds ${MAX_MATERIAL_BUY_PRICE}cr cap`);
            messages.push(`skipped ${ctx.crafting.getItemName(ing.itemId)} (${basePrice}cr > ${MAX_MATERIAL_BUY_PRICE}cr cap)`);
          } else {
            // Weight-aware buy: cap quantity by available cargo weight
            const itemSize = ctx.cargo.getItemSize(ctx.ship, ing.itemId);
            const freeWeight = ctx.cargo.freeSpace(ctx.ship);
            const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
            const safeBuyQty = Math.min(stillMissing, maxByWeight);
            if (safeBuyQty <= 0) {
              console.warn(`[${ctx.botId}] no cargo space for ${ing.itemId} (size ${itemSize}, free ${freeWeight})`);
            } else {
              const result = await ctx.api.buy(ing.itemId, safeBuyQty);
              await ctx.refreshState();
              if (result.total > 0) {
                ctx.eventBus.emit({
                  type: "trade_buy", botId: ctx.botId, itemId: ing.itemId, quantity: result.quantity,
                  priceEach: result.priceEach, total: result.total,
                  stationId: ctx.player.dockedAtBase ?? "",
                });
              }
              if (result.priceEach > MAX_MATERIAL_BUY_PRICE) {
                // Bought at an unexpectedly high price — warn but keep the items
                messages.push(`WARNING: bought ${result.quantity} ${ctx.crafting.getItemName(ing.itemId)} @ ${result.priceEach}cr (above ${MAX_MATERIAL_BUY_PRICE}cr cap)`);
              } else {
                messages.push(`bought ${result.quantity} ${ctx.crafting.getItemName(ing.itemId)} @ ${result.priceEach}cr`);
              }
              got += result.quantity;
            }
          }
        } catch (err) {
            // Market purchase failed — try next source
            console.warn(`[${ctx.botId}] market buy failed for ${ing.itemId}: ${err instanceof Error ? err.message : err}`);
          }
      }
    }

    if (got < ing.missing) {
      const shortfall = ing.missing - got;
      // Only blacklist material if it's truly absent from faction storage
      // Don't blacklist for transient failures (rate limiting, cargo full, action_in_progress)
      let isTrulyMissing = true;
      try {
        const storage = await fleetViewFactionStorage(ctx);
        const inStorage = storage.items.find(i => i.itemId === ing.itemId);
        if (inStorage && inStorage.quantity >= shortfall) {
          isTrulyMissing = false; // Material exists — failure was transient
          console.log(`[${ctx.botId}] ${ing.itemId} has ${inStorage.quantity} in storage — transient failure, not blacklisting`);
        }
      } catch { /* can't verify — assume truly missing to be safe */ }
      return {
        ok: false,
        reason: `need ${shortfall} more ${ctx.crafting.getItemName(ing.itemId)}`,
        missingItemId: isTrulyMissing ? ing.itemId : undefined,
        messages,
      };
    }
  }

  // Single refresh after all sourcing operations
  await ctx.refreshState();
  return { ok: true, reason: "", messages };
}

/**
 * Clear leftover cargo by depositing items to faction storage.
 * Keeps fuel cells (protected) and skips items that fail to deposit.
 * This prevents cargo from filling up with intermediates/materials from failed chains.
 */
async function* clearCrafterCargo(
  ctx: BotContext,
  recipe: { outputItem: string; ingredients: Array<{ itemId: string }> },
): AsyncGenerator<RoutineYield, void, void> {
  await ctx.refreshState();
  const items = [...ctx.ship.cargo];
  let deposited = 0;

  for (const item of items) {
    if (ctx.shouldStop) return;
    if (isProtectedItem(item.itemId)) continue;
    if (item.quantity <= 0) continue;

    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      ctx.cache.invalidateFactionStorage();
      deposited += item.quantity;
    } catch (err) {
      console.warn(`[${ctx.botId}] faction deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : err}`);
      // Faction deposit failed — try station storage
      try {
        await ctx.api.depositItems(item.itemId, item.quantity);
        deposited += item.quantity;
      } catch (err2) {
        console.warn(`[${ctx.botId}] station deposit also failed for ${item.itemId}: ${err2 instanceof Error ? err2.message : err2}`);
      }
    }
  }

  // Single refresh after all deposits
  if (deposited > 0) {
    await ctx.refreshState();
    yield `cleared ${deposited} items from cargo`;
  }
}
