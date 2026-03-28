/**
 * Explorer routine - charts systems, catalogs POIs, discovers resources,
 * and refreshes stale market data across the galaxy.
 *
 * Intelligence:
 *   - Scans ALL known systems for stale market data, not just neighbors
 *   - Plans efficient multi-hop routes (nearest-neighbor TSP)
 *   - Calls analyze_market for demand/pricing insights at each station
 *   - Submits trade intel + system intel to faction
 *   - Falls back to frontier expansion when all data is fresh
 *
 * Params:
 *   targetSystems: string[]   - System IDs to explore (auto-discovered if empty)
 *   submitIntel?: boolean     - Submit findings to faction
 *   useCloaking?: boolean     - Enable stealth mode
 *   explorerIndex?: number    - For deconfliction when multiple explorers
 *   maxRouteJumps?: number    - Max total jumps per exploration cycle (default: 12)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateTo,
  dockAtCurrent,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  getParam,
  equipModulesForRoutine,
  fleetGetSystem,
  fleetAnalyzeMarket,
  fleetGetPoi,
} from "./helpers";
import { isSystemExplored, KNOWN_RESOURCE_LOCATIONS } from "../data/resource-locations";

/** Threshold in ms: stations with data older than this get priority */
const STALE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
/** Stations never scanned are even higher priority */
const UNSCANNED_PRIORITY = 50;
const STALE_PRIORITY = 30;
const UNEXPLORED_PRIORITY = 20;

/** Valuable ore types that get extra priority when found in POIs */
const RARE_ORES = new Set([
  "ore_exotic", "ore_platinum", "ore_palladium", "ore_iridium", "ore_gold",
  "ore_titanium", "ore_crystal", "nebula_gas", "plasma_gas", "krypton_gas",
]);
/** Bonus for systems with resource POIs (belt/ice/gas) */
const RESOURCE_POI_BONUS = 10;
/** Extra bonus for rare ore presence */
const RARE_ORE_BONUS = 15;
/** Penalty per jump distance from home (makes closer systems score higher) */
const DISTANCE_FROM_HOME_PENALTY = 3;

interface ExplorationTarget {
  systemId: string;
  score: number;
  reason: string;
  distanceFromBot: number;
}

export async function* explorer(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const submitIntel = getParam(ctx, "submitIntel", false);
  const useCloaking = getParam(ctx, "useCloaking", false);
  const explorerIndex = getParam(ctx, "explorerIndex", 0);
  const initialTargets = getParam<string[]>(ctx, "targetSystems", []);
  const equipModules = getParam<string[]>(ctx, "equipModules", []);
  const maxRouteJumps = getParam(ctx, "maxRouteJumps", 12);
  const homeSystem = getParam<string>(ctx, "homeSystem", "");

  // ── Equip modules (survey scanner) if commanded by scoring brain ──
  yield* equipModulesForRoutine(ctx, equipModules);

  // Enable cloaking if requested
  if (useCloaking) {
    try {
      await ctx.api.cloak(true);
      yield "cloaking enabled";
    } catch (err) {
      yield `cloaking failed (${err instanceof Error ? err.message : String(err)}), continuing uncloaked`;
    }
  }

  // ── Continuous exploration loop ──
  while (!ctx.shouldStop) {
    let targetSystems = [...initialTargets];

    if (targetSystems.length === 0) {
      yield "planning exploration route...";
      targetSystems = yield* planRoute(ctx, explorerIndex, maxRouteJumps, homeSystem);

      if (targetSystems.length === 0) {
        yield "all systems freshly scanned — waiting for data to go stale";
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "explorer" });
        return;
      }
    }

    // ── Visit each system ──
    for (const systemId of targetSystems) {
      if (ctx.shouldStop) break;

      // Safety check
      const issue = safetyCheck(ctx);
      if (issue) {
        yield `emergency: ${issue}`;
        const handled = await handleEmergency(ctx);
        if (!handled) return;
      }

      // Refuel before jumping if fuel is getting low
      if (ctx.player.dockedAtBase) {
        await refuelIfNeeded(ctx);
      }

      // Navigate to system — with round-trip fuel check
      if (systemId !== ctx.player.currentSystem) {
        const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);
        const dist = ctx.galaxy.getDistance(ctx.player.currentSystem ?? "", systemId);
        if (dist > 0) {
          const homeSystem = ctx.fleetConfig.homeSystem ?? ctx.player.currentSystem ?? "";
          const distHome = ctx.galaxy.getDistance(systemId, homeSystem);
          const returnDist = Math.max(1, distHome > 0 ? distHome : dist);
          const fuelNeeded = (dist + returnDist) * fuelPerJump + 3;
          if (ctx.ship.fuel < fuelNeeded) {
            if (ctx.ship.fuel < fuelPerJump * 3) {
              yield `fuel too low to continue exploring (${ctx.ship.fuel} fuel) — ending`;
              break;
            }
            yield `skipping ${systemId}: insufficient fuel for round trip`;
            continue;
          }
        }
        yield `jumping to ${systemId}`;
        try {
          await navigateTo(ctx, systemId);
        } catch (err) {
          yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
          continue;
        }
      }

      if (ctx.shouldStop) break;

      // Explore this system
      yield* exploreSystem(ctx, systemId, submitIntel);

      // Refuel if docked
      if (ctx.player.dockedAtBase) {
        await refuelIfNeeded(ctx);
        await repairIfNeeded(ctx);
      }
    }

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "explorer" });

    // If initial targets were specified, don't loop
    if (initialTargets.length > 0) break;
  }

  // Disable cloaking
  if (useCloaking) {
    try { await ctx.api.cloak(false); } catch (err) { console.warn(`[${ctx.botId}] uncloak failed: ${err instanceof Error ? err.message : err}`); }
  }

  yield "exploration complete";
}

// ── Route Planning ──

/** Plan an efficient route through stale/unexplored systems */
async function* planRoute(
  ctx: BotContext,
  explorerIndex: number,
  maxRouteJumps: number,
  homeSystem: string,
): AsyncGenerator<RoutineYield, string[], void> {
  const currentSystem = ctx.player.currentSystem;
  const effectiveHome = homeSystem || currentSystem;

  // ── Score ALL known systems, not just neighbors ──
  const allSystems = ctx.galaxy.getAllSystems();
  const targets: ExplorationTarget[] = [];

  for (const sys of allSystems) {
    let score = 0;
    let reason = "";

    // Check stations for stale/unscanned market data
    for (const poi of sys.pois) {
      if (poi.hasBase && poi.baseId) {
        const freshness = ctx.cache.getMarketFreshness(poi.baseId);
        if (freshness.fetchedAt === 0) {
          score += UNSCANNED_PRIORITY;
          reason = "unscanned station";
        } else if (!freshness.fresh || freshness.ageMs > STALE_THRESHOLD_MS) {
          const ageMin = Math.round(freshness.ageMs / 60_000);
          score += STALE_PRIORITY;
          reason = `stale market (${ageMin}m)`;
        }
      }
    }

    // System with no POI data = unexplored (unless we already know it from resource-locations.ts)
    const alreadyExplored = isSystemExplored(sys.id);
    if (sys.pois.length === 0 && !alreadyExplored) {
      score += UNEXPLORED_PRIORITY;
      reason = reason || "unexplored";
    }

    // Resource POI bonus: systems with belts/ice/gas are more valuable
    // Skip bonus for systems already in KNOWN_RESOURCE_LOCATIONS (ore data is known)
    let hasResourcePois = false;
    const hasKnownResources = sys.id in KNOWN_RESOURCE_LOCATIONS;
    for (const poi of sys.pois) {
      const t = poi.type;
      if (t === "asteroid_belt" || t === "asteroid" || t === "ice_field" || t === "gas_cloud" || t === "nebula") {
        hasResourcePois = true;
        // Only award resource bonus if we DON'T already have this data
        // AND the POI hasn't been scanned recently (2hr freshness)
        const scannedAt = ctx.galaxy.getPoiScannedAt(poi.id);
        const scanAge = scannedAt > 0 ? Date.now() - scannedAt : Infinity;
        if (!hasKnownResources && scanAge > 7_200_000) { // >2hr since last scan
          score += RESOURCE_POI_BONUS;
          // Check for rare/valuable ores in known resources
          if (poi.resources) {
            for (const res of poi.resources) {
              if (RARE_ORES.has(res.resourceId) && res.remaining > 0) {
                score += RARE_ORE_BONUS;
                reason = reason || `rare: ${res.resourceId}`;
                break;
              }
            }
          }
        }
      }
    }

    if (score === 0) continue; // Fresh data, skip

    // Calculate distance from current position
    const distance = sys.id === currentSystem ? 0 : ctx.galaxy.getDistance(currentSystem, sys.id);
    if (distance < 0) continue; // Unreachable

    // Distance-to-home penalty: prefer systems closer to home base
    // This ensures miners won't need to travel far to reach discovered belts
    const distFromHome = sys.id === effectiveHome ? 0 : ctx.galaxy.getDistance(effectiveHome, sys.id);
    if (distFromHome > 0) {
      score -= distFromHome * DISTANCE_FROM_HOME_PENALTY;
    }

    // Bonus for nearby resource systems: if system has resource POIs AND is close to home
    // this is the most valuable data for the fleet (less fuel for miners)
    if (hasResourcePois && distFromHome >= 0 && distFromHome <= 3) {
      score += 15; // Strong bonus for close resource systems
    }

    targets.push({ systemId: sys.id, score, reason, distanceFromBot: distance });
  }

  // ── Also check immediate neighbors that might not be in galaxy graph yet ──
  try {
    const currentSystemInfo = await fleetGetSystem(ctx);
    for (const connId of (currentSystemInfo.connections ?? [])) {
      if (targets.some(t => t.systemId === connId)) continue;
      const sys = ctx.galaxy.getSystem(connId);
      if (!sys) {
        targets.push({
          systemId: connId,
          score: UNEXPLORED_PRIORITY + 5, // Slightly higher: easy to reach + unknown
          reason: "unknown neighbor",
          distanceFromBot: 1,
        });
      }
    }
  } catch (err) { console.warn(`[${ctx.botId}] neighbor discovery failed: ${err instanceof Error ? err.message : err}`); }

  if (targets.length === 0) return [];

  // Log findings
  const staleCount = targets.filter(t => t.reason.includes("stale") || t.reason.includes("unscanned")).length;
  const unexploredCount = targets.filter(t => t.reason.includes("unexplored") || t.reason.includes("unknown")).length;
  if (staleCount > 0) yield `${staleCount} station(s) need market refresh`;
  if (unexploredCount > 0) yield `${unexploredCount} unexplored system(s)`;

  // ── Build efficient route using nearest-neighbor heuristic ──
  // Weight: score / (distance + 1) — prefer high-value nearby targets
  const route = buildEfficientRoute(ctx, targets, maxRouteJumps);

  // Deconflict multiple explorers: split route segments
  if (explorerIndex > 0) {
    const totalExplorers = explorerIndex + 1;
    const chunkSize = Math.max(1, Math.ceil(route.length / totalExplorers));
    const start = explorerIndex * chunkSize;
    const chunk = route.slice(start, start + chunkSize);
    if (chunk.length > 0) {
      yield `exploring ${chunk.length} systems (explorer ${explorerIndex + 1}/${totalExplorers})`;
      return chunk;
    }
  }

  yield `route: ${route.length} systems, ~${estimateRouteJumps(ctx, route)} jumps`;
  return route;
}

/** Build a route using nearest-neighbor heuristic weighted by target value */
function buildEfficientRoute(
  ctx: BotContext,
  targets: ExplorationTarget[],
  maxJumps: number,
): string[] {
  const route: string[] = [];
  const visited = new Set<string>();
  let currentPos = ctx.player.currentSystem;
  let totalJumps = 0;

  // Sort by efficiency: score / (distance + 1)
  const remaining = [...targets];

  while (remaining.length > 0 && totalJumps < maxJumps) {
    // Find best next target: highest score per jump
    let bestIdx = -1;
    let bestValue = -1;

    for (let i = 0; i < remaining.length; i++) {
      const t = remaining[i];
      if (visited.has(t.systemId)) continue;
      const dist = currentPos === t.systemId ? 0 : ctx.galaxy.getDistance(currentPos, t.systemId);
      if (dist < 0 || dist > maxJumps - totalJumps) continue; // Can't reach within budget
      const value = t.score / (dist + 1);
      if (value > bestValue) {
        bestValue = value;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const next = remaining[bestIdx];
    const dist = currentPos === next.systemId ? 0 : ctx.galaxy.getDistance(currentPos, next.systemId);
    totalJumps += Math.max(0, dist);
    route.push(next.systemId);
    visited.add(next.systemId);
    currentPos = next.systemId;
    remaining.splice(bestIdx, 1);
  }

  return route;
}

/** Estimate total jumps for a route */
function estimateRouteJumps(ctx: BotContext, route: string[]): number {
  let jumps = 0;
  let pos = ctx.player.currentSystem;
  for (const sysId of route) {
    const d = ctx.galaxy.getDistance(pos, sysId);
    if (d > 0) jumps += d;
    pos = sysId;
  }
  return jumps;
}

// ── System Exploration ──

/** Explore a single system: visit POIs, dock at stations, scan market, submit intel */
async function* exploreSystem(
  ctx: BotContext,
  systemId: string,
  submitIntel: boolean,
): AsyncGenerator<RoutineYield, void, void> {
  yield `surveying ${systemId}`;

  let systemInfo;
  try {
    systemInfo = await fleetGetSystem(ctx);
    yield `found ${systemInfo.pois.length} POIs in ${systemInfo.name}`;
  } catch (err) {
    yield `survey error: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }

  // Visit POIs — only resource POIs (belts, ice, gas) and stations. Skip planets/other.
  const VALUABLE_POI_TYPES = new Set([
    "asteroid_belt", "asteroid", "ice_field", "gas_cloud", "nebula",
  ]);
  const pois = [...systemInfo.pois]
    .filter(p => p.hasBase || VALUABLE_POI_TYPES.has(p.type))
    .sort((a, b) => {
      // Bases with stale/no market data come first
      if (a.hasBase && !b.hasBase) return -1;
      if (!a.hasBase && b.hasBase) return 1;
      if (a.hasBase && b.hasBase && a.baseId && b.baseId) {
        const freshA = ctx.cache.getMarketFreshness(a.baseId);
        const freshB = ctx.cache.getMarketFreshness(b.baseId);
        return freshA.fetchedAt - freshB.fetchedAt; // Oldest first
      }
      // Resource POIs before other types
      const aRes = VALUABLE_POI_TYPES.has(a.type) ? 1 : 0;
      const bRes = VALUABLE_POI_TYPES.has(b.type) ? 1 : 0;
      return bRes - aRes;
    });

  const skipped = systemInfo.pois.length - pois.length;
  if (skipped > 0) yield `skipping ${skipped} non-resource POI(s) (planets, etc.)`;

  const POI_SCAN_FRESHNESS_MS = 7_200_000; // 2 hours — skip POIs scanned within this window
  let poiDataUpdated = false;
  for (const poi of pois) {
    if (ctx.shouldStop) break;

    // Skip resource POIs that were recently scanned (2hr freshness)
    const isResourcePoi = VALUABLE_POI_TYPES.has(poi.type);
    if (isResourcePoi && !poi.hasBase) {
      const lastScan = ctx.galaxy.getPoiScannedAt(poi.id);
      if (lastScan > 0 && (Date.now() - lastScan) < POI_SCAN_FRESHNESS_MS) {
        yield `skipping ${poi.name} (scanned ${Math.round((Date.now() - lastScan) / 60_000)}m ago)`;
        continue;
      }
    }

    yield `scanning ${poi.name}`;
    try {
      await ctx.api.travel(poi.id);
      await ctx.refreshState();

      // Get detailed POI info and save resources (fleet-deduped)
      const detail = await fleetGetPoi(ctx, poi.id);
      if (detail && detail.resources.length > 0) {
        // fleetGetPoi already calls updatePoiResources
        poiDataUpdated = true;

        const isBelt = poi.type === "asteroid_belt" || poi.type === "gas_cloud"
          || poi.type === "ice_field" || poi.type === "asteroid" || poi.type === "nebula";
        if (isBelt) {
          const resourceList = detail.resources
            .filter((r) => r.remaining > 0)
            .sort((a, b) => b.remaining - a.remaining)
            .map((r) => `${r.resourceId}:${r.remaining}(${r.richness > 0 ? `rich:${r.richness}` : "depleted"})`)
            .join(", ");
          if (resourceList) {
            yield `${poi.name} resources: ${resourceList}`;
          } else {
            yield `${poi.name}: depleted`;
          }
        } else {
          yield `${poi.name}: ${poi.type}, ${detail.resources.length} resources`;
        }
      } else {
        yield `${poi.name}: ${poi.type}, no resources`;
      }

      // Dock at stations — dockAtCurrent auto-scans market + shipyard when cache is stale
      if (poi.hasBase) {
        try {
          await dockAtCurrent(ctx);
          // dockAtCurrent already calls viewMarket + browseShips + cacheMarketData

          if (poi.baseId) {
            // Report market status
            const prices = ctx.cache.getMarketPrices(poi.baseId);
            if (prices && prices.length > 0) {
              const buyCount = prices.filter(p => (p.buyPrice ?? 0) > 0).length;
              const sellCount = prices.filter(p => (p.sellPrice ?? 0) > 0).length;
              yield `${poi.baseName}: ${prices.length} items (${buyCount} buy, ${sellCount} sell)`;
            } else {
              yield `${poi.baseName}: docked`;
            }

            // Analyze market for demand/pricing insights (rate-limited mutation)
            try {
              await fleetAnalyzeMarket(ctx, poi.baseId);
              const cachedInsights = ctx.cache.getMarketInsights(poi.baseId);
              if (cachedInsights && cachedInsights.length > 0) {
                const topInsights = cachedInsights
                  .sort((a, b) => b.priority - a.priority)
                  .slice(0, 3);
                for (const insight of topInsights) {
                  yield `  insight [${insight.category}]: ${insight.message}`;
                }
              }
            } catch { /* insights non-critical */ }

            // Report shipyard if available
            const shipyard = ctx.cache.getShipyardData(poi.baseId);
            if (shipyard && shipyard.length > 0) {
              yield `${poi.baseName}: ${shipyard.length} ship(s) at shipyard`;
            }
          }

          await ctx.api.undock();
          await ctx.refreshState();
        } catch (err) {
          yield `could not dock at ${poi.baseName}: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    } catch (err) {
      yield `scan error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // Persist updated system (with POI resources)
  if (poiDataUpdated && systemInfo.id) {
    const updatedSystem = ctx.galaxy.getSystem(systemInfo.id);
    if (updatedSystem) {
      ctx.cache.setSystemDetail(systemInfo.id, updatedSystem);
    }
  }

  // Deep survey
  try {
    await ctx.api.surveySystem();
    yield `deep survey of ${systemInfo.name} complete`;
  } catch (err) {
    yield `survey unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Submit system intel to faction
  if (submitIntel && ctx.player.factionId) {
    try {
      await ctx.api.factionSubmitIntel([{
        system_id: systemInfo.id,
        name: systemInfo.name,
        empire: systemInfo.empire,
        police_level: systemInfo.policeLevel,
        pois: systemInfo.pois.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          has_base: p.hasBase,
          base_id: p.baseId,
          base_name: p.baseName,
        })),
        connections: systemInfo.connections,
      }]);
      yield "intel submitted to faction";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("facility") || msg.includes("intel")) {
        yield "intel not available (needs faction_intel facility)";
      } else {
        yield `intel submission failed: ${msg}`;
      }
    }
  }
}
