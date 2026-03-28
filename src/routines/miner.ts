/**
 * Miner routine - extracts ore from asteroid belts, sells/deposits at station.
 *
 * Loop: undock -> travel to belt -> mine until full -> return to station -> sell -> refuel -> repeat
 *
 * Params:
 *   targetBelt: string     - POI ID of asteroid belt (auto-discovered if empty)
 *   sellStation: string    - Base ID to sell at (auto-discovered if empty)
 *   targetOre?: string     - Preferred ore type (informational)
 *   depositToStorage?: boolean - Deposit instead of sell
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateTo,
  navigateToPoi,
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  disposeCargo,
  depositItem,
  sellItem,
  handleEmergency,
  safetyCheck,
  getParam,
  isProtectedItem,
  payFactionTax,
  ensureMinCredits,
  depositExcessCredits,
  equipModulesForRoutine,
  fleetGetSystem,
  fleetGetPoi,
} from "./helpers";

export async function* miner(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  let targetBelt = getParam(ctx, "targetBelt", "");
  let sellStation = getParam(ctx, "sellStation", "");
  const targetOre = getParam(ctx, "targetOre", "");
  // Crystal miners always deposit to faction storage (crystals are strategic, not for sale)
  const depositToStorage = ctx.settings.role === "crystal_miner" ? true : getParam(ctx, "depositToStorage", false);
  const equipModules = getParam<string[]>(ctx, "equipModules", []);
  const unequipModules = getParam<string[]>(ctx, "unequipModules", []);

  // ── Equip/unequip modules if commanded by scoring brain ──
  yield* equipModulesForRoutine(ctx, equipModules, unequipModules);

  // Crystal miners default to known crystal nebula locations if no target specified
  if (!targetBelt && ctx.settings.role === "crystal_miner") {
    const { KNOWN_RESOURCE_LOCATIONS } = await import("../config/constants");
    const crystalLoc = KNOWN_RESOURCE_LOCATIONS.find(loc =>
      loc.resources.some(r => r.resourceId === "energy_crystal" || r.resourceId === "phase_crystal")
    );
    if (crystalLoc) {
      // Ensure POI is registered in galaxy so navigateToPoi can resolve it
      const existingPoi = ctx.galaxy.getSystemForPoi(crystalLoc.poiId);
      if (!existingPoi) {
        ctx.galaxy.hydrateFromPersistedPois([{
          poiId: crystalLoc.poiId,
          systemId: crystalLoc.systemId,
          poi: {
            id: crystalLoc.poiId,
            name: crystalLoc.poiName,
            type: crystalLoc.poiType as any,
            hasBase: false, baseId: null, baseName: null,
            resources: crystalLoc.resources.map(r => ({ resourceId: r.resourceId, richness: r.richness, remaining: 9999 })),
          },
        }]);
      }
      targetBelt = crystalLoc.poiId;
      yield `crystal miner — targeting ${crystalLoc.poiName} in ${crystalLoc.systemId}`;
    }
  }

  // Auto-discover targets if not provided
  if (!targetBelt || !sellStation) {
    yield "discovering targets...";
    try {
      const system = await fleetGetSystem(ctx);
      // Find a mineable POI - filter by equipped modules
      if (!targetBelt) {
        const hasIceHarvester = ctx.ship.modules.some((m) =>
          m.moduleId.includes("ice_harvester") || m.name.toLowerCase().includes("ice harvester")
        );
        const hasGasHarvester = ctx.ship.modules.some((m) =>
          m.moduleId.includes("gas_harvester") || m.name.toLowerCase().includes("gas harvester")
        );
        const hasMiningLaser = ctx.ship.modules.some((m) =>
          m.moduleId.includes("mining_laser") || m.name.toLowerCase().includes("mining laser")
        );
        const mineablePois = system.pois.filter((p) =>
          !ctx.galaxy.isPoiDepleted(p.id) && (
            p.type === "asteroid_belt" || p.type === "asteroid"
            || (p.type === "ice_field" && hasIceHarvester)
            || (p.type === "gas_cloud" && hasGasHarvester)
            || (p.type === "nebula" && (hasGasHarvester || hasMiningLaser))
          )
        );
        // Crystal miners prefer nebulae (sort them first)
        if (ctx.settings.role === "crystal_miner") {
          mineablePois.sort((a, b) => (a.type === "nebula" ? -1 : 1) - (b.type === "nebula" ? -1 : 1));
        }
        const belt = mineablePois[0];
        if (belt) {
          targetBelt = belt.id;
          yield `found belt: ${belt.name}`;
        } else {
          // Log why no belt was found
          const beltLike = system.pois.filter((p) => p.name.toLowerCase().includes("belt") || p.name.toLowerCase().includes("asteroid"));
          if (beltLike.length > 0) {
            yield `no mineable belt in ${system.name ?? system.id} (belt-like POIs: ${beltLike.map(p => `${p.name}[type=${p.type}]`).join(", ")})`;
          }
        }
      }
      // Find a station to sell at in current system
      if (!sellStation) {
        const station = system.pois.find((p) => p.hasBase);
        if (station && station.baseId) {
          sellStation = station.baseId;
          yield `found station: ${station.baseName ?? station.name}`;
        }
      }
    } catch (err) {
      yield `discovery error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // If no belt found locally, search galaxy for nearest non-depleted belt and navigate there
  if (!targetBelt) {
    let allBelts = [
      ...ctx.galaxy.findPoisByType("asteroid_belt"),
      ...ctx.galaxy.findPoisByType("asteroid"),
      ...ctx.galaxy.findPoisByType("nebula"),
    ].filter(b => !ctx.galaxy.isPoiDepleted(b.poi.id));

    // Cold-start: galaxy cache has no POI data — scan connected systems to discover belts
    if (allBelts.length === 0) {
      yield `galaxy cache cold (${ctx.galaxy.systemCount} systems, ${ctx.galaxy.poiCount} POIs) — scanning connected systems...`;
      try {
        // Ensure map is loaded for connection graph
        if (ctx.galaxy.systemCount < 50) {
          const systems = await ctx.cache.getMap(ctx.api);
          for (const sys of systems) ctx.galaxy.updateSystem(sys);
        }
        // Get current system's connections and scan each for POI data
        const currentSysId = ctx.player.currentSystem;
        const currentSysData = currentSysId ? ctx.galaxy.getSystem(currentSysId) : null;
        const neighbors = currentSysData?.connections ?? [];
        // Check cached system details for neighbors (free — no API call)
        for (const neighborId of neighbors) {
          const cached = ctx.cache.getSystemDetail(neighborId);
          if (cached && cached.pois.length > 0) {
            ctx.galaxy.updateSystem(cached);
          }
        }
        allBelts = [
          ...ctx.galaxy.findPoisByType("asteroid_belt"),
          ...ctx.galaxy.findPoisByType("asteroid"),
          ...ctx.galaxy.findPoisByType("nebula"),
        ].filter(b => !ctx.galaxy.isPoiDepleted(b.poi.id));
        yield `neighbor scan: ${allBelts.length} belts found from cached data`;
      } catch (err) {
        yield `neighbor scan failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Select best belt from galaxy-wide data (Commander should handle exploration — don't travel blindly)
    if (!targetBelt && allBelts.length > 0) {
      // Sort by ROI: prefer belts with stations nearby (for selling) and short distance
      // crystal_miner role strongly prefers nebulae for energy/phase crystals
      const isCrystalMiner = ctx.settings.role === "crystal_miner";
      const botSystem = ctx.player.currentSystem;
      const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);

      if (botSystem) {
        // Filter out belts we can't reach with a round trip
        allBelts = allBelts.filter(belt => {
          if (belt.systemId === botSystem) return true; // Same system, no fuel needed
          const dist = ctx.galaxy.getDistance(botSystem, belt.systemId);
          if (dist < 0) return false; // Unknown route
          const beltSys = ctx.galaxy.getSystem(belt.systemId);
          const hasLocalStation = beltSys?.pois.some(p => p.hasBase) ?? false;
          const returnPenalty = hasLocalStation ? 0 : 2; // Extra jumps if no local station
          const roundTripFuel = (dist * 2 + returnPenalty) * fuelPerJump + 3; // +3 safety margin
          return ctx.ship.fuel >= roundTripFuel;
        });

        allBelts.sort((a, b) => {
          const distA = ctx.galaxy.getDistance(botSystem, a.systemId);
          const distB = ctx.galaxy.getDistance(botSystem, b.systemId);
          const da = a.systemId === botSystem ? 0 : (distA < 0 ? 99 : distA);
          const db = b.systemId === botSystem ? 0 : (distB < 0 ? 99 : distB);
          // Bonus: system has a station (can sell without extra travel)
          const sysA = ctx.galaxy.getSystem(a.systemId);
          const sysB = ctx.galaxy.getSystem(b.systemId);
          const hasStationA = sysA?.pois.some(p => p.hasBase) ? 0 : 2; // +2 jump penalty if no station
          const hasStationB = sysB?.pois.some(p => p.hasBase) ? 0 : 2;
          // Crystal miners get -10 distance bonus for nebulae (strongly prefer them)
          const nebulaA = isCrystalMiner && a.poi.type === "nebula" ? -10 : 0;
          const nebulaB = isCrystalMiner && b.poi.type === "nebula" ? -10 : 0;
          return (da + hasStationA + nebulaA) - (db + hasStationB + nebulaB);
        });
      }

      if (allBelts.length === 0) {
        yield `no reachable belts with current fuel (${ctx.ship.fuel} fuel, ~${fuelPerJump}/jump)`;
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "miner" });
        return;
      }

      const nearestBelt = allBelts[0];
      const currentSys = ctx.player.currentSystem ?? "unknown";
      yield `no mineable belt in ${currentSys} — traveling to ${nearestBelt.poi.name ?? nearestBelt.poi.id} in ${nearestBelt.systemId}`;
      try {
        await navigateToPoi(ctx, nearestBelt.poi.id);
        targetBelt = nearestBelt.poi.id;
        // Also find a station in the destination system
        if (!sellStation) {
          const destSystem = ctx.galaxy.getSystem(nearestBelt.systemId);
          const station = destSystem?.pois.find((p) => p.baseId);
          if (station?.baseId) sellStation = station.baseId;
        }
      } catch (err) {
        yield `failed to reach belt: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    } else if (!targetBelt) {
      yield `error: no mineable asteroid/ice/gas belt found in ${ctx.galaxy.systemCount} known systems (${ctx.galaxy.poiCount} POIs indexed, ${ctx.player.currentSystem ?? "unknown"})`;
      return;
    }
  }

  while (!ctx.shouldStop) {
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

    // ── Navigate to belt ──
    yield "traveling to belt";
    try {
      await navigateToPoi(ctx, targetBelt);
    } catch (err) {
      yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    if (ctx.shouldStop) return;

    // ── Scan POI resources and persist to cache (fleet-deduped) ──
    try {
      const poiDetail = await fleetGetPoi(ctx, targetBelt);
      if (poiDetail && poiDetail.resources.length > 0) {
        // fleetGetPoi already calls updatePoiResources
      }
    } catch (err) {
      // Non-fatal: continue mining even if POI scan fails
      const msg = err instanceof Error ? err.message : String(err);
      yield `poi scan failed (non-fatal): ${msg}`;
    }

    // ── Mine until full ──
    const cargoBeforeMining = ctx.ship.cargo.reduce((sum, c) => sum + c.quantity, 0);
    let beltDepleted = false;

    {
      let mineCount = 0;
      while (!ctx.shouldStop) {
        // Refresh before check every 5 mines to avoid stale cargo_full errors
        if (mineCount > 0 && mineCount % 5 === 0) {
          await ctx.refreshState();
        }
        if (!ctx.cargo.hasSpace(ctx.ship, 1)) break;

        yield `mining${targetOre ? ` ${targetOre}` : ""}`;
        try {
          const result = await ctx.api.mine();
          mineCount++;
          // Refresh on depletion
          if (result.quantity === 0 || result.remaining === 0) {
            await ctx.refreshState();
          }

          if (result.quantity === 0 || result.remaining === 0) {
            yield "belt depleted";
            beltDepleted = true;
            break;
          }

          yield typedYield(`mined ${result.quantity} ${result.resourceId}`, {
            type: "mine", botId: ctx.botId, resourceId: result.resourceId,
            quantity: result.quantity, remaining: result.remaining, poiId: targetBelt,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          yield `mining error: ${errMsg}`;
          // cargo_full is NOT belt depletion — just means we need to sell
          if (!errMsg.includes("cargo_full")) {
            beltDepleted = true;
          }
          break;
        }

        // Check fuel mid-mining (uses cached state — refreshed every 5 cycles)
        if (ctx.fuel.getLevel(ctx.ship) === "critical") {
          yield "fuel critical, returning to station";
          break;
        }
      }
      // Final refresh to get accurate cargo state before deposit
      if (mineCount > 0) await ctx.refreshState();
    }

    if (ctx.shouldStop) return;

    // If belt depleted, update POI resource data so Commander/scoring knows
    if (beltDepleted && targetBelt) {
      ctx.galaxy.markPoiDepleted(targetBelt);
      yield "marked belt as depleted in galaxy data";
    }

    // If belt depleted and we mined nothing, try to auto-select next belt
    // to avoid 60s Commander reassignment delay
    const cargoAfterMining = ctx.ship.cargo.reduce((sum, c) => sum + c.quantity, 0);
    if (beltDepleted && cargoAfterMining <= cargoBeforeMining) {
      // Sell/deposit leftover cargo first
      const hasNonFuelCargo = ctx.ship.cargo.some(
        (c) => c.itemId !== "fuel_cell" && c.quantity > 0,
      );
      if (hasNonFuelCargo) {
        try {
          if (!ctx.player.dockedAtBase) await findAndDock(ctx);
          if (ctx.player.dockedAtBase) {
            const result = await disposeCargo(ctx);
            if (result.totalEarned > 0) {
              yield `sold leftover cargo for ${result.totalEarned}cr`;
            } else if (result.items.length > 0) {
              yield `deposited ${result.items.length} item(s) to storage`;
            }
            await refuelIfNeeded(ctx);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${ctx.botId}] leftover cargo disposal failed: ${msg}`);
        }
      }

      // Auto-select next non-depleted belt instead of yielding cycle_complete
      const nextBelts = [
        ...ctx.galaxy.findPoisByType("asteroid_belt"),
        ...ctx.galaxy.findPoisByType("ice_field"),
        ...ctx.galaxy.findPoisByType("gas_cloud"),
      ].filter(b => b.poi.id !== targetBelt && !ctx.galaxy.isPoiDepleted(b.poi.id));

      if (nextBelts.length > 0) {
        // Pick nearest non-depleted belt
        const ranked = nextBelts
          .map(b => ({ ...b, dist: ctx.galaxy.getDistance(ctx.player.currentSystem, b.systemId) }))
          .filter(b => b.dist >= 0)
          .sort((a, b) => a.dist - b.dist);
        if (ranked.length > 0) {
          targetBelt = ranked[0].poi.id;
          yield `belt depleted, auto-switching to ${ranked[0].poi.name} (${ranked[0].dist} jumps)`;
          continue; // Re-enter mining loop with new belt
        }
      }

      // No belts available — fall back to cycle_complete
      yield "belt empty, no alternatives — requesting reassignment";
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "miner" });
      return;
    }

    // ── Return to station ──
    // Determine disposal mode first (affects station choice)
    // When depositToStorage is true, always use faction storage (supply chain)
    const mode = depositToStorage
      ? "faction_deposit"
      : ctx.settings.storageMode;

    // Pick the right station: faction storage station > sell station > auto-find
    const factionStation = ctx.fleetConfig.factionStorageStation;
    const targetStation = (mode === "faction_deposit" && factionStation)
      ? factionStation
      : sellStation;

    yield "returning to station";
    try {
      if (targetStation) {
        await navigateAndDock(ctx, targetStation);
      } else {
        await findAndDock(ctx);
      }
    } catch (err) {
      yield `dock failed: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }

    // Verify we actually docked (critical — deposit/sell fails without docking)
    if (!ctx.player.dockedAtBase) {
      yield "error: could not dock at any station";
      return;
    }

    if (ctx.shouldStop) return;
    if (mode === "deposit" || mode === "faction_deposit") {
      yield `depositing cargo (${mode === "faction_deposit" ? "faction" : "personal"} storage)`;
      let depositFailed = false;
      const cargoSnapshot = [...ctx.ship.cargo]; // Snapshot before depositing
      for (const item of cargoSnapshot) {
        if (ctx.shouldStop) return;
        if (isProtectedItem(item.itemId)) continue;
        try {
          if (mode === "faction_deposit") {
            await ctx.api.factionDepositItems(item.itemId, item.quantity);
            ctx.cache.invalidateFactionStorage();
          } else {
            await depositItem(ctx, item.itemId);
          }
          yield typedYield(`deposited ${item.quantity} ${item.itemId}`, {
            type: "deposit", botId: ctx.botId, itemId: item.itemId,
            quantity: item.quantity, target: mode === "faction_deposit" ? "faction" : "station",
            stationId: ctx.player.dockedAtBase ?? "",
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          yield `deposit failed for ${item.itemId}: ${msg}`;
          depositFailed = true;

          // Storage cap exceeded (100k per ore type) — deposit to personal storage first (quiet), sell as fallback
          if (msg.includes("cap") || msg.includes("full") || msg.includes("limit") || msg.includes("exceed")) {
            try {
              await ctx.api.depositItems(item.itemId, item.quantity);
              await ctx.refreshState();
              yield `${item.itemId} at faction cap — stashed in station storage`;
              continue; // Skip to next item, don't error
            } catch { /* station storage failed */ }
            try {
              const sold = await sellItem(ctx, item.itemId);
              if (sold) {
                yield `sold ${sold.quantity} ${item.itemId} @ ${sold.priceEach}cr (capped)`;
              } else {
                yield `${item.itemId} capped — no storage or buyers, skipping`;
              }
            } catch (sellErr) {
              yield `sell failed for ${item.itemId}: ${sellErr instanceof Error ? sellErr.message : String(sellErr)}`;
              // Last resort: deposit to personal station storage
              try {
                await depositItem(ctx, item.itemId);
                yield `deposited ${item.quantity} ${item.itemId} to station storage`;
              } catch {
                yield `station deposit also failed for ${item.itemId}`;
              }
            }
            continue; // Continue depositing other ore types
          }

          // If error says "no_faction_storage", this station doesn't have the lockbox.
          // Try to find the right station via galaxy or API search.
          if (msg.includes("no_faction_storage") && !ctx.fleetConfig.factionStorageStation) {
            // Check galaxy first
            const solSystem = ctx.galaxy.getSystemByName("Sol") ?? ctx.galaxy.getSystem("sol");
            if (solSystem) {
              const solStation = solSystem.pois.find((p) => p.hasBase && p.baseId);
              if (solStation?.baseId) {
                yield `lockbox not here — found Sol station: ${solStation.baseId}`;
                ctx.fleetConfig.factionStorageStation = solStation.baseId;
                ctx.fleetConfig.homeBase = solStation.baseId;
                ctx.fleetConfig.homeSystem = solSystem.id;
              }
            } else {
              // Galaxy doesn't have Sol — search via API
              try {
                const results = await ctx.api.searchSystems("sol");
                const sol = results.find((s) => String(s.name ?? "").toLowerCase() === "sol");
                if (sol) {
                  const pois = (sol.pois ?? []) as Array<Record<string, unknown>>;
                  const station = pois.find((p) => Boolean(p.has_base ?? p.hasBase));
                  if (station) {
                    const baseId = String(station.base_id ?? station.baseId ?? "");
                    const sysId = String(sol.id ?? sol.system_id ?? "");
                    if (baseId) {
                      yield `lockbox not here — found Sol station via API: ${baseId}`;
                      ctx.fleetConfig.factionStorageStation = baseId;
                      ctx.fleetConfig.homeBase = baseId;
                      ctx.fleetConfig.homeSystem = sysId;
                    }
                  }
                }
              } catch (err) {
                yield `API search failed: ${err instanceof Error ? err.message : String(err)}`;
              }
            }
          }
          break;
        }
      }
      // Single refresh after all deposits (saves N-1 refreshState calls)
      await ctx.refreshState();
      // Fallback: sell remaining cargo if deposit failed
      if (depositFailed && ctx.ship.cargo.length > 0) {
        yield "deposit failed, selling remaining cargo instead";
        let sellResult = await disposeCargo(ctx);
        for (const s of sellResult.items) {
          yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
        }

        // If sell earned nothing AND cargo still has non-protected items, try home/faction station
        const remainingCargo = ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId));
        if (sellResult.totalEarned === 0 && remainingCargo.length > 0) {
          // Prefer faction storage station (may have just been discovered), then home base
          const targetBase = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
          if (targetBase && ctx.player.dockedAtBase !== targetBase) {
            yield `no demand here, traveling to ${ctx.fleetConfig.factionStorageStation ? "faction storage" : "home base"}`;
            try {
              await navigateAndDock(ctx, targetBase);
              // Try faction deposit first if in faction mode
              if (mode === "faction_deposit") {
                for (const item of [...ctx.ship.cargo]) {
                  if (isProtectedItem(item.itemId)) continue;
                  try {
                    await ctx.api.factionDepositItems(item.itemId, item.quantity);
                    ctx.cache.invalidateFactionStorage();
                    yield `deposited ${item.quantity} ${item.itemId} to faction storage`;
                  } catch (err) {
                    const retryMsg = err instanceof Error ? err.message : String(err);
                    yield `faction deposit retry failed: ${retryMsg}`;
                    // Storage cap — skip this item, continue with others
                    if (retryMsg.includes("cap") || retryMsg.includes("full") || retryMsg.includes("limit") || retryMsg.includes("exceed")) {
                      continue;
                    }
                    break;
                  }
                }
                await ctx.refreshState();
              }
              // Sell anything remaining
              if (ctx.ship.cargo.filter((c) => !isProtectedItem(c.itemId)).length > 0) {
                sellResult = await disposeCargo(ctx);
                for (const s of sellResult.items) {
                  yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
                }
                yield `fallback earned: ${sellResult.totalEarned} credits`;
              }
            } catch (err) {
              yield `fallback navigation failed: ${err instanceof Error ? err.message : String(err)}`;
            }
          } else {
            yield "fallback earned: 0 credits (no demand, no home base configured)";
          }
        } else {
          yield `fallback earned: ${sellResult.totalEarned} credits`;
        }
      }
    } else {
      yield "selling cargo";
      const sellResult = await disposeCargo(ctx);
      for (const s of sellResult.items) {
        yield `sold ${s.quantity} ${s.itemId} @ ${s.priceEach}cr = ${s.total}cr`;
      }
      yield `total earned: ${sellResult.totalEarned} credits`;
      // Pay faction tax on sell earnings
      if (sellResult.totalEarned > 0) {
        const tax = await payFactionTax(ctx, sellResult.totalEarned);
        if (tax.message) yield tax.message;
      }
    }

    // ── Ensure minimum credits ──
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    // ── Service ship ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "miner" });
  }
}
