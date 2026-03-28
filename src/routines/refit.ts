/**
 * Refit routine - one-shot: optimize module loadout for bot's role.
 *
 * Docks at home station, checks current modules vs optimal for role,
 * upgrades to higher tiers from faction storage or local market.
 *
 * Params:
 *   role: string            - Bot's primary role (miner, trader, etc.)
 *   homeBase: string        - Station to dock at (has faction storage + market)
 *   maxSpendPct: number     - Max fraction of credits to spend on modules (default: 0.3)
 *   equipModules: string[]  - Module patterns to equip (override role defaults)
 *   unequipModules: string[] - Module IDs to remove
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
  getParam,
  withdrawFromFaction,
  canFitModule,
  fleetViewFactionStorage,
} from "./helpers";
import { getModulesForRole } from "../commander/roles";

/** Extract tier number from a module ID (e.g., mining_laser_2 -> 2) */
function getModuleTier(moduleId: string): number {
  const match = moduleId.match(/_(\d+)$/);
  return match ? parseInt(match[1]) : 1;
}

/** Strip tier suffix to get the base pattern (e.g., mining_laser_2 -> mining_laser) */
function getModuleBase(moduleId: string): string {
  return moduleId.replace(/_\d+$/, "");
}

export async function* refit(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const role = getParam(ctx, "role", "default");
  const homeBase = getParam(ctx, "homeBase",
    ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase);
  const maxSpendPct = getParam(ctx, "maxSpendPct", 0.30);
  const overrideEquip = getParam<string[]>(ctx, "equipModules", []);
  const overrideUnequip = getParam<string[]>(ctx, "unequipModules", []);

  const desiredModules = overrideEquip.length > 0
    ? overrideEquip
    : getModulesForRole(role);

  // Step 1: Dock at home station
  if (homeBase && ctx.player.dockedAtBase !== homeBase) {
    yield "traveling to home station for refit";
    try {
      await navigateAndDock(ctx, homeBase);
    } catch {
      if (!ctx.player.dockedAtBase) {
        try {
          await findAndDock(ctx);
        } catch {
          yield "could not dock for refit";
          yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "refit" });
          return;
        }
      }
    }
  } else if (!ctx.player.dockedAtBase) {
    try {
      await findAndDock(ctx);
    } catch {
      yield "could not dock for refit";
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "refit" });
      return;
    }
  }

  if (ctx.shouldStop) return;

  // Step 2: Scan local market for available modules (category filter for better results)
  let market: MarketOrder[] = [];
  try {
    market = await ctx.api.viewMarket(undefined, "module");
  } catch {
    // Fallback: try without category filter
    try { market = await ctx.api.viewMarket(); } catch { /* proceed without market data */ }
  }

  // Budget for buying modules from market
  const reserve = Math.max(2000, ctx.fleetConfig.minBotCredits);
  let budget = Math.max(0, (ctx.player.credits - reserve) * maxSpendPct);

  // Step 3: Load faction storage
  let factionStorage: Array<{ itemId: string; quantity: number }> = [];
  try {
    const factionData = await fleetViewFactionStorage(ctx);
    factionStorage = factionData.items.filter(i => i.quantity > 0);
  } catch { /* proceed without faction storage */ }

  if (ctx.shouldStop) return;

  // Step 4: Remove explicitly requested modules
  for (const modId of overrideUnequip) {
    if (ctx.shouldStop) return;
    const installed = ctx.ship.modules.find(m => m.moduleId === modId);
    if (!installed) continue;
    try {
      await ctx.api.uninstallMod(modId);
      await ctx.refreshState();
      // Deposit removed module to faction storage
      const inCargo = ctx.cargo.getItemQuantity(ctx.ship, modId);
      if (inCargo > 0) {
        try {
          await ctx.api.factionDepositItems(modId, inCargo);
          ctx.cache.invalidateFactionStorage();
          await ctx.refreshState();
        } catch { /* best effort */ }
      }
      yield `uninstalled ${modId}`;
    } catch (err) {
      yield `uninstall ${modId} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (desiredModules.length === 0) {
    yield `refit complete for ${role} role (no modules needed)`;
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "refit" });
    return;
  }

  // Step 4.5: Uninstall modules not matching any desired pattern (cleanup defaults)
  if (overrideUnequip.length === 0) {
    for (const mod of [...ctx.ship.modules]) {
      if (ctx.shouldStop) return;
      const base = getModuleBase(mod.moduleId);
      const matchesDesired = desiredModules.some(p => base.includes(p) || mod.moduleId.includes(p));
      if (matchesDesired) continue;

      // This module doesn't match any desired pattern — remove it to free the slot
      try {
        await ctx.api.uninstallMod(mod.moduleId);
        await ctx.refreshState();
        yield `removed unwanted ${mod.moduleId} (not in ${role} loadout)`;
        // Deposit to faction storage
        const inCargo = ctx.cargo.getItemQuantity(ctx.ship, mod.moduleId);
        if (inCargo > 0) {
          try {
            await ctx.api.factionDepositItems(mod.moduleId, inCargo);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
          } catch { /* best effort */ }
        }
      } catch {
        // Module might not be removable — skip
      }
    }
  }

  // Step 5: For each desired module pattern, check current vs best available
  // Group desired patterns and count how many of each we need
  const patternCounts = new Map<string, number>();
  for (const pattern of desiredModules) {
    patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
  }

  let upgrades = 0;
  let installs = 0;

  for (const [pattern, wantCount] of patternCounts) {
    if (ctx.shouldStop) return;

    // Find currently installed modules matching this pattern
    const installed = ctx.ship.modules
      .filter(m => m.moduleId.includes(pattern))
      .sort((a, b) => getModuleTier(a.moduleId) - getModuleTier(b.moduleId)); // lowest tier first

    const haveCount = installed.length;

    // Find best available tier in faction storage
    const storageModules = factionStorage
      .filter(s => s.itemId.includes(pattern) && s.quantity > 0)
      .sort((a, b) => getModuleTier(b.itemId) - getModuleTier(a.itemId)); // highest tier first

    // Find best available on market (sell orders = things we can buy)
    const marketModules = market
      .filter(o =>
        o.type === "sell" &&
        o.itemId.includes(pattern) &&
        o.quantity > 0 &&
        o.priceEach <= budget
      )
      .sort((a, b) => {
        // Prefer highest tier, then cheapest
        const tierDiff = getModuleTier(b.itemId) - getModuleTier(a.itemId);
        return tierDiff !== 0 ? tierDiff : a.priceEach - b.priceEach;
      });

    // Best available tier across all sources
    const bestStorageTier = storageModules.length > 0 ? getModuleTier(storageModules[0].itemId) : 0;
    const bestMarketTier = marketModules.length > 0 ? getModuleTier(marketModules[0].itemId) : 0;

    // Upgrade existing modules to higher tiers
    for (const mod of installed) {
      if (ctx.shouldStop) return;

      const currentTier = getModuleTier(mod.moduleId);
      const bestAvailTier = Math.max(bestStorageTier, bestMarketTier);

      if (bestAvailTier <= currentTier) continue; // Already best tier

      // Determine source: prefer faction storage (free), then market
      let source: "storage" | "market" | null = null;
      let sourceItemId = "";
      let sourcePrice = 0;

      if (bestStorageTier > currentTier && storageModules.length > 0) {
        source = "storage";
        sourceItemId = storageModules[0].itemId;
      } else if (bestMarketTier > currentTier && marketModules.length > 0) {
        source = "market";
        sourceItemId = marketModules[0].itemId;
        sourcePrice = marketModules[0].priceEach;
      }

      if (!source) continue;

      // Pre-check: will the new module fit if we swap out the old one?
      const fitCheck = canFitModule(ctx, sourceItemId, mod.moduleId);
      if (!fitCheck.fits) {
        yield `skip upgrade ${mod.moduleId} → ${sourceItemId}: ${fitCheck.reason}`;
        continue;
      }

      // Uninstall current module
      try {
        await ctx.api.uninstallMod(mod.moduleId);
        await ctx.refreshState();
        yield `uninstalled ${mod.moduleId} (tier ${currentTier})`;

        // Deposit old module to faction storage
        const inCargo = ctx.cargo.getItemQuantity(ctx.ship, mod.moduleId);
        if (inCargo > 0) {
          try {
            await ctx.api.factionDepositItems(mod.moduleId, inCargo);
            ctx.cache.invalidateFactionStorage();
            await ctx.refreshState();
            // Update local tracking
            const storageEntry = factionStorage.find(s => s.itemId === mod.moduleId);
            if (storageEntry) storageEntry.quantity += inCargo;
            else factionStorage.push({ itemId: mod.moduleId, quantity: inCargo });
          } catch { /* best effort */ }
        }
      } catch (err) {
        yield `uninstall ${mod.moduleId} failed: ${err instanceof Error ? err.message : String(err)}`;
        continue;
      }

      // Acquire the better module
      if (source === "storage") {
        try {
          await withdrawFromFaction(ctx, sourceItemId, 1);
          await ctx.refreshState();
          storageModules[0].quantity--;
          yield `withdrew ${sourceItemId} (tier ${getModuleTier(sourceItemId)}) from faction storage`;
        } catch (err) {
          yield `withdraw ${sourceItemId} failed: ${err instanceof Error ? err.message : String(err)}`;
          continue;
        }
      } else {
        try {
          await ctx.api.buy(sourceItemId, 1);
          await ctx.refreshState();
          budget -= sourcePrice;
          yield `bought ${sourceItemId} (tier ${getModuleTier(sourceItemId)}) for ${sourcePrice}cr`;
        } catch (err) {
          yield `buy ${sourceItemId} failed: ${err instanceof Error ? err.message : String(err)}`;
          continue;
        }
      }

      // Install the upgrade
      try {
        await ctx.api.installMod(sourceItemId);
        await ctx.refreshState();
        yield `installed ${sourceItemId} (upgrade: tier ${currentTier} -> ${getModuleTier(sourceItemId)})`;
        upgrades++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Deposit back to faction storage if install fails
        try {
          await ctx.api.factionDepositItems(sourceItemId, 1);
          ctx.cache.invalidateFactionStorage();
          await ctx.refreshState();
        } catch { /* best effort */ }
        if (msg.includes("cpu") || msg.includes("power") || msg.includes("slot")) {
          yield `ship slots full — ${msg}`;
          break;
        }
        yield `install ${sourceItemId} failed: ${msg}`;
      }
    }

    // Fill empty slots (need more of this pattern)
    const nowInstalled = ctx.ship.modules.filter(m => m.moduleId.includes(pattern)).length;
    const needMore = wantCount - nowInstalled;

    for (let i = 0; i < needMore; i++) {
      if (ctx.shouldStop) return;

      // Refresh storage/market availability
      const availStorage = factionStorage
        .filter(s => s.itemId.includes(pattern) && s.quantity > 0)
        .sort((a, b) => getModuleTier(b.itemId) - getModuleTier(a.itemId));

      const availMarket = market
        .filter(o =>
          o.type === "sell" &&
          o.itemId.includes(pattern) &&
          o.quantity > 0 &&
          o.priceEach <= budget
        )
        .sort((a, b) => {
          const tierDiff = getModuleTier(b.itemId) - getModuleTier(a.itemId);
          return tierDiff !== 0 ? tierDiff : a.priceEach - b.priceEach;
        });

      // Try faction storage first (free)
      if (availStorage.length > 0) {
        const mod = availStorage[0];
        const fitCheck = canFitModule(ctx, mod.itemId);
        if (!fitCheck.fits) {
          yield `skip ${mod.itemId}: ${fitCheck.reason}`;
          break;
        }
        try {
          await withdrawFromFaction(ctx, mod.itemId, 1);
          await ctx.refreshState();
          mod.quantity--;

          try {
            await ctx.api.installMod(mod.itemId);
            await ctx.refreshState();
            yield `equipped ${mod.itemId} from faction storage`;
            installs++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Deposit back
            try {
              await ctx.api.factionDepositItems(mod.itemId, 1);
              ctx.cache.invalidateFactionStorage();
              await ctx.refreshState();
              mod.quantity++;
            } catch { /* best effort */ }
            if (msg.includes("cpu") || msg.includes("power") || msg.includes("slot")) {
              yield `ship slots full — ${msg}`;
              break;
            }
            yield `install ${mod.itemId} failed: ${msg}`;
          }
          continue;
        } catch (err) {
          yield `withdraw ${mod.itemId} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // Try market (costs credits)
      if (availMarket.length > 0) {
        const order = availMarket[0];
        const fitCheck = canFitModule(ctx, order.itemId);
        if (!fitCheck.fits) {
          yield `skip ${order.itemId}: ${fitCheck.reason}`;
          break;
        }
        try {
          await ctx.api.buy(order.itemId, 1);
          await ctx.refreshState();
          budget -= order.priceEach;

          try {
            await ctx.api.installMod(order.itemId);
            await ctx.refreshState();
            yield `bought & equipped ${order.itemId} for ${order.priceEach}cr`;
            installs++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Deposit to faction storage if install fails
            try {
              await ctx.api.factionDepositItems(order.itemId, 1);
              ctx.cache.invalidateFactionStorage();
              await ctx.refreshState();
            } catch { /* best effort */ }
            if (msg.includes("cpu") || msg.includes("power") || msg.includes("slot")) {
              yield `ship slots full — ${msg}`;
              break;
            }
            yield `install ${order.itemId} failed: ${msg}`;
          }
        } catch (err) {
          yield `buy ${order.itemId} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // If neither source has modules, check other known stations
      if (availStorage.length === 0 && availMarket.length === 0) {
        const remote = ctx.cache.findItemSeller(pattern, budget);
        if (remote && remote.stationId !== ctx.player.dockedAtBase && canFitModule(ctx, remote.itemId).fits) {
          yield `${pattern}: found at remote station — traveling to buy`;
          try {
            await navigateAndDock(ctx, remote.stationId);
            await ctx.api.buy(remote.itemId, 1);
            await ctx.refreshState();
            budget -= remote.price;
            try {
              await ctx.api.installMod(remote.itemId);
              await ctx.refreshState();
              yield `bought & equipped ${remote.itemId} for ${remote.price}cr (remote)`;
              installs++;
              continue;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              try { await ctx.api.factionDepositItems(remote.itemId, 1); ctx.cache.invalidateFactionStorage(); await ctx.refreshState(); } catch { /* best effort */ }
              if (msg.includes("cpu") || msg.includes("power") || msg.includes("slot")) {
                yield `ship slots full — ${msg}`;
                break;
              }
              yield `install ${remote.itemId} failed: ${msg}`;
            }
          } catch (err) {
            yield `remote buy failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        yield `${pattern}: not available in storage or market`;
        break;
      }
    }
  }

  // Step 6: Repair worn modules
  for (const mod of ctx.ship.modules) {
    if (ctx.shouldStop) return;
    // Modules with wear/damage have durability < 100%
    const durability = mod.durability ?? mod.health ?? 100;
    if (durability < 100) {
      try {
        await ctx.api.repairModule(mod.moduleId);
        await ctx.refreshState();
        yield `repaired ${mod.moduleId} (${durability}% → 100%)`;
      } catch {
        // Module may not be repairable or insufficient credits
      }
    }
  }

  // Step 7: Service the ship
  await refuelIfNeeded(ctx);
  await repairIfNeeded(ctx);

  if (upgrades > 0 || installs > 0) {
    yield `refit complete: ${upgrades} upgrade(s), ${installs} new install(s) for ${role} role`;
  } else {
    yield `refit complete: modules already optimal for ${role} role`;
  }

  const finalMods = ctx.ship.modules.map(m => m.moduleId).join(", ");
  console.log(`[${ctx.botId}] Refit (${role}): ${finalMods}`);

  yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "refit" });
}
