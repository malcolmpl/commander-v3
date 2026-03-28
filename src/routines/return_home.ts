/**
 * Return-home routine - navigates bot to home base and docks.
 *
 * Assigned by the commander when a bot is idle and not at home.
 * Completes immediately once docked at home base.
 * Field routines (trader, hunter, explorer) are exempt from this.
 *
 * Params:
 *   homeBase: string    - Base ID to return to
 *   homeSystem: string  - System ID of home
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import {
  navigateAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  ensureMinCredits,
  depositExcessCredits,
  recoverStranded,
  burnFuelCells,
  getParam,
} from "./helpers";

export async function* returnHome(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const homeBase = getParam(ctx, "homeBase", ctx.fleetConfig.homeBase);
  const homeSystem = getParam(ctx, "homeSystem", ctx.fleetConfig.homeSystem);

  if (!homeBase && !homeSystem) {
    yield "no home configured";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "return_home" });
    return;
  }

  // Already at home?
  if (homeBase && ctx.player.dockedAtBase === homeBase) {
    yield "already home";
    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "return_home" });
    return;
  }

  // Navigate and dock
  yield "returning home";

  // Proactive fuel cell burn: if low on fuel and undocked, burn cargo cells before navigating
  if (!ctx.player.dockedAtBase && ctx.fuel.getPercentage(ctx.ship) < 30) {
    const hasCells = ctx.ship.cargo.some(c => c.itemId.includes("fuel") && c.quantity > 0);
    if (hasCells) {
      yield "burning fuel cells before travel";
      await burnFuelCells(ctx);
      await ctx.refreshState();
    }
  }

  try {
    if (homeBase) {
      await navigateAndDock(ctx, homeBase);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    yield `return home failed: ${msg}`;

    // If stranded (no fuel or insufficient), attempt fuel cell burn first
    if (!ctx.player.dockedAtBase && ctx.ship.fuel < 10) {
      const hasCells = ctx.ship.cargo.some(c => c.itemId.includes("fuel") && c.quantity > 0);
      if (hasCells) {
        yield "burning remaining fuel cells for recovery";
        const burned = await burnFuelCells(ctx);
        if (burned) {
          await ctx.refreshState();
          // Retry navigation after burning cells
          try {
            if (homeBase) {
              await navigateAndDock(ctx, homeBase);
              yield "home after fuel cell recovery";
              // Fall through to servicing below
            }
          } catch {
            yield `still cannot reach home after burning cells (fuel=${ctx.ship.fuel})`;
          }
        }
      }
    }

    // If still stranded (no fuel), attempt recovery via insurance/self-destruct
    if (ctx.ship.fuel === 0 && !ctx.player.dockedAtBase) {
      yield "stranded — attempting recovery";
      const recovery = await recoverStranded(ctx);
      yield `recovery: ${recovery.method} (${recovery.recovered ? "success" : "failed"})`;
      // After recovery (self-destruct respawn), try going home again
      if (recovery.recovered && ctx.player.dockedAtBase && homeBase && ctx.player.dockedAtBase !== homeBase) {
        try {
          await navigateAndDock(ctx, homeBase);
        } catch { /* at least we're alive */ }
      }
    }

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "return_home" });
    return;
  }

  // Service at home
  if (ctx.player.dockedAtBase) {
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    // Withdraw credits from faction treasury if below minimum
    const minCr = await ensureMinCredits(ctx);
    if (minCr.message) yield minCr.message;
    const maxCr = await depositExcessCredits(ctx);
    if (maxCr.message) yield maxCr.message;

    yield "home, docked and serviced";
  }

  yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "return_home" });
}
