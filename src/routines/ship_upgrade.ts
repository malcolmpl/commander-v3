/**
 * Ship upgrade routine - one-shot: buy or switch to a better ship, done.
 *
 * Commander queues upgrades via pendingUpgrades map. ScoringBrain passes:
 *   targetShipClass: string  - Ship class ID to buy/switch to
 *   maxSpend: number         - Credit limit (credits - reserve)
 *   sellOldShip: boolean     - Sell previous ship after switching
 *   alreadyOwned: boolean    - If true, bot already owns this ship — just switch
 *   ownedShipId: string      - Ship instance ID to switch to (when alreadyOwned)
 *   role: string             - Bot's primary role (miner, trader, etc.) for module fitting
 *
 * Flow (buy mode):
 *   1. Navigate to home station (has shipyard)
 *   2. Check shipyard showroom for target ship
 *   3. Dispose cargo if any (can't switch with cargo)
 *   4. Buy ship -> switch -> optionally sell old ship
 *   5. Fit modules for role from faction storage
 *   6. Refuel + repair, yield cycle_complete
 *
 * Flow (switch mode — alreadyOwned):
 *   1. Navigate to home station (faction storage for modules)
 *   2. Dispose cargo if any (can't switch with cargo)
 *   3. Switch to owned ship by ID
 *   4. Fit modules for role from faction storage
 *   5. Refuel + repair, yield cycle_complete
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateAndDock,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  disposeCargo,
  getParam,
  equipModulesForRoutine,
} from "./helpers";

/** Role → module patterns to equip (highest priority first) */
const ROLE_MODULES: Record<string, string[]> = {
  miner:     ["mining_laser", "mining_laser", "mining_laser"],
  harvester: ["mining_laser", "mining_laser"],
  explorer:  ["survey_scanner"],
  hunter:    ["weapon_laser", "weapon_laser", "weapon_laser"],
  crafter:   ["mining_laser"],
  trader:    [],
  quartermaster: [],
  default:   ["mining_laser"],
};

export async function* ship_upgrade(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const targetShipClass = getParam(ctx, "targetShipClass", "");
  const maxSpend = getParam(ctx, "maxSpend", 0);
  const sellOldShip = getParam(ctx, "sellOldShip", true);
  const alreadyOwned = getParam(ctx, "alreadyOwned", false);
  const ownedShipId = getParam(ctx, "ownedShipId", "");
  const role = getParam(ctx, "role", "default");

  if (!targetShipClass) {
    yield "no target ship class specified";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  // Already flying the target ship? Nothing to do.
  if (ctx.ship.classId === targetShipClass) {
    yield `already flying ${targetShipClass}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  // Step 1: Navigate to home station (has shipyard + faction storage for module fitting)
  const homeBase = ctx.fleetConfig.factionStorageStation || ctx.fleetConfig.homeBase;
  if (homeBase) {
    if (ctx.player.dockedAtBase !== homeBase) {
      yield "traveling to home station for upgrade";
      try {
        await navigateAndDock(ctx, homeBase);
      } catch (err) {
        yield `home station nav failed: ${err instanceof Error ? err.message : String(err)} — trying nearest`;
        // Fallback to nearest station
        if (!ctx.player.dockedAtBase) {
          try {
            await findAndDock(ctx);
          } catch (err2) {
            yield `dock failed: ${err2 instanceof Error ? err2.message : String(err2)}`;
            yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
            return;
          }
        }
      }
    }
  } else if (!ctx.player.dockedAtBase) {
    yield "finding station to dock";
    try {
      await findAndDock(ctx);
    } catch (err) {
      yield `dock failed: ${err instanceof Error ? err.message : String(err)}`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
      return;
    }
  }

  if (ctx.shouldStop) return;

  // Record old ship for potential selling
  const oldShipId = ctx.ship.id;
  const oldShipClass = ctx.ship.classId;

  // Step 2: Empty cargo first (can't switch ships with cargo)
  if (ctx.ship.cargo.length > 0) {
    yield "disposing cargo before ship switch";
    await disposeCargo(ctx);
    await ctx.refreshState();
  }

  if (ctx.shouldStop) return;

  // ── Switch mode: bot already owns the target ship ──
  if (alreadyOwned) {
    yield `switching to owned ${targetShipClass}`;

    // Find the target ship in owned ships list
    let switchToId = ownedShipId;
    if (!switchToId) {
      // Fallback: list ships and find by class
      try {
        const ships = await ctx.api.listShips();
        const match = ships.find(
          (s) => String(s.class_id ?? s.classId) === targetShipClass && String(s.ship_id ?? s.id) !== oldShipId
        );
        if (match) switchToId = String(match.ship_id ?? match.id);
      } catch (err) {
        yield `listShips failed: ${err instanceof Error ? err.message : String(err)}`;
        yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
        return;
      }
    }

    if (!switchToId) {
      yield `could not find owned ${targetShipClass} to switch to`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
      return;
    }

    try {
      await ctx.api.switchShip(switchToId);
      await ctx.refreshState();
      yield `switched to ${targetShipClass}`;
    } catch (err) {
      yield `switch failed: ${err instanceof Error ? err.message : String(err)}`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
      return;
    }

    // Fit modules + service the ship
    yield* fitModulesForRole(ctx, role);
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    console.log(`[${ctx.botId}] Ship switch (owned): ${oldShipClass} → ${targetShipClass} (FREE)`);
    yield `switch complete: ${oldShipClass} → ${targetShipClass}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  // ── Buy mode: purchase from shipyard ──

  // Step 3: Check shipyard for the target ship
  yield `checking shipyard for ${targetShipClass}`;
  let showroom: Array<Record<string, unknown>>;
  try {
    showroom = await ctx.api.shipyardShowroom();
  } catch (err) {
    yield `shipyard query failed: ${err instanceof Error ? err.message : String(err)}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  const targetShip = showroom.find(
    (s) => String(s.class_id ?? s.classId ?? s.id) === targetShipClass
  );
  if (!targetShip) {
    yield `${targetShipClass} not available at this shipyard`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  const price = Number(targetShip.price ?? targetShip.base_price ?? targetShip.basePrice ?? 0);
  if (price <= 0) {
    yield `invalid price for ${targetShipClass}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  // Step 4: Verify budget
  await ctx.refreshState();
  if (ctx.player.credits < price) {
    yield `can't afford ${targetShipClass} (need ${price}cr, have ${ctx.player.credits}cr)`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }
  if (maxSpend > 0 && price > maxSpend) {
    yield `${targetShipClass} exceeds budget (${price}cr > ${maxSpend}cr limit)`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  if (ctx.shouldStop) return;

  // Step 5: Buy the new ship
  yield `buying ${targetShipClass} for ${price}cr`;
  try {
    await ctx.api.buyShip(targetShipClass);
    await ctx.refreshState();
  } catch (err) {
    yield `buy failed: ${err instanceof Error ? err.message : String(err)}`;
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
    return;
  }

  if (ctx.shouldStop) return;

  // Step 6: Find the new ship and switch to it
  yield "switching to new ship";
  try {
    const ships = await ctx.api.listShips();
    // Find a ship matching the target class that isn't our old ship
    const newShip = ships.find(
      (s) => String(s.class_id ?? s.classId) === targetShipClass && String(s.ship_id ?? s.id) !== oldShipId
    );
    if (newShip) {
      await ctx.api.switchShip(String(newShip.ship_id ?? newShip.id));
      await ctx.refreshState();
      yield `switched to ${targetShipClass}`;
    } else {
      // Ship might have been auto-switched on purchase
      await ctx.refreshState();
      if (ctx.ship.classId === targetShipClass) {
        yield `auto-switched to ${targetShipClass}`;
      } else {
        yield "warning: could not find new ship to switch to";
      }
    }
  } catch (err) {
    yield `switch failed: ${err instanceof Error ? err.message : String(err)}`;
    // Not fatal — we still bought the ship
  }

  // Step 7: Sell old ship if requested
  if (sellOldShip && oldShipId && ctx.ship.id !== oldShipId) {
    yield `selling old ${oldShipClass}`;
    try {
      await ctx.api.sellShip(oldShipId);
      await ctx.refreshState();
      yield "old ship sold";
    } catch (err) {
      yield `sell old ship failed: ${err instanceof Error ? err.message : String(err)}`;
      // Non-fatal
    }
  }

  // Step 8: Fit modules for role from faction storage
  yield* fitModulesForRole(ctx, role);

  // Step 9: Service the new ship
  await refuelIfNeeded(ctx);
  await repairIfNeeded(ctx);

  // Log the upgrade
  console.log(`[${ctx.botId}] Ship upgrade: ${oldShipClass} → ${targetShipClass} (cost ${price}cr)`);

  yield `upgrade complete: ${oldShipClass} → ${targetShipClass}`;
  yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "ship_upgrade" });
}

/**
 * Fit as many role-appropriate modules as the ship can hold.
 * Withdraws from faction storage and installs until CPU/power is full.
 * equipModulesForRoutine handles duplicate counting, tier preference, and slot limits.
 */
async function* fitModulesForRole(
  ctx: BotContext,
  role: string,
): AsyncGenerator<RoutineYield, void, void> {
  const desiredModules = ROLE_MODULES[role] ?? ROLE_MODULES.default;
  if (desiredModules.length === 0) return;

  yield `fitting modules for ${role} role`;
  yield* equipModulesForRoutine(ctx, desiredModules);
}
