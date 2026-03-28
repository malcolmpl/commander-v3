/**
 * Scout routine - continuous market data patrol.
 *
 * Rotates through trade hub systems, docking at every station and scanning
 * markets. Re-visits systems when their data goes stale (>30 min).
 * Keeps running indefinitely — not a one-shot routine.
 *
 * Params:
 *   targetSystem: string        - Single system to scout (legacy, used if targetSystems empty)
 *   targetSystems: string[]     - Systems to patrol in order (loops forever)
 *   scanMarket: boolean         - Scan market on dock (default: true)
 *   checkFaction: boolean       - Check faction storage/info at first stop (default: true)
 *   staleTtlMs: number          - Consider data stale after this many ms (default: 1800000 = 30min)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateTo,
  navigateAndDock,
  ensureSystemDetail,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  cacheMarketData,
  getParam,
  interruptibleSleep,
  fleetViewMarket,
  fleetGetSystem,
  fleetViewFactionStorage,
} from "./helpers";

/**
 * Default trade hub systems to patrol when no targetSystems param is given.
 * Hardcoded so scouts work immediately without galaxy data.
 */
const DEFAULT_TRADE_HUBS = [
  "sol", "nova_terra", "sirius", "procyon", "alpha_centauri", "nexus_prime",
];

/** Scan all stations in the current system, returns count of stations scanned */
async function* scanSystemStations(
  ctx: BotContext,
  staleTtlMs: number,
): AsyncGenerator<RoutineYield, number, void> {
  let scanned = 0;

  // Scan current station — always scan if data is older than 30s
  // (findAndDock may have just cached it, but we count that as scanned)
  if (ctx.player.dockedAtBase) {
    const freshness = ctx.cache.getMarketFreshness(ctx.player.dockedAtBase, staleTtlMs);
    const recentlyCached = freshness.fetchedAt > 0 && (Date.now() - freshness.fetchedAt) < 30_000;
    if (recentlyCached) {
      // findAndDock already scanned this station moments ago — count it
      scanned++;
      yield `current station freshly cached (${Math.round((Date.now() - freshness.fetchedAt) / 1000)}s ago)`;
    } else if (!freshness.fresh) {
      try {
        const market = await fleetViewMarket(ctx, ctx.player.dockedAtBase);
        if (market.length > 0) {
          yield `scanned ${market.length} orders at current station`;
          scanned++;
        } else {
          yield "no market data at this station";
        }
      } catch (err) {
        yield `market scan failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      yield `current station data still fresh (${Math.round((Date.now() - freshness.fetchedAt) / 60_000)}min old)`;
    }
  }

  if (ctx.shouldStop) return scanned;

  // Find and scan other stations in this system
  try {
    const system = await fleetGetSystem(ctx);
    const otherBases = system.pois.filter(
      (p) => p.hasBase && p.baseId && p.baseId !== ctx.player.dockedAtBase
    );
    if (otherBases.length > 0) {
      yield `${otherBases.length} other station(s) in system`;
    }
    for (const poi of otherBases) {
      if (ctx.shouldStop) break;
      const freshness = ctx.cache.getMarketFreshness(poi.baseId!, staleTtlMs);
      if (freshness.fresh) {
        yield `${poi.baseName ?? poi.name}: fresh (${Math.round((Date.now() - freshness.fetchedAt) / 60_000)}min), skipping`;
        continue;
      }
      try {
        yield `scanning ${poi.baseName ?? poi.name}`;
        await navigateAndDock(ctx, poi.baseId!);
        const market = await fleetViewMarket(ctx, poi.baseId!);
        if (market.length > 0) {
          yield `scanned ${market.length} orders at ${poi.baseName ?? poi.name}`;
          scanned++;
        }
      } catch (err) {
        yield `failed to scan ${poi.baseName ?? poi.name}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  } catch (err) {
    yield `getSystem failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return scanned;
}

export async function* scout(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const scanMarket = getParam(ctx, "scanMarket", true);
  const checkFaction = getParam(ctx, "checkFaction", true);
  const staleTtlMs = getParam(ctx, "staleTtlMs", 1_800_000); // 30 min

  // Build system visit list — params override, otherwise use default trade hubs
  const targetSystemsParam = getParam<string[]>(ctx, "targetSystems", []);
  const singleTarget = getParam(ctx, "targetSystem", "");
  let systemsToVisit: string[];
  if (targetSystemsParam.length > 0) {
    systemsToVisit = targetSystemsParam;
  } else if (singleTarget) {
    // Single target given — but always include trade hubs for a full patrol
    systemsToVisit = [singleTarget];
    for (const hub of DEFAULT_TRADE_HUBS) {
      if (!systemsToVisit.includes(hub)) systemsToVisit.push(hub);
    }
  } else {
    // No params at all — use home system + default hubs
    const home = ctx.fleetConfig.homeSystem;
    systemsToVisit = home ? [home] : [];
    for (const hub of DEFAULT_TRADE_HUBS) {
      if (!systemsToVisit.includes(hub)) systemsToVisit.push(hub);
    }
  }

  if (systemsToVisit.length === 0) {
    yield "no target systems configured";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "scout" });
    return;
  }

  let checkedFaction = false;
  let loopCount = 0;

  yield `market patrol: ${systemsToVisit.join(" → ")} (${systemsToVisit.length} systems, stale=${Math.round(staleTtlMs / 60_000)}min)`;

  // Continuous patrol loop
  while (!ctx.shouldStop) {
    loopCount++;
    let totalScanned = 0;
    let systemsVisited = 0;

    for (const targetSystem of systemsToVisit) {
      if (ctx.shouldStop) return;

      // Check if this system has any stale data worth refreshing
      // On first loop (loopCount === 1), always visit everything
      if (loopCount > 1) {
        const systemFreshness = getSystemFreshness(ctx, targetSystem, staleTtlMs);
        if (systemFreshness === "fresh") {
          continue; // All stations in this system have fresh data
        }
      }

      // Navigate to system
      if (ctx.player.currentSystem === targetSystem) {
        yield `[${loopCount}] already in ${targetSystem}`;
      } else {
        // Fuel gate: ensure enough fuel to reach target AND return to a station
        const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);
        const currentSys = ctx.player.currentSystem ?? "";
        const distToTarget = ctx.galaxy.getDistance(currentSys, targetSystem);
        if (distToTarget > 0) {
          // Reserve fuel for return to home system (or at least same distance back)
          const homeSystem = ctx.fleetConfig.homeSystem ?? currentSys;
          const distHome = ctx.galaxy.getDistance(targetSystem, homeSystem);
          const returnDist = Math.max(1, distHome > 0 ? distHome : distToTarget);
          const fuelNeeded = (distToTarget + returnDist) * fuelPerJump + 3;
          if (ctx.ship.fuel < fuelNeeded) {
            // If fuel is too low for ANY remaining system, end patrol early
            if (ctx.ship.fuel < fuelPerJump * 3) {
              yield `fuel too low to continue patrol (${ctx.ship.fuel} fuel) — ending loop`;
              break;
            }
            yield `[${loopCount}] skipping ${targetSystem}: insufficient fuel (need ~${Math.ceil(fuelNeeded)}, have ${ctx.ship.fuel})`;
            continue;
          }
        }

        yield `[${loopCount}] traveling to ${targetSystem}`;
        try {
          await navigateTo(ctx, targetSystem);
        } catch (err) {
          yield `navigation to ${targetSystem} failed: ${err instanceof Error ? err.message : String(err)}`;
          continue; // Try next system
        }
      }

      if (ctx.shouldStop) return;

      // Ensure system detail
      await ensureSystemDetail(ctx);

      // Dock at first station
      try {
        await findAndDock(ctx);
      } catch (err) {
        yield `dock failed in ${targetSystem}: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }

      if (!ctx.player.dockedAtBase) {
        yield `no station in ${targetSystem}`;
        continue;
      }

      if (ctx.shouldStop) return;

      // Scan all stations in this system
      if (scanMarket) {
        const scanned = yield* scanSystemStations(ctx, staleTtlMs);
        totalScanned += scanned;
      }

      systemsVisited++;

      if (ctx.shouldStop) return;

      // Check faction info (only first stop, first loop)
      if (checkFaction && !checkedFaction && ctx.player.factionId) {
        checkedFaction = true;
        try {
          const info = await ctx.api.factionInfo();
          yield `faction: ${String(info.name ?? "Unknown")}`;
        } catch { /* non-critical */ }

        try {
          const storage = await fleetViewFactionStorage(ctx);
          yield `faction storage: ${storage.items.length} items, ${storage.credits} credits`;
          if ((storage.items.length > 0 || storage.credits > 0) && ctx.player.dockedAtBase) {
            if (!ctx.fleetConfig.factionStorageStation) {
              ctx.fleetConfig.factionStorageStation = ctx.player.dockedAtBase;
              ctx.fleetConfig.homeBase = ctx.player.dockedAtBase;
              ctx.fleetConfig.homeSystem = targetSystem;
              yield `faction storage confirmed at ${ctx.player.dockedAtBase}`;
            }
          }
        } catch { /* non-critical */ }
      }

      // Service ship between systems
      await refuelIfNeeded(ctx);
      await repairIfNeeded(ctx);
    }

    yield `patrol loop ${loopCount} complete: ${systemsVisited} system(s) visited, ${totalScanned} station(s) scanned`;

    if (ctx.shouldStop) return;

    // Wait before starting next patrol loop
    // Shorter wait if we barely scanned anything (data is mostly fresh)
    const waitMs = totalScanned <= 1 ? 300_000 : 60_000; // 5min if fresh, 1min if lots scanned
    yield `next patrol in ${Math.round(waitMs / 60_000)}min`;
    const interrupted = await interruptibleSleep(ctx, waitMs);
    if (interrupted) return;
  }
}

/**
 * Check if all known stations in a system have fresh market data.
 * Returns "fresh" if all are fresh, "stale" if any need refresh, "unknown" if no data.
 */
function getSystemFreshness(
  ctx: BotContext,
  systemId: string,
  staleTtlMs: number,
): "fresh" | "stale" | "unknown" {
  // Look up system in galaxy to find station IDs
  const system = ctx.galaxy.getSystem(systemId);
  if (!system) return "unknown";

  const stationPois = system.pois.filter(p => p.hasBase && p.baseId);
  if (stationPois.length === 0) return "unknown";

  let hasAnyData = false;
  for (const poi of stationPois) {
    const freshness = ctx.cache.getMarketFreshness(poi.baseId!, staleTtlMs);
    if (freshness.fetchedAt > 0) hasAnyData = true;
    if (!freshness.fresh) return "stale";
  }

  return hasAnyData ? "fresh" : "unknown";
}
