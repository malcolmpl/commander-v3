/**
 * Shared routine helpers - common patterns used across multiple routines.
 * These handle navigation, docking, emergency responses, and state refresh.
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import type { TravelResult, MiningYield, TradeResult, MarketOrder, MarketPrice } from "../types/game";
import type { DangerMap } from "../commander/danger-map";
import {
  FUEL_REFUEL_THRESHOLD, FUEL_PREDEPARTURE_THRESHOLD, FUEL_CELL_RESERVE,
  FUEL_CELL_MAX_PRICE, FUEL_SAFETY_MARGIN, FUEL_LOW_BURN_THRESHOLD,
  REPAIR_THRESHOLD, REPAIR_SERVICE_THRESHOLD, MODULE_REPAIR_THRESHOLD,
  EMERGENCY_HULL_THRESHOLD, INSURANCE_MAX_WALLET_PCT, INSURANCE_DURATION_TICKS,
  MAX_MATERIAL_BUY_PRICE, INSIGHT_GATE_PRICE,
  MINE_REFRESH_INTERVAL,
} from "../config/constants";

// Re-export for routines that import from helpers
export { MAX_MATERIAL_BUY_PRICE, INSIGHT_GATE_PRICE };

/** Items that should never be sold or deposited — kept as emergency reserves */
const PROTECTED_ITEMS = new Set(["fuel_cell"]);

/** Check if an item is protected from selling/depositing */
export function isProtectedItem(itemId: string): boolean {
  return PROTECTED_ITEMS.has(itemId);
}

/** Consistent logging prefix for a bot */
function log(ctx: BotContext, msg: string): void {
  console.log(`[${ctx.botId}] ${msg}`);
}

function logWarn(ctx: BotContext, msg: string): void {
  console.warn(`[${ctx.botId}] ${msg}`);
}

function logError(ctx: BotContext, msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ? String(err) : "";
  console.error(`[${ctx.botId}] ${msg}${detail ? `: ${detail}` : ""}`);
}

// ── Navigation ──

/**
 * Navigate to a POI within the current system.
 * If already at the POI, does nothing.
 * Returns the travel result or null if already there.
 */
export async function travelToPoi(ctx: BotContext, poiId: string): Promise<TravelResult | null> {
  if (ctx.player.currentPoi === poiId) return null;

  // Must undock first if docked - refuel before leaving
  if (ctx.player.dockedAtBase) {
    await ensureFuelSafety(ctx);
    log(ctx, `undocking from ${ctx.player.dockedAtBase}`);
    await ctx.api.undock();
    await ctx.refreshState();
  }

  log(ctx, `traveling to POI ${poiId}`);
  const result = await ctx.api.travel(poiId);
  await ctx.refreshState();
  return result;
}

/**
 * Jump to a different system and optionally travel to a POI within it.
 * Uses the game's find_route API for path planning (knows the full map),
 * with local BFS as fallback if the API fails.
 * Auto-updates galaxy with system details at each hop (data gathering).
 */
export async function navigateTo(
  ctx: BotContext,
  targetSystemId: string,
  targetPoiId?: string
): Promise<void> {
  // Undock first if docked - refuel before leaving
  if (ctx.player.dockedAtBase) {
    await ensureFuelSafety(ctx);
    log(ctx, `undocking from ${ctx.player.dockedAtBase}`);
    try {
      await ctx.api.undock();
    } catch (err) {
      // Stale state: server says already undocked (e.g. 504 silently succeeded)
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not_docked")) {
        log(ctx, "already undocked (stale state)");
      } else {
        throw err;
      }
    }
    await ctx.refreshState();
  }

  // Jump through systems if needed
  if (ctx.player.currentSystem !== targetSystemId) {
    // Use the game's find_route API (free query, knows full map)
    let path: string[] | null = null;
    try {
      const routeResult = await ctx.api.findRoute(targetSystemId);
      if (routeResult.found && routeResult.route.length > 0) {
        // Route includes current system as first entry - extract system IDs
        path = routeResult.route.map((r) => r.systemId);
      }
    } catch (err) {
      logWarn(ctx, `API route planning failed, using BFS fallback: ${err instanceof Error ? err.message : err}`);
    }

    // Fallback: local BFS pathfinding
    if (!path) {
      path = ctx.galaxy.findPath(ctx.player.currentSystem, targetSystemId);
    }

    if (!path || path.length === 0) {
      throw new Error(`No route from ${ctx.player.currentSystem} to ${targetSystemId}`);
    }

    const jumpsNeeded = path.length - 1;
    log(ctx, `navigating ${ctx.player.currentSystem} → ${targetSystemId} (${jumpsNeeded} jump(s))`);

    // Pre-flight fuel check: physics-based estimate (mass/speed/cargo affect fuel cost)
    const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);
    const fuelNeeded = jumpsNeeded * fuelPerJump + FUEL_SAFETY_MARGIN;
    if (ctx.ship.fuel < fuelNeeded) {
      // Try to dock and refuel first
      if (!ctx.player.dockedAtBase) {
        const canDock = ctx.station.canDock(ctx.player);
        if (canDock) {
          try {
            await ctx.api.dock();
            await ctx.refreshState();
            await refuelIfNeeded(ctx);
            await ctx.api.undock();
            await ctx.refreshState();
          } catch (err) { logWarn(ctx, `pre-flight refuel dock failed: ${err instanceof Error ? err.message : err}`); }
        } else {
          // Undocked and can't dock — try burning cargo fuel cells
          await burnFuelCells(ctx);
        }
      }
      // Re-check after refuel attempt
      const fuelNeededRecheck = jumpsNeeded * ctx.nav.estimateJumpFuel(ctx.ship) + FUEL_SAFETY_MARGIN;
      if (ctx.ship.fuel < fuelNeededRecheck) {
        throw new Error(`Insufficient fuel: need ${fuelNeededRecheck}, have ${ctx.ship.fuel}. Route: ${jumpsNeeded} jumps to ${targetSystemId}`);
      }
    }

    // Skip first element (current system)
    for (let i = 1; i < path.length; i++) {
      if (ctx.shouldStop) return;

      // Mid-route fuel check: if critically low, abort and dock at nearest station
      if (ctx.ship.fuel <= FUEL_SAFETY_MARGIN) {
        logWarn(ctx, `fuel critically low (${ctx.ship.fuel} remaining), aborting route`);
        await burnFuelCells(ctx);
        // If still low, try to dock at nearest station
        if (ctx.ship.fuel <= 1) {
          const dockTarget = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
          if (dockTarget) {
            try { await navigateTo(ctx, dockTarget.systemId, dockTarget.poiId); } catch (err) { logWarn(ctx, `emergency dock attempt failed: ${err instanceof Error ? err.message : err}`); }
          }
          throw new Error(`Fuel emergency: aborted route to ${targetSystemId} at jump ${i}/${jumpsNeeded}`);
        }
      }

      log(ctx, `jumping to ${path[i]} (${i}/${jumpsNeeded})`);
      try {
        await ctx.api.jump(path[i]);
      } catch (jumpErr) {
        const msg = jumpErr instanceof Error ? jumpErr.message : String(jumpErr);
        // "already_here" means we're already in this system — skip to next jump
        if (msg.includes("already_here") || msg.includes("already in")) {
          log(ctx, `already in ${path[i]}, skipping`);
          continue;
        }
        throw jumpErr;
      }
      await ctx.refreshState();

      // Auto-update galaxy with detailed system data (fleet-deduped)
      try {
        await fleetGetSystem(ctx);
      } catch (err) {
        logWarn(ctx, `failed to update system detail after jump: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Travel to POI within the system
  if (targetPoiId && ctx.player.currentPoi !== targetPoiId) {
    await ctx.api.travel(targetPoiId);
    await ctx.refreshState();
  }
}

/**
 * Navigate to a POI by ID, resolving the system automatically.
 */
export async function navigateToPoi(ctx: BotContext, poiId: string): Promise<void> {
  let systemId = ctx.galaxy.getSystemForPoi(poiId);

  // Fallback: POI not in galaxy cache — refresh current system detail (fleet-deduped)
  if (!systemId) {
    try {
      await fleetGetSystem(ctx);
      systemId = ctx.galaxy.getSystemForPoi(poiId);
    } catch { /* ignore */ }
    if (!systemId) throw new Error(`Unknown POI: ${poiId}`);
  }

  await navigateTo(ctx, systemId, poiId);
}

/**
 * Navigate to a target system using danger-aware weighted pathfinding.
 * If no dangerMap is provided (or already at target), falls back to standard navigateTo.
 * Performs a hull safety check before each jump and aborts to emergency dock if critical.
 */
export async function navigateSafe(
  ctx: BotContext,
  targetSystemId: string,
  targetPoiId?: string,
  dangerMap?: DangerMap,
): Promise<void> {
  if (!dangerMap || ctx.player.currentSystem === targetSystemId) {
    await navigateTo(ctx, targetSystemId, targetPoiId);
    return;
  }

  const costFn = (sysId: string) => {
    const danger = dangerMap.getScore(sysId);
    return 1.0 + danger * 5.0;
  };

  const path = ctx.galaxy.findWeightedPath(
    ctx.player.currentSystem,
    targetSystemId,
    costFn,
  );

  if (!path || path.length <= 1) {
    // Fallback to standard nav
    await navigateTo(ctx, targetSystemId, targetPoiId);
    return;
  }

  // Undock first if docked - refuel before leaving
  if (ctx.player.dockedAtBase) {
    await ensureFuelSafety(ctx);
    log(ctx, `undocking from ${ctx.player.dockedAtBase}`);
    try {
      await ctx.api.undock();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not_docked")) {
        log(ctx, "already undocked (stale state)");
      } else {
        throw err;
      }
    }
    await ctx.refreshState();
  }

  const jumpsNeeded = path.length - 1;
  log(ctx, `navigating (safe) ${ctx.player.currentSystem} → ${targetSystemId} (${jumpsNeeded} jump(s))`);

  // Skip first element (current system)
  for (let i = 1; i < path.length; i++) {
    if (ctx.shouldStop) return;
    const issue = safetyCheck(ctx);
    if (issue) {
      await handleEmergency(ctx);
      return;
    }
    log(ctx, `jumping to ${path[i]} (${i}/${jumpsNeeded})`);
    try {
      await ctx.api.jump(path[i]);
    } catch (jumpErr) {
      const msg = jumpErr instanceof Error ? jumpErr.message : String(jumpErr);
      if (msg.includes("already_here") || msg.includes("already in")) {
        log(ctx, `already in ${path[i]}, skipping`);
        continue;
      }
      throw jumpErr;
    }
    await ctx.refreshState();
    try {
      await fleetGetSystem(ctx);
    } catch (err) {
      logWarn(ctx, `failed to update system detail after jump: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (targetPoiId && ctx.player.currentSystem === targetSystemId) {
    await travelToPoi(ctx, targetPoiId);
    await dockAtCurrent(ctx);
  }
}

// ── System Data ──

/**
 * Ensure the current system has full POI data in the galaxy graph.
 * get_map only returns system coordinates (no POIs), so we call getSystem
 * (free query) to get full details including which POIs have bases.
 */
export async function ensureSystemDetail(ctx: BotContext): Promise<void> {
  const system = ctx.galaxy.getSystem(ctx.player.currentSystem);
  if (system && system.pois.length > 0) return; // Already have POI data

  try {
    await fleetGetSystem(ctx);
  } catch (err) {
    logWarn(ctx, `failed to fetch system detail for ${ctx.player.currentSystem}: ${err instanceof Error ? err.message : err}`);
  }
}

// ── Docking ──

/**
 * Dock at the station at the current POI.
 * Does nothing if already docked or if the POI has no base.
 * Auto-scans market and services ship (refuel + repair) on every dock.
 */
export async function dockAtCurrent(ctx: BotContext): Promise<void> {
  if (ctx.player.dockedAtBase) {
    // Already docked — still scan market/shipyard if cache is stale (e.g., after restart)
    if (!ctx.cache.getMarketPrices(ctx.player.dockedAtBase)) {
      try {
        await fleetViewMarket(ctx, ctx.player.dockedAtBase);
      } catch (err) { logWarn(ctx, `market scan failed (cached dock): ${err instanceof Error ? err.message : err}`); }
    }
    if (!ctx.cache.getShipyardData(ctx.player.dockedAtBase)) {
      try {
        await fleetShipyardShowroom(ctx, ctx.player.dockedAtBase);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("unknown_command") && !msg.includes("Unknown command")) {
          logWarn(ctx, `shipyard scan failed: ${msg}`);
        }
      }
    }
    return;
  }

  // Ensure we have POI data for this system before checking dockability
  await ensureSystemDetail(ctx);

  // Only attempt dock if the POI has a base
  if (!ctx.station.canDock(ctx.player)) return;

  log(ctx, `docking at ${ctx.player.currentPoi ?? "current POI"}`);
  await ctx.api.dock();
  await ctx.refreshState();

  if (ctx.player.dockedAtBase) {
    log(ctx, `docked at ${ctx.player.dockedAtBase}`);
    // Always service ship when docking
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    // Auto-scan market to build intel (fleet-deduped)
    try {
      await fleetViewMarket(ctx, ctx.player.dockedAtBase);
    } catch (err) {
      logWarn(ctx, `market scan failed at ${ctx.player.dockedAtBase}: ${err instanceof Error ? err.message : err}`);
    }

    // Scan shipyard to cache available ships (fleet-deduped)
    try {
      await fleetShipyardShowroom(ctx, ctx.player.dockedAtBase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Suppress "unknown_command" — station has no shipyard (not an error)
      if (!msg.includes("unknown_command") && !msg.includes("Unknown command")) {
        logWarn(ctx, `shipyard scan failed: ${msg}`);
      }
    }

    // Analyze market for insights (rate-limited — at most once per 30min per station)
    await analyzeMarketIfStale(ctx);

  }
}

/**
 * Navigate to a base (station) and dock.
 */
export async function navigateAndDock(ctx: BotContext, baseId: string): Promise<void> {
  if (ctx.player.dockedAtBase === baseId) return;

  let systemId = ctx.galaxy.getSystemForBase(baseId);

  // Fallback: base not in galaxy cache — scan current system or search for it
  if (!systemId) {
    // Try refreshing current system detail (maybe we're already in the right system)
    try {
      await fleetGetSystem(ctx);
      systemId = ctx.galaxy.getSystemForBase(baseId);
    } catch { /* ignore */ }

    // Try searching for the base name
    if (!systemId) {
      try {
        const results = await ctx.api.searchSystems(baseId.replace(/_/g, " "));
        for (const raw of results) {
          const sys = raw as any;
          if (sys.id && sys.pois?.length > 0) {
            const normalized = { id: sys.id, name: sys.name, x: sys.x ?? 0, y: sys.y ?? 0, connections: sys.connections ?? [], pois: sys.pois };
            ctx.galaxy.updateSystem(normalized as any);
          }
        }
        systemId = ctx.galaxy.getSystemForBase(baseId);
      } catch { /* ignore search failure */ }
    }

    if (!systemId) throw new Error(`Unknown base: ${baseId}`);
  }

  // Find the POI that has this base
  const system = ctx.galaxy.getSystem(systemId);
  const poi = system?.pois.find((p) => p.baseId === baseId);
  if (!poi) throw new Error(`No POI for base: ${baseId}`);

  try {
    await navigateTo(ctx, systemId, poi.id);
    await dockAtCurrent(ctx);
  } catch (err) {
    // Fallback: if POI travel fails (e.g. invalid_poi), navigate to system and findAndDock
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("invalid_poi") || msg.includes("Unknown destination")) {
      logWarn(ctx, `POI travel failed for ${baseId} (poi=${poi.id}), using findAndDock fallback`);
      // Ensure we're in the right system
      if (ctx.player.currentSystem !== systemId) {
        await navigateTo(ctx, systemId);
      }
      await findAndDock(ctx);
      // Verify we docked at the right base (or at least somewhere)
      if (!ctx.player.dockedAtBase) {
        throw new Error(`failed to dock at ${baseId} (fallback)`);
      }
    } else {
      throw err;
    }
  }
}

/**
 * Find the nearest station and dock. Used when no specific station is provided
 * and the current POI has no base. Guarantees docking or throws.
 */
export async function findAndDock(ctx: BotContext): Promise<void> {
  if (ctx.player.dockedAtBase) return;

  // Try current POI first
  await ensureSystemDetail(ctx);
  if (ctx.station.canDock(ctx.player)) {
    log(ctx, `docking at current POI ${ctx.player.currentPoi}`);
    await ctx.api.dock();
    await ctx.refreshState();
    if (ctx.player.dockedAtBase) {
      await refuelIfNeeded(ctx);
      await repairIfNeeded(ctx);
      try {
        await fleetViewMarket(ctx, ctx.player.dockedAtBase);
      } catch (err) { logWarn(ctx, `market scan failed: ${err instanceof Error ? err.message : err}`); }
      return;
    }
  }

  // Find nearest station in current system or nearby
  const target = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
  if (!target) throw new Error("no station found to dock at");

  log(ctx, `navigating to nearest station: ${target.systemId}/${target.poiId}`);
  await navigateTo(ctx, target.systemId, target.poiId);
  await dockAtCurrent(ctx);

  if (!ctx.player.dockedAtBase) {
    throw new Error(`failed to dock at ${target.poiId}`);
  }
}

// ── Services ──

/**
 * Refuel if below threshold. Works anywhere:
 *   - Docked: uses station refuel (credits) then burns cargo cells if still low
 *   - Undocked: burns fuel cells from cargo
 */
export async function refuelIfNeeded(ctx: BotContext, threshold = FUEL_REFUEL_THRESHOLD): Promise<boolean> {
  const fuelPct = ctx.fuel.getPercentage(ctx.ship);
  if (fuelPct >= threshold) return false;

  // Station refuel (costs credits, only works docked)
  if (ctx.player.dockedAtBase) {
    try {
      await ctx.api.refuel();
      await ctx.refreshState();
    } catch (err) {
      logWarn(ctx, `refuel failed: ${err instanceof Error ? err.message : err}`);
    }
    if (ctx.fuel.getPercentage(ctx.ship) >= threshold) return true;

    // Try withdrawing fuel cells from faction storage if still low
    if (ctx.fuel.getPercentage(ctx.ship) < threshold) {
      if (ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit") {
        try {
          await withdrawFromFaction(ctx, "fuel_cell", 5);
          await ctx.refreshState();
        } catch (err) {
          logWarn(ctx, `faction fuel withdrawal failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  // Burn fuel cells from cargo (works anywhere)
  await burnFuelCells(ctx);
  return true;
}

/**
 * Burn fuel cells from cargo to refuel. Works docked or undocked.
 * The API auto-selects cheapest cells and caps to tank capacity.
 */
export async function burnFuelCells(ctx: BotContext): Promise<boolean> {
  const totalCells = ctx.ship.cargo
    .filter((c) => c.itemId.includes("fuel") && c.quantity > 0)
    .reduce((sum, c) => sum + c.quantity, 0);
  if (totalCells === 0) return false;

  try {
    await ctx.api.refuel(undefined, totalCells);
    await ctx.refreshState();
    return true;
  } catch (err) {
    logWarn(ctx, `burn fuel cells failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Repair at the current station if hull is damaged. Must be docked.
 * Also repairs any worn modules (durability < 100%).
 */
export async function repairIfNeeded(ctx: BotContext, threshold = REPAIR_THRESHOLD): Promise<boolean> {
  let repaired = false;
  const hullPct = (ctx.ship.hull / ctx.ship.maxHull) * 100;
  if (hullPct < threshold) {
    await ctx.api.repair();
    await ctx.refreshState();
    repaired = true;
  }

  // Repair worn modules (v0.228.0: repair works in space with repair kits from cargo)
  if (repaired) await ctx.refreshState();
  for (const mod of ctx.ship.modules) {
    const durability = mod.durability ?? mod.health ?? 100;
    if (durability < MODULE_REPAIR_THRESHOLD) {
      try {
        await ctx.api.repairModule(mod.moduleId);
        repaired = true;
      } catch (err) { logWarn(ctx, `module repair failed (${mod.moduleId}): ${err instanceof Error ? err.message : err}`); }
    }
  }
  if (repaired) await ctx.refreshState();

  return repaired;
}

/**
 * Full station service: refuel + repair + buy insurance + ensure fuel safety.
 */
export async function serviceShip(ctx: BotContext): Promise<void> {
  await repairIfNeeded(ctx, REPAIR_SERVICE_THRESHOLD);
  await refuelIfNeeded(ctx, REPAIR_THRESHOLD);
  await ensureInsurance(ctx);
}

/**
 * Buy insurance if not already covered. Protects against ship loss from
 * stranding, combat, or self-destruct. Coverage = hull + module value.
 * Only buys when docked and affordable (< 10% of credits).
 */
export async function ensureInsurance(ctx: BotContext): Promise<void> {
  if (!ctx.player.dockedAtBase) return;

  try {
    const quote = await ctx.api.getInsuranceQuote();
    // Check if already insured
    const covered = quote.covered ?? quote.insured ?? false;
    if (covered) return;

    const premium = Number(quote.premium ?? quote.cost ?? 0);
    if (premium <= 0) return;

    // Only spend up to 10% of credits on insurance
    if (premium > ctx.player.credits * INSURANCE_MAX_WALLET_PCT) {
      return; // Too expensive relative to wallet
    }

    await ctx.api.buyInsurance(INSURANCE_DURATION_TICKS);
    await ctx.refreshState();
    log(ctx, `bought insurance: ${premium}cr for ${INSURANCE_DURATION_TICKS} ticks`);
  } catch (err) {
    logWarn(ctx, `insurance purchase failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Recover a stranded bot (0 fuel, not docked, no fuel cells).
 * Flow: try to burn fuel cells → try to dock nearby → claim insurance →
 * self-destruct as last resort (respawns at home base).
 * Returns true if recovery succeeded (bot is now docked or respawned).
 */
export async function recoverStranded(ctx: BotContext, opts?: { force?: boolean }): Promise<{ recovered: boolean; method: string }> {
  // Not stranded if docked
  if (ctx.player.dockedAtBase) return { recovered: true, method: "already_docked" };
  // Has fuel AND can actually reach a station → not stranded (unless forced by caller who already tried navigation)
  if (!opts?.force) {
    const canReachStation = (() => { try { return !ctx.fuel.isStranded(ctx.player.currentSystem, ctx.ship); } catch { return ctx.ship.fuel > 2; } })();
    if (ctx.ship.fuel > 0 && canReachStation) {
      return { recovered: false, method: "has_fuel" };
    }
  }

  log(ctx, `STRANDED: ${ctx.ship.fuel} fuel, attempting recovery`);

  // Step 1: Try burning cargo fuel cells
  const fuelCells = ctx.cargo.getItemQuantity(ctx.ship, "fuel_cell");
  if (fuelCells > 0) {
    try {
      await burnFuelCells(ctx);
      await ctx.refreshState();
      if (ctx.ship.fuel > 0) {
        log(ctx, `burned ${fuelCells} fuel cells, now have ${ctx.ship.fuel} fuel`);
        // Try to dock at nearest station
        try {
          await findAndDock(ctx);
          return { recovered: true, method: "fuel_cells" };
        } catch (err) { logWarn(ctx, `fuel cell recovery dock failed: ${err instanceof Error ? err.message : err}`); }
        return { recovered: true, method: "fuel_cells_undocked" };
      }
    } catch (err) { logWarn(ctx, `fuel cell burn failed: ${err instanceof Error ? err.message : err}`); }
  }

  // Step 2: Try docking at current POI (maybe we're at a station)
  if (ctx.station.canDock(ctx.player)) {
    try {
      await ctx.api.dock();
      await ctx.refreshState();
      if (ctx.player.dockedAtBase) {
        await refuelIfNeeded(ctx);
        return { recovered: true, method: "dock_in_place" };
      }
    } catch (err) { logWarn(ctx, `stranded dock attempt failed: ${err instanceof Error ? err.message : err}`); }
  }

  // Step 3: Try claiming insurance (may provide ship replacement at home)
  try {
    const claimResult = await ctx.api.claimInsurance();
    await ctx.refreshState();
    const payout = claimResult.payout ?? claimResult.credits ?? 0;
    if (payout > 0) {
      log(ctx, `insurance claimed: ${payout}cr payout`);
    }
    // Insurance claim might respawn us — check if we're docked now
    if (ctx.player.dockedAtBase) {
      await refuelIfNeeded(ctx);
      return { recovered: true, method: "insurance_claim" };
    }
  } catch {
    log(ctx, "no insurance to claim");
  }

  // Step 4: Self-destruct — respawns at home base with starter ship
  log(ctx, "SELF-DESTRUCT: no other recovery options, respawning at home base");
  try {
    await ctx.api.selfDestruct();
    await ctx.refreshState();
    // After self-destruct we should be at home base
    if (ctx.player.dockedAtBase) {
      await refuelIfNeeded(ctx);
    }
    return { recovered: true, method: "self_destruct" };
  } catch (err) {
    logError(ctx, "self-destruct failed", err);
    return { recovered: false, method: "failed" };
  }
}

/**
 * Ensure the bot won't run out of fuel before reaching a station.
 * Call this while docked before beginning a new work cycle.
 * Refuels first, then checks if fuel is still low (station out of fuel)
 * and attempts to buy fuel cells from the local market as a backup.
 */
export async function ensureFuelSafety(ctx: BotContext): Promise<void> {
  if (!ctx.player.dockedAtBase) return;

  // Refuel before undocking to ensure safety for travel
  const currentFuel = ctx.fuel.getPercentage(ctx.ship);
  if (currentFuel < FUEL_PREDEPARTURE_THRESHOLD) {
    try {
      await ctx.api.refuel();
      await ctx.refreshState();
    } catch (err) {
      logWarn(ctx, `pre-departure refuel failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // If fuel is still low after refuel, burn cargo fuel cells
  const fuelPct = ctx.fuel.getPercentage(ctx.ship);
  if (fuelPct < FUEL_LOW_BURN_THRESHOLD) {
    await burnFuelCells(ctx);
  }

  // Maintain fuel cell reserve: try faction storage first, then buy from market
  try {
    const currentCells = ctx.cargo.getItemQuantity(ctx.ship, "fuel_cell");
    const needCells = FUEL_CELL_RESERVE - currentCells;
    const fuelSize = ctx.cargo.getItemSize(ctx.ship, "fuel_cell");
    if (needCells > 0 && ctx.cargo.hasSpace(ctx.ship, needCells, fuelSize)) {
      let gotFromFaction = false;

      // Try faction storage first (free, no credits needed)
      if (ctx.settings.factionStorage || ctx.fleetConfig.defaultStorageMode === "faction_deposit") {
        try {
          await withdrawFromFaction(ctx, "fuel_cell", needCells);
          await ctx.refreshState();
          const afterWithdraw = ctx.cargo.getItemQuantity(ctx.ship, "fuel_cell");
          if (afterWithdraw > currentCells) {
            log(ctx, `withdrew ${afterWithdraw - currentCells}x fuel_cell from faction storage`);
            gotFromFaction = true;
          }
        } catch (err) {
          logWarn(ctx, `faction fuel cell withdrawal failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Buy from market if faction didn't cover it
      const stillNeed = FUEL_CELL_RESERVE - ctx.cargo.getItemQuantity(ctx.ship, "fuel_cell");
      if (!gotFromFaction || stillNeed > 0) {
        const orders = await ctx.api.viewMarket();
        const MAX_FUEL_CELL_PRICE = FUEL_CELL_MAX_PRICE;
        const fuelOrders = orders.filter(
          (o) =>
            o.type === "sell" &&
            o.quantity > 0 &&
            o.priceEach <= MAX_FUEL_CELL_PRICE &&
            (o.itemId === "fuel_cell" || o.itemId === "comp_fuel_tank" || o.itemId === "fuel_cell_premium")
        );
        if (fuelOrders.length > 0) {
          fuelOrders.sort((a, b) => a.priceEach - b.priceEach);
          const best = fuelOrders[0];
          const freeWeight = ctx.cargo.freeSpace(ctx.ship);
          const maxByWeight = Math.floor(freeWeight / Math.max(1, fuelSize));
          const buyQty = Math.min(Math.max(0, stillNeed), best.quantity, Math.floor(ctx.player.credits / best.priceEach), maxByWeight);
          if (buyQty > 0) {
            await ctx.api.buy(best.itemId, buyQty);
            await ctx.refreshState();
            log(ctx, `bought ${buyQty}x ${best.itemId} fuel cells @ ${best.priceEach}cr`);
          }
        } else {
          log(ctx, `fuel cells too expensive or unavailable — crafters should produce them`);
        }
      }
    }
  } catch (err) {
    logWarn(ctx, `fuel cell acquisition failed: ${err instanceof Error ? err.message : err}`);
  }

  // Ensure insurance before leaving station
  await ensureInsurance(ctx);
}

// ── Market Intelligence ──

/**
 * Call analyze_market if insights are stale (>30min) for the current station.
 * This is a rate-limited mutation (costs 1 tick), so it's gated by freshness.
 */
export async function analyzeMarketIfStale(ctx: BotContext): Promise<void> {
  const baseId = ctx.player.dockedAtBase;
  if (!baseId) return;

  try {
    await fleetAnalyzeMarket(ctx, baseId);
  } catch (err) {
    logWarn(ctx, `analyze_market failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Cargo ──

/**
 * Sell all of a specific item from cargo at the current station.
 * Returns the trade result or null if nothing to sell.
 */
export async function sellItem(ctx: BotContext, itemId: string): Promise<TradeResult | null> {
  const qty = ctx.cargo.getItemQuantity(ctx.ship, itemId);
  if (qty <= 0) return null;

  const result = await ctx.api.sell(itemId, qty);
  await ctx.refreshState();

  // Emit trade event for logging/tracking
  if (result.total > 0) {
    ctx.eventBus.emit({
      type: "trade_sell", botId: ctx.botId, itemId, quantity: result.quantity,
      priceEach: result.priceEach, total: result.total,
      stationId: ctx.player.dockedAtBase ?? "",
    });
  }
  return result;
}

export interface SellResult {
  totalEarned: number;
  items: Array<{ itemId: string; quantity: number; priceEach: number; total: number }>;
}

/**
 * Sell all cargo items at the current station.
 * Skips protected items (fuel cells etc.) — those are kept as emergency reserves.
 * Skips items that would sell for 0cr (no demand at this station).
 * Returns total credits earned and per-item details.
 */
export async function sellAllCargo(ctx: BotContext): Promise<SellResult> {
  let totalEarned = 0;
  const items: SellResult["items"] = [];
  const cargoSnapshot = [...ctx.ship.cargo]; // Snapshot — cargo changes as we sell
  for (const item of cargoSnapshot) {
    if (ctx.shouldStop) break;
    if (isProtectedItem(item.itemId)) continue;
    try {
      const result = await ctx.api.sell(item.itemId, item.quantity);
      if (result.priceEach === 0 && result.total === 0) {
        log(ctx, `skipped ${item.itemId} (no demand at this station)`);
        continue;
      }
      totalEarned += result.total;
      items.push({ itemId: item.itemId, quantity: result.quantity, priceEach: result.priceEach, total: result.total });
      log(ctx, `sold ${result.quantity}x ${item.itemId} @ ${result.priceEach}cr = ${result.total}cr`);
      // Emit trade event for logging/tracking
      if (result.total > 0) {
        ctx.eventBus.emit({
          type: "trade_sell", botId: ctx.botId, itemId: item.itemId, quantity: result.quantity,
          priceEach: result.priceEach, total: result.total,
          stationId: ctx.player.dockedAtBase ?? "",
        });
      }
      // Record successful sell as demand signal for arbitrage discovery
      if (ctx.player.dockedAtBase && result.priceEach > 0) {
        recordSellResult(ctx, ctx.player.dockedAtBase, item.itemId, item.itemId, result.priceEach, result.quantity);
      }
    } catch (err) {
      logWarn(ctx, `sell failed for ${item.itemId}: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Single refresh after all sales
  if (items.length > 0) await ctx.refreshState();
  if (totalEarned > 0) log(ctx, `total sold: ${totalEarned}cr`);
  return { totalEarned, items };
}

/**
 * Deposit all of a specific item to storage.
 * Skips protected items (fuel cells etc.).
 * Uses faction storage if: bot settings.factionStorage is true,
 * OR bot settings.storageMode is "faction_deposit",
 * OR fleet config defaultStorageMode is "faction_deposit".
 *
 * Throws on failure — callers should catch and handle (e.g., fallback to sell).
 */
export async function depositItem(ctx: BotContext, itemId: string): Promise<void> {
  const qty = ctx.cargo.getItemQuantity(ctx.ship, itemId);
  if (qty <= 0) return;
  if (isProtectedItem(itemId)) return;

  const useFaction = ctx.settings.factionStorage
    || ctx.settings.storageMode === "faction_deposit"
    || ctx.fleetConfig.defaultStorageMode === "faction_deposit";

  if (useFaction) {
    await ctx.api.factionDepositItems(itemId, qty);
    ctx.cache.invalidateFactionStorage();
    ctx.eventBus.emit({
      type: "deposit", botId: ctx.botId, itemId, quantity: qty,
      target: "faction", stationId: ctx.player.dockedAtBase ?? "",
    });
  } else {
    await ctx.api.depositItems(itemId, qty);
  }
  await ctx.refreshState();
}

/**
 * Withdraw items from faction storage with event tracking.
 * Emits a "withdraw" event so faction-tracker can log it.
 */
export async function withdrawFromFaction(ctx: BotContext, itemId: string, quantity: number): Promise<void> {
  await ctx.api.factionWithdrawItems(itemId, quantity);
  ctx.cache.invalidateFactionStorage();
  ctx.eventBus.emit({
    type: "withdraw", botId: ctx.botId, itemId, quantity,
    source: "faction", stationId: ctx.player.dockedAtBase ?? "",
  });
}

/**
 * Dispose of cargo based on bot settings:
 *   - "sell": sell all items (default)
 *   - "deposit": deposit to personal storage
 *   - "faction_deposit": deposit to faction storage
 * Returns total credits earned (0 if depositing).
 */
export async function disposeCargo(ctx: BotContext): Promise<SellResult> {
  const mode = ctx.settings.storageMode;
  log(ctx, `disposing cargo (mode: ${mode})`);

  if (mode === "deposit" || mode === "faction_deposit") {
    const items: SellResult["items"] = [];
    let depositFailed = false;
    const cargoSnapshot = [...ctx.ship.cargo]; // Snapshot before depositing
    for (const item of cargoSnapshot) {
      if (ctx.shouldStop) break;
      if (isProtectedItem(item.itemId)) continue;
      const qty = item.quantity;
      try {
        if (mode === "faction_deposit") {
          await ctx.api.factionDepositItems(item.itemId, qty);
          ctx.cache.invalidateFactionStorage();
          ctx.eventBus.emit({
            type: "deposit", botId: ctx.botId, itemId: item.itemId, quantity: qty,
            target: "faction", stationId: ctx.player.dockedAtBase ?? "",
          });
        } else {
          await ctx.api.depositItems(item.itemId, qty);
        }
        log(ctx, `deposited ${qty}x ${item.itemId} to ${mode === "faction_deposit" ? "faction" : "personal"} storage`);
        items.push({ itemId: item.itemId, quantity: qty, priceEach: 0, total: 0 });
      } catch (err) {
        logWarn(ctx, `deposit failed for ${item.itemId}: ${err instanceof Error ? err.message : err}`);
        depositFailed = true;
        break;
      }
    }
    // Single refresh after all deposits (or on failure for accurate remaining cargo)
    await ctx.refreshState();
    // If deposit failed, sell only the REMAINING cargo (not already-deposited items)
    if (depositFailed) {
      if (ctx.ship.cargo.length > 0) {
        logWarn(ctx, "falling back to selling remaining cargo");
        const sellResult = await sellAllCargo(ctx);
        return { totalEarned: sellResult.totalEarned, items: [...items, ...sellResult.items] };
      }
    }
    return { totalEarned: 0, items };
  }

  // Default: sell
  return sellAllCargo(ctx);
}

// ── Emergency ──

/**
 * Check if fuel is critically low and handle emergency.
 * Tries: burn cargo cells → dock at current → navigate to station.
 * Returns true if emergency action was taken.
 */
export async function handleFuelEmergency(ctx: BotContext): Promise<boolean> {
  const level = ctx.fuel.getLevel(ctx.ship);
  if (level !== "critical" && level !== "low") return false;

  logWarn(ctx, `fuel emergency (${level}) at ${ctx.player.currentSystem}/${ctx.player.currentPoi ?? "space"}, fuel=${ctx.fuel.getPercentage(ctx.ship).toFixed(0)}%`);

  // If docked, just refuel
  if (ctx.player.dockedAtBase) {
    try {
      await ctx.api.refuel();
      log(ctx, "emergency refuel at station");
    } catch (err) {
      logWarn(ctx, `emergency refuel failed: ${err instanceof Error ? err.message : err}`);
    }
    await ctx.refreshState();
    return true;
  }

  // Try burning fuel cells from cargo first (works anywhere)
  const burned = await burnFuelCells(ctx);
  if (burned) {
    log(ctx, "burned fuel cells in emergency");
    await ctx.refreshState();
    const newLevel = ctx.fuel.getLevel(ctx.ship);
    if (newLevel !== "critical" && newLevel !== "low") return true;
  }

  // Refresh system data so we know which POIs have bases
  await ensureSystemDetail(ctx);

  // Try docking at current POI (only if it has a base)
  if (ctx.station.canDock(ctx.player)) {
    try {
      log(ctx, "emergency docking at current POI");
      await ctx.api.dock();
      await ctx.refreshState();
      if (ctx.player.dockedAtBase) {
        try { await ctx.api.refuel(); } catch (err) { logWarn(ctx, `emergency refuel failed: ${err instanceof Error ? err.message : err}`); }
        await ctx.refreshState();
        return true;
      }
    } catch (err) {
      logWarn(ctx, `emergency dock failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Only attempt navigation if we have ENOUGH fuel (>10%) — don't burn last drops
  const fuelPct = ctx.fuel.getPercentage(ctx.ship);
  if (fuelPct > 10) {
    const nearest = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
    if (nearest && nearest.systemId === ctx.player.currentSystem) {
      // Only travel within current system — don't attempt jumps on critical fuel
      try {
        log(ctx, `emergency travel to nearest station: ${nearest.poiId}`);
        await ctx.api.travel(nearest.poiId);
        await ctx.refreshState();
        await dockAtCurrent(ctx);
        return true;
      } catch (err) {
        logError(ctx, `emergency travel failed`, err);
      }
    }
  }

  // Stranded — all navigation attempts above failed, force recovery (insurance/self-destruct)
  log(ctx, `stranded at ${ctx.player.currentSystem} with ${fuelPct.toFixed(0)}% fuel — attempting recovery`);
  const recovery = await recoverStranded(ctx, { force: true });
  if (recovery.recovered) {
    log(ctx, `fuel emergency recovery: ${recovery.method}`);
    if (ctx.player.dockedAtBase) await serviceShip(ctx);
    return true;
  }

  logError(ctx, `STRANDED at ${ctx.player.currentSystem} with ${fuelPct.toFixed(0)}% fuel — waiting for rescue`);
  return false;
}

/**
 * Check if ship needs emergency repair.
 */
export function needsEmergencyRepair(ctx: BotContext): boolean {
  return (ctx.ship.hull / ctx.ship.maxHull) * 100 < EMERGENCY_HULL_THRESHOLD;
}

/**
 * Full safety check - returns a reason string if unsafe, null if ok.
 * Triggers at low fuel (<30%) and critical hull (<25%).
 * Proactive fuel safety is handled by ensureFuelSafety() before undocking.
 */
export function safetyCheck(ctx: BotContext): string | null {
  const fuelLevel = ctx.fuel.getLevel(ctx.ship);
  if (fuelLevel === "critical") return "fuel_critical";
  if (fuelLevel === "low") return "fuel_low";
  if (needsEmergencyRepair(ctx)) return "hull_critical";
  return null;
}

/**
 * Handle any emergency condition by docking and servicing.
 * If not at a station, navigates to the nearest one.
 * Returns true if emergency was handled.
 */
export async function handleEmergency(ctx: BotContext): Promise<boolean> {
  const issue = safetyCheck(ctx);
  if (!issue) return false;

  logWarn(ctx, `emergency: ${issue}`);

  // If already docked, just service
  if (ctx.player.dockedAtBase) {
    log(ctx, "servicing at current station for emergency");
    await serviceShip(ctx);
    return true;
  }

  // Refresh system data so we know which POIs have bases
  await ensureSystemDetail(ctx);

  // Try to dock at current POI (only if it has a base)
  if (ctx.station.canDock(ctx.player)) {
    try {
      log(ctx, "emergency: attempting dock at current POI");
      await ctx.api.dock();
      await ctx.refreshState();
      if (ctx.player.dockedAtBase) {
        await serviceShip(ctx);
        return true;
      }
    } catch (err) {
      logWarn(ctx, `emergency dock failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Navigate to nearest station (with fresh POI data)
  const target = ctx.station.chooseDockTarget(ctx.player, ctx.ship);
  if (target) {
    try {
      log(ctx, `emergency: navigating to ${target.systemId}/${target.poiId}`);
      await navigateTo(ctx, target.systemId, target.poiId);
      await dockAtCurrent(ctx);
      return true;
    } catch (err) {
      logError(ctx, `emergency navigation failed`, err);
    }
  }

  // Last resort: if fuel is critically low and we failed to reach a station, attempt recovery.
  // Force=true because we already tried navigation above and it failed — isStranded() may
  // report "not stranded" if station is in same system (only checks inter-system jumps).
  if (issue === "fuel_critical" || issue === "fuel_low") {
    log(ctx, "attempting stranded recovery (fuel cells/insurance/self-destruct)");
    const recovery = await recoverStranded(ctx, { force: true });
    if (recovery.recovered) {
      log(ctx, `stranded recovery succeeded via ${recovery.method}`);
      if (ctx.player.dockedAtBase) await serviceShip(ctx);
      return true;
    }
  }

  logError(ctx, `emergency unresolved: ${issue} — bot may be stranded`);
  return false;
}

// ── Mining ──

/**
 * Mine until cargo is full or resource is depleted.
 * Yields state labels for each mining cycle.
 */
export async function* mineUntilFull(
  ctx: BotContext,
  targetOre?: string
): AsyncGenerator<RoutineYield, MiningYield | null, void> {
  let mineCount = 0;
  while (!ctx.shouldStop && ctx.cargo.hasSpace(ctx.ship, 1)) {
    try {
      const result = await ctx.api.mine();
      mineCount++;
      if (mineCount % 5 === 0 || result.quantity === 0 || result.remaining === 0) {
        await ctx.refreshState();
      }

      if (result.quantity === 0 || result.remaining === 0) {
        yield `resource depleted`;
        return null;
      }

      yield `mined ${result.quantity} ${result.resourceId}`;
    } catch (err) {
      yield `mining error: ${err instanceof Error ? err.message : String(err)}`;
      return null;
    }
  }
  if (mineCount > 0) await ctx.refreshState();

  yield "cargo full";
  return null;
}

// ── Utility ──

// ── Market Data ──

/**
 * Aggregate MarketOrder[] into MarketPrice[] and cache for the station.
 * Call this whenever a routine fetches market orders to feed the market pipeline.
 * Excludes bot's own orders so we don't compete against ourselves in pricing/volume.
 */
export function cacheMarketData(ctx: BotContext, stationId: string, orders: MarketOrder[]): void {
  if (!stationId || orders.length === 0) return;

  // Filter out bot's own orders — we don't want to see our own sell orders as "supply"
  // or our own buy orders as "demand" when computing market prices
  const ownPlayerId = ctx.player.id;
  const externalOrders = orders.filter(o => o.playerId !== ownPlayerId);

  // Group orders by item
  const byItem = new Map<string, { name: string; sells: { price: number; qty: number }[]; buys: { price: number; qty: number }[] }>();

  for (const order of externalOrders) {
    if (!byItem.has(order.itemId)) {
      byItem.set(order.itemId, { name: order.itemName, sells: [], buys: [] });
    }
    const bucket = byItem.get(order.itemId)!;
    if (order.type === "sell") {
      bucket.sells.push({ price: order.priceEach, qty: order.quantity });
    } else {
      bucket.buys.push({ price: order.priceEach, qty: order.quantity });
    }
  }

  const prices: MarketPrice[] = [];
  for (const [itemId, data] of byItem) {
    prices.push({
      itemId,
      itemName: data.name,
      buyPrice: data.sells.length > 0 ? Math.min(...data.sells.map((s) => s.price)) : null,
      sellPrice: data.buys.length > 0 ? Math.max(...data.buys.map((b) => b.price)) : null,
      buyVolume: data.sells.reduce((sum, s) => sum + s.qty, 0),
      sellVolume: data.buys.reduce((sum, b) => sum + b.qty, 0),
    });
  }

  ctx.cache.setMarketPrices(stationId, prices, Math.floor(Date.now() / 1000));

  // Submit to faction shared trade intel (best-effort, non-blocking)
  if (ctx.player.factionId) {
    ctx.api.factionSubmitTradeIntel([{
      base_id: stationId,
      prices: prices.map(p => ({
        item_id: p.itemId,
        buy_price: p.buyPrice,
        sell_price: p.sellPrice,
        buy_volume: p.buyVolume,
        sell_volume: p.sellVolume,
      })),
    }]).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Suppress no_trade_ledger spam — faction needs a trade intel facility first
      if (!msg.includes("no_trade_ledger")) {
        logWarn(ctx, `faction trade intel submit failed: ${msg}`);
      }
    });
  }
}

/**
 * Record a successful sell as a demand signal in the market cache.
 * NPC demand doesn't appear in view_market, so we enrich the cache
 * with actual sell results to help arbitrage discovery.
 */
export function recordSellResult(
  ctx: BotContext, stationId: string, itemId: string, itemName: string,
  priceEach: number, quantity: number,
): void {
  if (!stationId || !itemId || priceEach <= 0 || quantity <= 0) return;

  const existing = ctx.cache.getMarketPrices(stationId) ?? [];
  const entry = existing.find((p) => p.itemId === itemId);
  if (entry) {
    // Update sell price (demand) if our actual result is better data
    if (!entry.sellPrice || priceEach > 0) {
      entry.sellPrice = priceEach;
      entry.sellVolume = Math.max(entry.sellVolume, quantity);
    }
  } else {
    // Add new item to cache — we know there's demand here
    existing.push({
      itemId,
      itemName,
      buyPrice: null,
      sellPrice: priceEach,
      buyVolume: 0,
      sellVolume: quantity,
    });
  }
  ctx.cache.setMarketPrices(stationId, existing, Math.floor(Date.now() / 1000));
}

/**
 * Optimistic market update: adjust cached volumes after a buy or sell.
 * Prevents other bots from targeting the same depleted supply/demand.
 * Call after a successful buy() or sell() API call.
 *
 * action "buy": we bought from sell orders → reduce buyVolume (available supply)
 * action "sell": we sold into buy orders → reduce sellVolume (available demand)
 */
export function adjustMarketCache(
  ctx: BotContext, stationId: string, itemId: string,
  action: "buy" | "sell", quantity: number,
  opts?: { zeroDemand?: boolean },
): void {
  if (!stationId || !itemId || quantity <= 0) return;
  const prices = ctx.cache.getMarketPrices(stationId);
  if (!prices) return;

  const entry = prices.find((p) => p.itemId === itemId);
  if (!entry) return;

  if (action === "buy") {
    // We bought from sell orders → less supply available
    entry.buyVolume = Math.max(0, entry.buyVolume - quantity);
  } else {
    // We sold into buy orders → less demand available
    entry.sellVolume = Math.max(0, entry.sellVolume - quantity);
    // Zero out sell price when confirmed no demand (prevents stale arbitrage rediscovery)
    if (opts?.zeroDemand) {
      entry.sellPrice = 0;
      entry.sellVolume = 0;
    }
  }

  ctx.cache.setMarketPrices(stationId, prices, Math.floor(Date.now() / 1000));
}

// ── Fleet-wide Query Dedup Wrappers ──
// These prevent redundant API calls when multiple bots are at the same station/system.
// In-flight requests are coalesced, and recently-fetched data is reused.

/**
 * Fleet-deduped viewMarket. If another bot fetched this station's market within 60s,
 * returns cached orders (empty array signals "use cache"). Coalesces in-flight requests.
 * Always caches the result for the fleet.
 */
export async function fleetViewMarket(
  ctx: BotContext, stationId: string, category?: string,
): Promise<MarketOrder[]> {
  // Category-filtered queries bypass dedup (rare, targeted calls like "module" filter)
  if (category) return ctx.api.viewMarket(undefined, category);

  const orders = await ctx.cache.dedupViewMarket(stationId, () => ctx.api.viewMarket());
  if (orders.length > 0) {
    cacheMarketData(ctx, stationId, orders);
  }
  return orders;
}

/**
 * Fleet-deduped getSystem. If another bot fetched this system within 2min,
 * returns cached data. Coalesces in-flight requests. Updates galaxy graph.
 */
export async function fleetGetSystem(ctx: BotContext): Promise<import("../types/game").StarSystem> {
  const systemId = ctx.player.currentSystem;
  const result = await ctx.cache.dedupGetSystem(systemId, () => ctx.api.getSystem());
  if (result) {
    ctx.galaxy.updateSystem(result);
    ctx.cache.setSystemDetail(result.id, result);
    return result;
  }
  // Dedup returned cached — read from galaxy graph
  const cached = ctx.galaxy.getSystem(systemId);
  if (cached) return cached;
  // Fallback: force fetch (shouldn't happen, but safety net)
  const fresh = await ctx.api.getSystem();
  if (fresh?.id) {
    ctx.galaxy.updateSystem(fresh);
    ctx.cache.setSystemDetail(fresh.id, fresh);
  }
  return fresh;
}

/**
 * Fleet-deduped analyzeMarket. Skips if insights are fresh (30min).
 * Coalesces in-flight requests. Mutation (costs 1 tick).
 */
export async function fleetAnalyzeMarket(ctx: BotContext, stationId: string): Promise<void> {
  await ctx.cache.dedupAnalyzeMarket(stationId, () => ctx.api.analyzeMarket(stationId));
}

/**
 * Fleet-deduped viewFactionStorage. Faction storage is shared across all bots —
 * if fetched within 30s, returns cached data. Coalesces in-flight requests.
 */
export async function fleetViewFactionStorage(
  ctx: BotContext,
): Promise<{ credits: number; items: import("../types/game").CargoItem[]; itemNames: Map<string, string> }> {
  return ctx.cache.dedupFactionStorage(() => ctx.api.viewFactionStorageFull());
}

/**
 * Fleet-deduped shipyardShowroom. Returns cached data if within 30min fresh window.
 * Coalesces in-flight requests. Auto-caches to shipyard cache.
 */
export async function fleetShipyardShowroom(
  ctx: BotContext, stationId: string,
): Promise<Array<{ id: string; name: string; classId: string; price: number }>> {
  return ctx.cache.dedupShipyard(stationId, async () => {
    const showroom = await ctx.api.shipyardShowroom();
    return showroom.map((s) => ({
      id: String(s.id ?? s.ship_id ?? ""),
      name: String(s.name ?? s.ship_name ?? "Unknown"),
      classId: String(s.class_id ?? s.ship_class ?? s.classId ?? ""),
      price: Number(s.price ?? s.cost ?? 0),
    }));
  });
}

/**
 * Fleet-deduped getPoi. POI resource data is global — same for all bots.
 * Returns detail if freshly fetched, or null if within 5min dedup window (use galaxy cache).
 * Auto-updates galaxy POI resources.
 */
export async function fleetGetPoi(
  ctx: BotContext, poiId: string,
): Promise<import("../types/game").PoiDetail | null> {
  const detail = await ctx.cache.dedupPoi(poiId, () => ctx.api.getPoi());
  if (detail && detail.resources.length > 0) {
    ctx.galaxy.updatePoiResources(poiId, detail.resources);
  }
  return detail;
}

/**
 * Get a typed param from context with a default.
 */
export function getParam<T>(ctx: BotContext, key: string, defaultValue: T): T {
  const val = ctx.params[key];
  return val !== undefined ? (val as T) : defaultValue;
}

/**
 * Sleep for a duration, respecting shouldStop.
 */
export async function interruptibleSleep(ctx: BotContext, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (ctx.shouldStop) return false;
    await new Promise((r) => setTimeout(r, Math.min(1000, ms - (Date.now() - start))));
  }
  return true;
}

// ── Module Equipment ──

/**
 * Equip/unequip modules for a routine. Handles docking if needed, withdraws from
 * faction storage, and yields progress messages. Caches faction storage lookup.
 *
 * Returns an async generator of status messages (yields).
 */
/**
 * Check if a module can fit in the ship's remaining CPU/power capacity.
 * When swapping (removing an old module), accounts for the freed resources.
 * Returns { fits: true } or { fits: false, reason: string }.
 */
export function canFitModule(
  ctx: BotContext,
  newModuleId: string,
  removingModuleId?: string,
): { fits: boolean; reason?: string } {
  const newSpecs = ctx.cache.getCatalogItem(newModuleId);
  const cpuCost = newSpecs?.cpuCost ?? 0;
  const powerCost = newSpecs?.powerCost ?? 0;

  // If we don't know the module's cost, allow it (let the API reject if it doesn't fit)
  if (cpuCost === 0 && powerCost === 0) return { fits: true };

  let cpuFree = ctx.ship.cpuCapacity - ctx.ship.cpuUsed;
  let powerFree = ctx.ship.powerCapacity - ctx.ship.powerUsed;

  // Account for resources freed by removing the old module
  if (removingModuleId) {
    const oldSpecs = ctx.cache.getCatalogItem(removingModuleId);
    cpuFree += oldSpecs?.cpuCost ?? 0;
    powerFree += oldSpecs?.powerCost ?? 0;
  }

  if (cpuCost > cpuFree) {
    return { fits: false, reason: `CPU: need ${cpuCost}, free ${cpuFree}` };
  }
  if (powerCost > powerFree) {
    return { fits: false, reason: `Power: need ${powerCost}, free ${powerFree}` };
  }
  return { fits: true };
}

export async function* equipModulesForRoutine(
  ctx: BotContext,
  equipModules: string[],
  unequipModules: string[] = [],
): AsyncGenerator<RoutineYield, void, void> {
  if (equipModules.length === 0 && unequipModules.length === 0) return;

  // Dock if not already docked
  const wasDocked = !!ctx.player.dockedAtBase;
  if (!wasDocked) {
    try {
      await findAndDock(ctx);
    } catch {
      yield "could not dock for module equip — continuing without";
      return;
    }
  }

  // Unequip modules that aren't needed
  for (const modId of unequipModules) {
    if (ctx.shouldStop) return;
    try {
      await ctx.api.uninstallMod(modId);
      await ctx.refreshState();
      yield `unequipped ${modId}`;
    } catch (err) {
      yield `unequip ${modId} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Equip modules — supports duplicates (e.g. 3x mining_laser) and prefers highest tier
  let factionStorage: Array<{ itemId: string; quantity: number }> | null = null;
  // Track how many of each pattern we've already satisfied (handles duplicate requests)
  const equippedForPattern = new Map<string, number>();
  for (const modPattern of equipModules) {
    equippedForPattern.set(modPattern, (equippedForPattern.get(modPattern) ?? 0) + 1);
  }
  // Count already-equipped modules per pattern
  const alreadyEquipped = new Map<string, number>();
  for (const mod of ctx.ship.modules) {
    for (const pattern of equippedForPattern.keys()) {
      if (mod.moduleId.includes(pattern)) {
        alreadyEquipped.set(pattern, (alreadyEquipped.get(pattern) ?? 0) + 1);
        break;
      }
    }
  }
  // Compute how many more of each pattern we need
  const needed = new Map<string, number>();
  for (const [pattern, want] of equippedForPattern) {
    const have = alreadyEquipped.get(pattern) ?? 0;
    if (want > have) needed.set(pattern, want - have);
  }

  for (const [modPattern, count] of needed) {
    for (let i = 0; i < count; i++) {
      if (ctx.shouldStop) return;

      // Check cargo first — prefer highest tier (sort descending by ID suffix)
      const cargoMatches = ctx.ship.cargo
        .filter((c) => c.itemId.includes(modPattern) && c.quantity > 0)
        .sort((a, b) => b.itemId.localeCompare(a.itemId));
      // Filter to modules that fit the ship
      const fittingCargo = cargoMatches.filter(c => canFitModule(ctx, c.itemId).fits);
      if (fittingCargo.length > 0) {
        const best = fittingCargo[0];
        try {
          await ctx.api.installMod(best.itemId);
          await ctx.refreshState();
          yield `equipped ${best.itemId} from cargo`;
          continue;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("cpu") || msg.includes("power") || msg.includes("slot")) {
            yield `ship slots full — ${msg}`;
            return;
          }
          yield `equip ${best.itemId} failed: ${msg}`;
        }
      } else if (cargoMatches.length > 0) {
        // Had matching modules but none fit
        const check = canFitModule(ctx, cargoMatches[0].itemId);
        yield `${cargoMatches[0].itemId} won't fit: ${check.reason}`;
        break;
      }

      // Withdraw from faction storage — prefer highest tier
      try {
        if (!factionStorage) {
          const factionData = await fleetViewFactionStorage(ctx);
          factionStorage = factionData.items.filter(i => i.quantity > 0);
        }
        const storageMatches = factionStorage
          .filter((s) => s.itemId.includes(modPattern) && s.quantity > 0 && canFitModule(ctx, s.itemId).fits)
          .sort((a, b) => b.itemId.localeCompare(a.itemId)); // Highest tier first
        const mod = storageMatches[0];
        if (mod) {
          await withdrawFromFaction(ctx, mod.itemId, 1);
          await ctx.refreshState();
          mod.quantity--;
          yield `withdrew ${mod.itemId} from faction storage`;
          try {
            await ctx.api.installMod(mod.itemId);
            await ctx.refreshState();
            yield `equipped ${mod.itemId}`;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Deposit it back
            try {
              await ctx.api.factionDepositItems(mod.itemId, 1);
              ctx.cache.invalidateFactionStorage();
              await ctx.refreshState();
              mod.quantity++;
            } catch { /* best effort */ }
            // CPU/power full — stop trying
            if (msg.includes("cpu") || msg.includes("power") || msg.includes("slot")) {
              yield `ship slots full — ${msg}`;
              return;
            }
            yield `equip ${mod.itemId} failed: ${msg}`;
          }
        } else {
          // Check other known stations for this module
          const remote = await ctx.cache.findItemSeller(modPattern, ctx.player.credits - 1000);
          if (remote && remote.stationId !== ctx.player.dockedAtBase && canFitModule(ctx, remote.itemId).fits) {
            yield `no ${modPattern} locally — traveling to buy at remote station`;
            try {
              await navigateAndDock(ctx, remote.stationId);
              await ctx.api.buy(remote.itemId, 1);
              await ctx.refreshState();
              try {
                await ctx.api.installMod(remote.itemId);
                await ctx.refreshState();
                yield `bought & equipped ${remote.itemId} for ${remote.price}cr (remote)`;
                continue;
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                try { await ctx.api.factionDepositItems(remote.itemId, 1); ctx.cache.invalidateFactionStorage(); await ctx.refreshState(); } catch { /* best effort */ }
                if (msg.includes("cpu") || msg.includes("power") || msg.includes("slot")) {
                  yield `ship slots full — ${msg}`;
                  return;
                }
                yield `install ${remote.itemId} failed: ${msg}`;
              }
            } catch (err) {
              yield `remote module buy failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          yield `no ${modPattern} available — continuing without`;
          break; // No more of this pattern available, skip remaining count
        }
      } catch (err) {
        yield `module withdraw failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // Undock if we docked just for equipping
  if (!wasDocked && ctx.player.dockedAtBase) {
    await ctx.api.undock();
    await ctx.refreshState();
  }
}

// ── Faction Treasury ──

/**
 * Deposit a percentage of earned credits into faction treasury.
 * Call after a profitable sell. Returns the amount deposited, or 0 if skipped.
 * Must be docked to deposit.
 */
export async function payFactionTax(ctx: BotContext, earned: number): Promise<{ deposited: number; message: string }> {
  const pct = ctx.fleetConfig.factionTaxPercent;
  if (pct <= 0 || earned <= 0 || !ctx.player.dockedAtBase) {
    return { deposited: 0, message: "" };
  }

  const taxAmount = Math.floor(earned * pct / 100);
  if (taxAmount <= 0) return { deposited: 0, message: "" };

  try {
    await ctx.api.factionDepositCredits(taxAmount);
    await ctx.refreshState();
    ctx.recordFactionDeposit(taxAmount); // Exclude from cost tracking
    // Log to faction transactions via logger (if available)
    ctx.logger.logFactionCreditTx?.("credit_deposit", ctx.botId, taxAmount, `tax ${pct}%`);
    return { deposited: taxAmount, message: `faction tax: deposited ${taxAmount}cr (${pct}%)` };
  } catch (err) {
    log(ctx, `faction tax failed: ${err instanceof Error ? err.message : String(err)}`);
    return { deposited: 0, message: "" };
  }
}

/**
 * Withdraw credits from faction treasury if bot is below minimum.
 * Call at the end of a cycle when docked. Returns amount withdrawn.
 */
export async function ensureMinCredits(ctx: BotContext): Promise<{ withdrawn: number; message: string }> {
  const minCredits = ctx.fleetConfig.minBotCredits;
  if (minCredits <= 0 || !ctx.player.dockedAtBase) {
    return { withdrawn: 0, message: "" };
  }

  const deficit = minCredits - ctx.player.credits;
  if (deficit <= 0) return { withdrawn: 0, message: "" };

  try {
    await ctx.api.factionWithdrawCredits(deficit);
    await ctx.refreshState();
    ctx.logger.logFactionCreditTx?.("credit_withdraw", ctx.botId, deficit, `min credits top-up`);
    ctx.recordFactionWithdrawal(deficit); // Exclude from revenue tracking
    return { withdrawn: deficit, message: `withdrew ${deficit}cr from faction treasury (credits were below ${minCredits}cr minimum)` };
  } catch (err) {
    log(ctx, `faction withdraw failed: ${err instanceof Error ? err.message : String(err)}`);
    return { withdrawn: 0, message: "" };
  }
}

/**
 * Deposit excess credits to faction treasury if bot is above maximum.
 * Call at the end of a cycle when docked. Returns amount deposited.
 */
export async function depositExcessCredits(ctx: BotContext): Promise<{ deposited: number; message: string }> {
  const maxCredits = ctx.fleetConfig.maxBotCredits;
  if (maxCredits <= 0 || !ctx.player.dockedAtBase) {
    return { deposited: 0, message: "" };
  }

  const excess = ctx.player.credits - maxCredits;
  if (excess <= 0) return { deposited: 0, message: "" };

  try {
    await ctx.api.factionDepositCredits(excess);
    await ctx.refreshState();
    ctx.recordFactionDeposit(excess); // Exclude from cost tracking
    ctx.logger.logFactionCreditTx?.("credit_deposit", ctx.botId, excess, `max credits cap`);
    return { deposited: excess, message: `deposited ${excess}cr to faction treasury (credits exceeded ${maxCredits}cr cap)` };
  } catch (err) {
    log(ctx, `faction deposit failed: ${err instanceof Error ? err.message : String(err)}`);
    return { deposited: 0, message: "" };
  }
}

// ── Centralized Logistics ──

/**
 * Collect scattered cargo from personal storage at the current docked station.
 * Withdraws non-protected items up to free cargo capacity.
 * Returns the count of items collected (item types, not units).
 */
export async function collectScatteredCargo(ctx: BotContext): Promise<number> {
  if (!ctx.player.dockedAtBase) return 0;

  let collected = 0;
  try {
    const storage = await ctx.api.viewStorage();
    if (!storage || storage.length === 0) return 0;

    const items = Array.isArray(storage) ? storage : [];
    for (const item of items) {
      if (ctx.shouldStop) break;
      if (isProtectedItem(item.itemId)) continue;
      if (item.quantity <= 0) continue;

      const freeWeight = ctx.cargo.freeSpace(ctx.ship);
      if (freeWeight <= 0) break;

      const itemSize = ctx.cargo.getItemSize(ctx.ship, item.itemId);
      const maxByWeight = Math.floor(freeWeight / Math.max(1, itemSize));
      if (maxByWeight <= 0) continue;

      const withdrawQty = Math.min(item.quantity, maxByWeight);
      try {
        await ctx.api.withdrawItems(item.itemId, withdrawQty);
        await ctx.refreshState();
        log(ctx, `collected ${withdrawQty}x ${item.itemId} from personal storage`);
        collected++;
      } catch (err) {
        logWarn(ctx, `collect ${item.itemId} from storage failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logWarn(ctx, `collectScatteredCargo: storage check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return collected;
}

/**
 * Deposit all non-protected cargo items to faction storage.
 * Returns the count of item types deposited.
 * Invalidates faction storage cache after deposit.
 */
export async function depositAllToFaction(ctx: BotContext): Promise<number> {
  let deposited = 0;
  const cargoSnapshot = [...ctx.ship.cargo];
  for (const item of cargoSnapshot) {
    if (ctx.shouldStop) break;
    if (isProtectedItem(item.itemId)) continue;
    if (item.quantity <= 0) continue;

    try {
      await ctx.api.factionDepositItems(item.itemId, item.quantity);
      ctx.cache.invalidateFactionStorage();
      ctx.eventBus.emit({
        type: "deposit", botId: ctx.botId, itemId: item.itemId, quantity: item.quantity,
        target: "faction", stationId: ctx.player.dockedAtBase ?? "",
      });
      log(ctx, `deposited ${item.quantity}x ${item.itemId} to faction storage`);
      deposited++;
    } catch (err) {
      logWarn(ctx, `depositAllToFaction: deposit ${item.itemId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (deposited > 0) await ctx.refreshState();
  return deposited;
}

