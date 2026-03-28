/**
 * Crafting service - recipe lookup, material requirements, batch optimization.
 * Loaded once at startup with version-gated cached data.
 */

import type { Recipe, CatalogItem, ShipState, CargoItem } from "../types/game";
import type { Cargo } from "./cargo";
import { STRATEGIC_RESOURCES } from "../config/constants";

export interface CraftingPlan {
  recipeId: string;
  recipeName: string;
  outputItem: string;
  outputQuantity: number;
  batchCount: number;
  totalOutput: number;
  ingredients: Array<{ itemId: string; totalNeeded: number; inCargo: number; missing: number }>;
  canCraft: boolean;
  // v0.227.0: skill requirements removed from all recipes — kept for type compat
  missingSkills: [];
}

export interface ShoppingList {
  items: Array<{ itemId: string; quantity: number }>;
  totalItems: number;
}

/** Describes a single step in a crafting chain */
export interface ChainStep {
  recipeId: string;
  recipeName: string;
  batchCount: number;
  inputs: Array<{ itemId: string; itemName: string; quantity: number; isRaw: boolean }>;
  output: { itemId: string; itemName: string; quantity: number };
}

/**
 * Optional market price provider for market-aware profit estimation.
 * Returns the best sell price (what we can sell the item for) across known stations,
 * or null if no market data is available for this item.
 */
export interface MarketPriceProvider {
  /** Best price a seller can get for this item (highest buy order across stations) */
  getSellPrice(itemId: string): number | null;
  /** Best price a buyer can purchase this item for (cheapest sell order across stations) */
  getBuyPrice(itemId: string): number | null;
}

export class Crafting {
  private recipes: Recipe[] = [];
  private recipeMap = new Map<string, Recipe>();
  private outputIndex = new Map<string, Recipe[]>(); // outputItem → recipes that make it
  private itemCatalog = new Map<string, CatalogItem>();

  /** Known facility-only recipe IDs — excluded from all recipe selection methods */
  private facilityOnlyIds = new Set<string>();

  /** Optional market price provider — set by Commander for market-aware profit estimation */
  marketPrices: MarketPriceProvider | null = null;

  constructor(private cargo: Cargo) {}

  /** Update the set of known facility-only recipes (call after loading from cache) */
  setFacilityOnlyRecipes(ids: string[]): void {
    this.facilityOnlyIds = new Set(ids);
  }

  /** Mark a single recipe as facility-only at runtime */
  markFacilityOnly(recipeId: string): void {
    this.facilityOnlyIds.add(recipeId);
  }

  /** Load recipes from cache. Call once at startup. */
  load(recipes: Recipe[]): void {
    this.recipes = recipes;
    this.recipeMap.clear();
    this.outputIndex.clear();

    for (const recipe of recipes) {
      this.recipeMap.set(recipe.id, recipe);
      const existing = this.outputIndex.get(recipe.outputItem) ?? [];
      existing.push(recipe);
      this.outputIndex.set(recipe.outputItem, existing);
    }
  }

  /** Load item catalog for name resolution and price info. Call once at startup. */
  loadItems(items: CatalogItem[]): void {
    this.itemCatalog.clear();
    for (const item of items) {
      this.itemCatalog.set(item.id, item);
    }
  }

  get recipeCount(): number {
    return this.recipes.length;
  }

  get itemCount(): number {
    return this.itemCatalog.size;
  }

  // ── Item Catalog Lookups ──

  /** Get human-readable item name */
  getItemName(itemId: string): string {
    return this.itemCatalog.get(itemId)?.name ?? itemId;
  }

  /** Get item base price from catalog */
  getItemBasePrice(itemId: string): number {
    return this.itemCatalog.get(itemId)?.basePrice ?? 0;
  }

  /** Get item category (ore, component, refined, etc.) */
  getItemCategory(itemId: string): string {
    return this.itemCatalog.get(itemId)?.category ?? "unknown";
  }

  /** Find catalog items whose ID contains the given pattern */
  findItemsByPattern(pattern: string): CatalogItem[] {
    const results: CatalogItem[] = [];
    for (const [id, item] of this.itemCatalog) {
      if (id.includes(pattern)) results.push(item);
    }
    return results;
  }

  /** Check if an item is craftable (is the output of at least one recipe) */
  isCraftable(itemId: string): boolean {
    return (this.outputIndex.get(itemId)?.length ?? 0) > 0;
  }

  /** Check if an item is a raw material (not craftable, must be mined/bought) */
  isRawMaterial(itemId: string): boolean {
    return !this.isCraftable(itemId);
  }

  // ── Recipe Lookups ──

  /** Get a recipe by ID */
  getRecipe(recipeId: string): Recipe | null {
    return this.recipeMap.get(recipeId) ?? null;
  }

  /** Get all known recipes */
  getAllRecipes(): Recipe[] {
    return [...this.recipes];
  }

  /** Find all recipes that produce a given item */
  findRecipesForItem(outputItemId: string): Recipe[] {
    return this.outputIndex.get(outputItemId) ?? [];
  }

  /** Get all non-facility-only recipes (v0.227.0: skill requirements removed) */
  getAvailableRecipes(_skills?: Record<string, number>): Recipe[] {
    return this.recipes.filter((r) => !this.facilityOnlyIds.has(r.id));
  }

  // ── Material Chain Resolution ──

  /**
   * Resolve the full raw material requirements for a recipe.
   * Recursively resolves crafted intermediates down to base materials.
   * Returns a flat map of itemId → total quantity needed (raw materials only).
   */
  getRawMaterials(recipeId: string, batchCount = 1): Map<string, number> {
    const rawMaterials = new Map<string, number>();
    const visited = new Set<string>();

    const resolve = (id: string, multiplier: number) => {
      if (visited.has(id)) return; // Prevent circular dependencies
      visited.add(id);

      const recipe = this.recipeMap.get(id);
      if (!recipe) return;

      for (const ing of recipe.ingredients) {
        const subRecipes = this.outputIndex.get(ing.itemId);
        if (subRecipes && subRecipes.length > 0) {
          // Craftable intermediate — resolve deeper
          const sub = subRecipes[0];
          const subBatches = Math.ceil((ing.quantity * multiplier) / sub.outputQuantity);
          resolve(sub.id, subBatches);
        } else {
          // Raw material — accumulate
          const needed = ing.quantity * multiplier;
          rawMaterials.set(ing.itemId, (rawMaterials.get(ing.itemId) ?? 0) + needed);
        }
      }

      visited.delete(id); // Allow re-entry from different branches
    };

    resolve(recipeId, batchCount);
    return rawMaterials;
  }

  /**
   * Build the full crafting chain with ordered steps.
   * Returns an ordered list of crafting steps (deepest dependencies first).
   * Each step includes input/output items with names and whether inputs are raw.
   */
  buildChain(recipeId: string, batchCount = 1): ChainStep[] {
    const steps: ChainStep[] = [];
    const visited = new Set<string>();

    const resolve = (id: string, multiplier: number) => {
      if (visited.has(id)) return;
      visited.add(id);

      const recipe = this.recipeMap.get(id);
      if (!recipe) return;

      // Resolve sub-recipes first (depth-first)
      for (const ing of recipe.ingredients) {
        const subRecipes = this.outputIndex.get(ing.itemId);
        if (subRecipes && subRecipes.length > 0) {
          const sub = subRecipes[0];
          const subBatches = Math.ceil((ing.quantity * multiplier) / sub.outputQuantity);
          resolve(sub.id, subBatches);
        }
      }

      steps.push({
        recipeId: recipe.id,
        recipeName: recipe.name,
        batchCount: multiplier,
        inputs: recipe.ingredients.map((ing) => ({
          itemId: ing.itemId,
          itemName: this.getItemName(ing.itemId),
          quantity: ing.quantity * multiplier,
          isRaw: this.isRawMaterial(ing.itemId),
        })),
        output: {
          itemId: recipe.outputItem,
          itemName: this.getItemName(recipe.outputItem),
          quantity: recipe.outputQuantity * multiplier,
        },
      });

      visited.delete(id);
    };

    resolve(recipeId, batchCount);
    return steps;
  }

  /**
   * Estimate profit for crafting one batch of a recipe.
   * Uses base catalog prices: outputValue - inputCost.
   */
  estimateProfit(recipeId: string): number {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe) return 0;

    const outputPrice = this.getItemBasePrice(recipe.outputItem) * recipe.outputQuantity;
    const inputCost = recipe.ingredients.reduce(
      (sum, ing) => sum + this.getItemBasePrice(ing.itemId) * ing.quantity,
      0,
    );

    return outputPrice - inputCost;
  }

  /**
   * Estimate profit using real market prices when available, falling back to MSRP.
   * Output valued at best sell price (what we can actually sell for).
   * Inputs valued at best buy price (what we'd pay to acquire them).
   * For self-produced inputs (ores, intermediates), uses MSRP as opportunity cost.
   */
  estimateMarketProfit(recipeId: string): { profit: number; hasMarketData: boolean } {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe) return { profit: 0, hasMarketData: false };

    const mp = this.marketPrices;
    let hasMarketData = false;

    // Output: what can we actually sell the product for?
    const marketSell = mp?.getSellPrice(recipe.outputItem);
    const outputUnitPrice = marketSell ?? this.getItemBasePrice(recipe.outputItem);
    if (marketSell !== null && marketSell !== undefined) hasMarketData = true;
    const outputValue = outputUnitPrice * recipe.outputQuantity;

    // Inputs: what does it cost us to acquire each ingredient?
    let inputCost = 0;
    for (const ing of recipe.ingredients) {
      let unitCost: number;
      if (ing.itemId.startsWith("ore_") || this.isCraftable(ing.itemId)) {
        // Self-produced materials: use MSRP as opportunity cost (we mine/craft these)
        unitCost = this.getItemBasePrice(ing.itemId);
      } else {
        // Must buy on market: use market buy price if available
        const marketBuy = mp?.getBuyPrice(ing.itemId);
        unitCost = marketBuy ?? this.getItemBasePrice(ing.itemId);
        if (marketBuy !== null && marketBuy !== undefined) hasMarketData = true;
      }
      inputCost += unitCost * ing.quantity;
    }

    return { profit: outputValue - inputCost, hasMarketData };
  }

  /**
   * Get the effective sell price for an item: market price if available, else MSRP.
   */
  getEffectiveSellPrice(itemId: string): number {
    const marketSell = this.marketPrices?.getSellPrice(itemId);
    return marketSell ?? this.getItemBasePrice(itemId);
  }

  /**
   * Find a recipe that produces an item needed for facility builds.
   * Prioritizes by quantity needed (most-needed item first).
   * Returns null if no available recipes produce needed items.
   */
  findRecipeForNeeds(skills: Record<string, number>, needs: Map<string, number>): Recipe | null {
    if (needs.size === 0) return null;
    const available = this.getAvailableRecipes(skills);
    if (available.length === 0) return null;

    let best: Recipe | null = null;
    let bestNeed = 0;
    for (const recipe of available) {
      if (!this.isChainViable(recipe.id)) continue;
      const needed = needs.get(recipe.outputItem) ?? 0;
      if (needed > 0 && needed > bestNeed) {
        bestNeed = needed;
        best = recipe;
      }
    }
    return best;
  }

  /**
   * Check if a recipe's full chain is manually craftable
   * (no facility-only sub-steps, no self-referential ingredients).
   */
  isChainViable(recipeId: string): boolean {
    const recipe = this.recipeMap.get(recipeId);
    if (recipe) {
      // Self-referential: recipe requires its own output as input
      if (recipe.ingredients.some(i => i.itemId === recipe.outputItem)) return false;
    }
    const chain = this.resolveChain(recipeId);
    return chain.every(r => !this.facilityOnlyIds.has(r.id));
  }

  /**
   * Find the best recipe for a bot based on available skills and estimated profit.
   * Uses market prices when available for more accurate profit estimation.
   * Skips recipes whose chains include facility-only sub-steps.
   * Returns null if no recipes are available.
   */
  findBestRecipe(skills: Record<string, number>): Recipe | null {
    const available = this.getAvailableRecipes(skills);
    if (available.length === 0) return null;

    let best: Recipe | null = null;
    let bestScore = -Infinity;
    for (const recipe of available) {
      if (!this.isChainViable(recipe.id)) continue;
      const { profit } = this.estimateMarketProfit(recipe.id);
      // Refining priority: boost recipes whose inputs are all raw ores
      const allInputsRaw = recipe.ingredients.every(ing => this.isRawMaterial(ing.itemId));
      const refiningBoost = allInputsRaw ? 1.5 : 1.0;
      const score = profit * refiningBoost;
      if (score > bestScore) {
        bestScore = score;
        best = recipe;
      }
    }

    return best;
  }

  /**
   * Find the best recipe that a bot can craft RIGHT NOW with materials in cargo.
   * Uses market prices when available for more accurate profit estimation.
   */
  findCraftableNow(ship: ShipState, skills: Record<string, number>): Recipe | null {
    const available = this.getAvailableRecipes(skills);
    if (available.length === 0) return null;

    let best: Recipe | null = null;
    let bestScore = -Infinity;
    for (const recipe of available) {
      if (!this.isChainViable(recipe.id)) continue;
      const plan = this.planCraft(recipe.id, 1, ship);
      if (plan && plan.canCraft) {
        const { profit } = this.estimateMarketProfit(recipe.id);
        // Refining priority: boost recipes whose inputs are all raw ores
        const allInputsRaw = recipe.ingredients.every(ing => this.isRawMaterial(ing.itemId));
        const refiningBoost = allInputsRaw ? 1.5 : 1.0;
        const score = profit * refiningBoost;
        if (score > bestScore) {
          bestScore = score;
          best = recipe;
        }
      }
    }

    return best;
  }

  /**
   * Plan crafting: check materials and determine what's missing.
   * v0.227.0: skill requirements removed — only checks ingredients.
   */
  planCraft(
    recipeId: string,
    batchCount: number,
    ship: ShipState,
    _skills?: Record<string, number>
  ): CraftingPlan | null {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe) return null;

    // Check ingredients
    const ingredients: CraftingPlan["ingredients"] = recipe.ingredients.map((ing) => {
      const totalNeeded = ing.quantity * batchCount;
      const inCargo = this.cargo.getItemQuantity(ship, ing.itemId);
      return {
        itemId: ing.itemId,
        totalNeeded,
        inCargo,
        missing: Math.max(0, totalNeeded - inCargo),
      };
    });

    const canCraft = ingredients.every((i) => i.missing === 0);

    return {
      recipeId,
      recipeName: recipe.name,
      outputItem: recipe.outputItem,
      outputQuantity: recipe.outputQuantity,
      batchCount,
      totalOutput: recipe.outputQuantity * batchCount,
      ingredients,
      canCraft,
      missingSkills: [],
    };
  }

  /**
   * Generate a shopping list for crafting N batches of a recipe.
   * Only includes items we don't already have enough of.
   */
  getShoppingList(recipeId: string, batchCount: number, ship: ShipState): ShoppingList | null {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe) return null;

    const items: ShoppingList["items"] = [];
    let totalItems = 0;

    for (const ing of recipe.ingredients) {
      const needed = ing.quantity * batchCount;
      const have = this.cargo.getItemQuantity(ship, ing.itemId);
      const missing = Math.max(0, needed - have);
      if (missing > 0) {
        items.push({ itemId: ing.itemId, quantity: missing });
        totalItems += missing;
      }
    }

    return { items, totalItems };
  }

  /**
   * Calculate max batches we can craft with current cargo.
   */
  maxBatches(recipeId: string, ship: ShipState): number {
    const recipe = this.recipeMap.get(recipeId);
    if (!recipe || recipe.ingredients.length === 0) return 0;

    let maxBatches = Infinity;
    for (const ing of recipe.ingredients) {
      const have = this.cargo.getItemQuantity(ship, ing.itemId);
      const batchesFromThis = ing.quantity > 0 ? Math.floor(have / ing.quantity) : Infinity;
      maxBatches = Math.min(maxBatches, batchesFromThis);
    }

    return maxBatches === Infinity ? 0 : maxBatches;
  }

  /**
   * Resolve full prerequisite chain for a recipe.
   * Returns ordered list of recipes to craft (deepest dependencies first).
   */
  resolveChain(recipeId: string): Recipe[] {
    const chain: Recipe[] = [];
    const visited = new Set<string>();

    const resolve = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);

      const recipe = this.recipeMap.get(id);
      if (!recipe) return;

      // Check if any ingredients are themselves craftable
      for (const ing of recipe.ingredients) {
        const subRecipes = this.outputIndex.get(ing.itemId);
        if (subRecipes && subRecipes.length > 0) {
          resolve(subRecipes[0].id);
        }
      }

      chain.push(recipe);
    };

    resolve(recipeId);
    return chain;
  }

  /**
   * Score how well a recipe's raw material needs can be met by available inventory.
   * Returns a ratio 0.0–1.0 where 1.0 means all raw materials are fully available.
   * Useful for prioritizing recipes we can actually craft with current faction storage.
   */
  materialAvailability(recipeId: string, inventory: Map<string, number>, batchCount = 1): number {
    const rawMats = this.getRawMaterials(recipeId, batchCount);
    if (rawMats.size === 0) return 1.0;

    let totalNeeded = 0;
    let totalAvailable = 0;
    for (const [itemId, needed] of rawMats) {
      const have = inventory.get(itemId) ?? 0;
      if (have === 0) return 0; // Any missing material = can't craft at all
      totalNeeded += needed;
      totalAvailable += Math.min(have, needed);
    }

    return totalNeeded > 0 ? totalAvailable / totalNeeded : 0;
  }

  /**
   * Find the best recipe considering both profit and material availability.
   * Scores recipes by: profit * availability — ensuring we pick recipes we can
   * actually complete with materials on hand, while still preferring profitable ones.
   * Only returns recipes with >0 material availability.
   */
  findBestSourceableRecipe(
    skills: Record<string, number>,
    inventory: Map<string, number>,
    excludeIds?: Set<string>,
  ): { recipe: Recipe; profit: number; availability: number } | null {
    const available = this.getAvailableRecipes(skills);
    if (available.length === 0) return null;

    let best: { recipe: Recipe; profit: number; availability: number } | null = null;
    let bestScore = -Infinity;

    for (const recipe of available) {
      if (excludeIds?.has(recipe.id)) continue;
      if (!this.isChainViable(recipe.id)) continue;

      const avail = this.materialAvailability(recipe.id, inventory);
      if (avail <= 0) continue; // Skip recipes with any missing material

      const { profit } = this.estimateMarketProfit(recipe.id);
      // Strongly prefer 100% sourceable recipes — partial recipes waste ticks failing
      // availability² penalizes partial availability; 100% = full score, 50% = 25% score
      // Refining priority: boost recipes whose inputs are all raw ores — convert ores first
      // before crafting higher-tier items that consume refined goods
      const allInputsRaw = recipe.ingredients.every(ing => this.isRawMaterial(ing.itemId));
      const refiningBoost = allInputsRaw ? 1.5 : 1.0;
      // Intermediate ingredients used by many recipes are strategically valuable
      const usageCount = this.recipes.reduce((count, r) =>
        count + (r.ingredients.some(ing => ing.itemId === recipe.outputItem) ? 1 : 0), 0);
      const intermediateBoost = usageCount > 2 ? 2.0 : 1.0;

      // Surplus consumption bonus: if recipe inputs are overstocked in faction storage,
      // add a flat bonus so we convert dead inventory into sellable goods even at low profit.
      // ONLY applies when the output has confirmed market demand (sellPrice > 0 at some station)
      // or is an intermediate ingredient — prevents crafting unsellable waste like purified water.
      let surplusBonus = 0;
      const outputSellPrice = this.marketPrices?.getSellPrice(recipe.outputItem) ?? 0;
      const outputHasDemand = outputSellPrice > 0 || usageCount > 0; // Buyers exist, or it's an ingredient
      if (outputHasDemand) {
        for (const ing of recipe.ingredients) {
          const stock = inventory.get(ing.itemId) ?? 0;
          if (stock > 20000) surplusBonus += 200;      // Extreme surplus — must consume
          else if (stock > 10000) surplusBonus += 150;  // Heavy surplus
          else if (stock > 5000) surplusBonus += 80;    // Major surplus
          else if (stock > 1000) surplusBonus += 20;    // Moderate surplus
        }
      }

      // Strategic resource bonus: if recipe output is a strategic resource below minStock, boost priority
      let strategicBonus = 0;
      const stratRes = STRATEGIC_RESOURCES.find(sr => sr.itemId === recipe.outputItem);
      if (stratRes) {
        const currentStock = inventory.get(recipe.outputItem) ?? 0;
        if (currentStock < stratRes.minStock) strategicBonus = 100;
      }

      const effectiveProfit = Math.max(profit, 1) + surplusBonus + strategicBonus; // Floor at 1 to prevent 0 × anything = 0

      // Efficiency multiplier: prefer recipes that produce more output per input unit.
      // e.g., Refine Steel (5 iron → 2 steel, eff=0.40) beats Basic Iron Smelting (10 iron → 1 steel, eff=0.10)
      // Fluorine Nano-Etch (2 silicon + 1 fluorine → 5 circuit boards) beats Fabricate (3 copper + 2 silicon + 1 crystal → 2)
      const totalInputQty = recipe.ingredients.reduce((sum, ing) => sum + ing.quantity, 0);
      const efficiencyBoost = totalInputQty > 0 ? recipe.outputQuantity / totalInputQty : 1;
      // Normalize: eff of 0.1-0.5 is typical, boost range ~0.5x to 2.0x
      const efficiencyMultiplier = Math.max(0.5, Math.min(2.0, efficiencyBoost * 3));

      const score = effectiveProfit * (avail * avail) * refiningBoost * intermediateBoost * efficiencyMultiplier;

      if (score > bestScore) {
        bestScore = score;
        best = { recipe, profit, availability: avail };
      }
    }

    return best;
  }
}
