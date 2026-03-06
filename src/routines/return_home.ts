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
  try {
    if (homeBase) {
      await navigateAndDock(ctx, homeBase);
    }
  } catch (err) {
    yield `return home failed: ${err instanceof Error ? err.message : String(err)}`;
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

    yield "home, docked and serviced";
  }

  yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "return_home" });
}
