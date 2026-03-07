/**
 * Mission runner routine - accepts and completes NPC missions.
 *
 * Intelligence:
 *   - Only accepts missions the bot can actually complete
 *   - Skips combat/kill missions (unreliable for bots)
 *   - Handles cross-system travel for delivery/explore objectives
 *   - Parses objective descriptions + structured data for smart execution
 *   - Tracks progress and abandons stuck missions
 *
 * Params:
 *   missionTypes?: string[]    - Filter by type ("delivery", "explore", etc.)
 *   minReward?: number         - Minimum credit reward to accept
 *   autoAccept?: boolean       - Auto-accept matching missions (default: true)
 *   hubStation?: string        - Base ID to return to for mission browsing (auto-discovered)
 *   skipCombat?: boolean       - Skip combat/kill missions (default: true)
 *   maxJumps?: number          - Max jumps willing to travel for a mission (default: 4)
 */

import type { BotContext } from "../bot/types";
import type { RoutineYield } from "../events/types";
import { typedYield } from "../events/types";
import type { Mission, MissionObjective } from "../types/game";
import {
  navigateAndDock,
  navigateTo,
  navigateToPoi,
  dockAtCurrent,
  findAndDock,
  refuelIfNeeded,
  repairIfNeeded,
  handleEmergency,
  safetyCheck,
  ensureSystemDetail,
  getParam,
} from "./helpers";

// ── Objective Classification ──

type ObjectiveAction = "mine" | "deliver" | "travel" | "sell" | "craft" | "kill" | "survey" | "buy" | "collect" | "unknown";

const ACTION_KEYWORDS: Record<ObjectiveAction, string[]> = {
  mine: ["mine", "extract", "harvest", "gather ore", "collect ore", "dig"],
  deliver: ["deliver", "bring", "transport", "drop off", "hand over", "supply"],
  travel: ["travel", "visit", "go to", "fly to", "reach", "arrive", "explore", "navigate", "inspect", "check", "report to", "verify", "confirm", "meet", "rendezvous", "dock at", "return to"],
  sell: ["sell", "trade away", "offload"],
  craft: ["craft", "build", "manufacture", "assemble", "construct", "produce", "fabricate"],
  kill: ["kill", "destroy", "defeat", "eliminate", "attack", "hunt", "engage", "combat", "fight"],
  survey: ["survey", "scan", "chart", "map", "analyze", "probe", "investigate"],
  buy: ["buy", "purchase", "acquire", "procure", "obtain from market"],
  collect: ["collect", "pick up", "retrieve", "salvage", "loot", "fetch"],
  unknown: [],
};

// Mission types we should avoid (combat is too unreliable for bots)
const UNSAFE_MISSION_TYPES = new Set(["combat", "bounty", "assassination", "pirate", "pvp", "warfare"]);
const UNSAFE_KEYWORDS = ["kill", "destroy", "defeat", "eliminate", "attack", "hunt", "bounty", "assassination"];

function classifyObjective(obj: MissionObjective): ObjectiveAction {
  // Use structured type if available
  if (obj.objectiveType) {
    const t = obj.objectiveType.toLowerCase();
    for (const [action, _] of Object.entries(ACTION_KEYWORDS)) {
      if (t.includes(action)) return action as ObjectiveAction;
    }
  }

  // Fall back to description keyword matching
  const desc = obj.description.toLowerCase();
  for (const [action, keywords] of Object.entries(ACTION_KEYWORDS)) {
    if (keywords.some(kw => desc.includes(kw))) return action as ObjectiveAction;
  }

  return "unknown";
}

function isCombatMission(mission: Mission): boolean {
  // Check mission type
  if (UNSAFE_MISSION_TYPES.has(mission.type.toLowerCase())) return true;

  // Check title/description for combat keywords
  const text = `${mission.title} ${mission.description}`.toLowerCase();
  if (UNSAFE_KEYWORDS.some(kw => text.includes(kw))) return true;

  // Check if any objective is a kill objective
  for (const obj of mission.objectives) {
    if (classifyObjective(obj) === "kill") return true;
  }

  return false;
}

/** Estimate jump distance to a target system. Returns Infinity if unreachable. */
function estimateJumps(ctx: BotContext, targetSystemId: string | undefined): number {
  if (!targetSystemId) return 0;
  if (targetSystemId === ctx.player.currentSystem) return 0;
  const path = ctx.galaxy.findPath(ctx.player.currentSystem, targetSystemId);
  return path ? path.length - 1 : Infinity;
}

/** Check if bot has enough fuel for a trip (rough estimate: ~10% fuel per jump) */
function hasFuelForJumps(ctx: BotContext, jumps: number): boolean {
  if (jumps <= 0) return true;
  const fuelPerJump = 10; // rough estimate
  return ctx.player.skills ? true : (ctx.ship.fuel / ctx.ship.maxFuel * 100) > (jumps * fuelPerJump + 15);
}

/** Find the target system for a mission from mission data or objective data */
function findMissionTargetSystem(mission: Mission): string | undefined {
  if (mission.targetSystem) return mission.targetSystem;
  for (const obj of mission.objectives) {
    if (obj.systemId) return obj.systemId;
  }
  return undefined;
}

/** Find the target base for a delivery mission */
function findMissionTargetBase(mission: Mission): string | undefined {
  if (mission.targetBase) return mission.targetBase;
  for (const obj of mission.objectives) {
    if (obj.baseId) return obj.baseId;
  }
  return undefined;
}

/** Find the required item for a mission */
function findMissionRequiredItem(mission: Mission): { itemId: string; quantity: number } | undefined {
  if (mission.requiredItem) {
    return { itemId: mission.requiredItem, quantity: mission.requiredQuantity ?? 1 };
  }
  for (const obj of mission.objectives) {
    if (obj.itemId) return { itemId: obj.itemId, quantity: obj.target };
  }
  return undefined;
}

/** Check if a mission is completable by this bot */
function canCompleteMission(ctx: BotContext, mission: Mission, maxJumps: number, skipCombat: boolean): { ok: boolean; reason?: string } {
  // Skip combat missions
  if (skipCombat && isCombatMission(mission)) {
    return { ok: false, reason: "combat mission" };
  }

  // Check travel distance
  const targetSystem = findMissionTargetSystem(mission);
  if (targetSystem) {
    const jumps = estimateJumps(ctx, targetSystem);
    if (jumps > maxJumps) {
      return { ok: false, reason: `too far (${jumps} jumps)` };
    }
    if (jumps === Infinity) {
      return { ok: false, reason: "unreachable system" };
    }
    if (!hasFuelForJumps(ctx, jumps)) {
      return { ok: false, reason: "not enough fuel" };
    }
  }

  // Check all objectives for feasibility
  for (const obj of mission.objectives) {
    if (obj.complete) continue;
    const action = classifyObjective(obj);

    // Check objective-level target system
    if (obj.systemId) {
      const objJumps = estimateJumps(ctx, obj.systemId);
      if (objJumps > maxJumps) return { ok: false, reason: `objective too far (${objJumps} jumps)` };
      if (objJumps === Infinity) return { ok: false, reason: "objective in unreachable system" };
    }

    // Craft objectives: check if bot has crafting ability
    if (action === "craft") {
      const hasRecipes = ctx.crafting.getAllRecipes().length > 0;
      if (!hasRecipes) return { ok: false, reason: "no crafting recipes available" };
    }
  }

  return { ok: true };
}

/** Try to parse an item name from an objective description */
function parseItemFromDescription(desc: string): string | undefined {
  // Common patterns: "Mine 10 iron ore", "Deliver 5 copper ingot", "Collect titanium"
  const patterns = [
    /(?:mine|deliver|collect|bring|gather|sell|buy|craft|transport)\s+(?:\d+\s+)?(.+?)(?:\s+to\s+|\s+at\s+|\s+from\s+|$)/i,
    /(\w+(?:\s+\w+)?)\s+(?:ore|ingot|bar|plate|crystal|cell|component|module)/i,
  ];
  for (const p of patterns) {
    const m = desc.match(p);
    if (m?.[1]) return m[1].trim().toLowerCase();
  }
  return undefined;
}

// ── Main Routine ──

export async function* mission_runner(ctx: BotContext): AsyncGenerator<RoutineYield, void, void> {
  const missionTypes = getParam<string[]>(ctx, "missionTypes", []);
  const minReward = getParam(ctx, "minReward", 0);
  const autoAccept = getParam(ctx, "autoAccept", true);
  const skipCombat = getParam(ctx, "skipCombat", true);
  const maxJumps = getParam(ctx, "maxJumps", 4);
  let hubStation = getParam(ctx, "hubStation", "");

  // Auto-discover hub station
  if (!hubStation) {
    if (ctx.player.dockedAtBase) {
      hubStation = ctx.player.dockedAtBase;
    } else {
      try {
        const system = await ctx.api.getSystem();
        const station = system.pois.find((p) => p.hasBase);
        if (station?.baseId) hubStation = station.baseId;
      } catch { /* ok */ }
    }
  }

  // Fallback: use fleet home base
  if (!hubStation && ctx.fleetConfig.homeBase) {
    hubStation = ctx.fleetConfig.homeBase;
  }

  while (!ctx.shouldStop) {
    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `emergency: ${issue}`;
      const handled = await handleEmergency(ctx);
      if (!handled) return;
    }

    // ── Check for active missions first ──
    let activeMissions: Mission[] = [];
    try {
      activeMissions = await ctx.api.getActiveMissions();
    } catch { /* ok, will browse new ones */ }

    // Resume an active mission if we have one
    const activeMission = activeMissions.find(m => m.objectives.some(o => !o.complete));
    if (activeMission) {
      yield `resuming active mission: ${activeMission.title}`;
      const result = yield* executeMission(ctx, activeMission, hubStation);
      if (result === "stop") return;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "mission_runner" });
      continue;
    }

    // ── Go to hub station to browse new missions ──
    if (hubStation && ctx.player.dockedAtBase !== hubStation) {
      yield "traveling to mission hub";
      try {
        await navigateAndDock(ctx, hubStation);
      } catch (err) {
        yield `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
        // Try any nearby station
        try {
          await findAndDock(ctx);
          hubStation = ctx.player.dockedAtBase ?? hubStation;
        } catch {
          return;
        }
      }
    } else if (!ctx.player.dockedAtBase) {
      try {
        await dockAtCurrent(ctx);
      } catch {
        try { await findAndDock(ctx); } catch { return; }
      }
    }

    if (ctx.shouldStop) return;

    // ── Refuel before browsing (so fuel checks for missions are accurate) ──
    await refuelIfNeeded(ctx);

    // ── Browse missions ──
    yield "browsing missions";
    let missions: Mission[];
    try {
      missions = await ctx.api.getMissions();
    } catch (err) {
      yield `mission query failed: ${err instanceof Error ? err.message : String(err)}`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "mission_runner" });
      continue;
    }

    // ── Filter missions ──
    let candidates = missions;

    // Type filter
    if (missionTypes.length > 0) {
      candidates = candidates.filter((m) => missionTypes.includes(m.type));
    }

    // Reward filter
    if (minReward > 0) {
      candidates = candidates.filter((m) =>
        m.rewards.some((r) => r.type === "credits" && r.amount >= minReward)
      );
    }

    // Feasibility filter — only keep missions we can actually complete
    const feasible: Array<{ mission: Mission; reason?: string }> = [];
    const rejected: string[] = [];
    for (const m of candidates) {
      const check = canCompleteMission(ctx, m, maxJumps, skipCombat);
      if (check.ok) {
        feasible.push({ mission: m });
      } else {
        rejected.push(`${m.title}: ${check.reason}`);
      }
    }

    if (rejected.length > 0 && feasible.length === 0) {
      yield `skipped ${rejected.length} missions: ${rejected.slice(0, 3).join("; ")}`;
    }

    if (feasible.length === 0) {
      yield "no completable missions available";
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "mission_runner" });
      continue;
    }

    // ── Score and sort missions ──
    // Prefer: higher reward, closer target, fewer objectives
    feasible.sort((a, b) => {
      const rewardA = a.mission.rewards.find((r) => r.type === "credits")?.amount ?? 0;
      const rewardB = b.mission.rewards.find((r) => r.type === "credits")?.amount ?? 0;

      const jumpsA = estimateJumps(ctx, findMissionTargetSystem(a.mission));
      const jumpsB = estimateJumps(ctx, findMissionTargetSystem(b.mission));

      // Score: reward per estimated effort (jumps + objectives)
      const effortA = Math.max(1, jumpsA + a.mission.objectives.length);
      const effortB = Math.max(1, jumpsB + b.mission.objectives.length);

      const scoreA = rewardA / effortA;
      const scoreB = rewardB / effortB;

      return scoreB - scoreA;
    });

    const best = feasible[0].mission;
    const reward = best.rewards.find((r) => r.type === "credits");
    yield `found ${feasible.length} completable missions (best: ${best.title}, ${reward ? `${reward.amount}cr` : "no cr reward"})`;

    if (!autoAccept) {
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "mission_runner" });
      continue;
    }

    // ── Accept best mission ──
    yield `accepting: ${best.title}`;
    try {
      await ctx.api.acceptMission(best.id);
      await ctx.refreshState();
    } catch (err) {
      yield `accept failed: ${err instanceof Error ? err.message : String(err)}`;
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "mission_runner" });
      continue;
    }

    if (ctx.shouldStop) return;

    // ── Execute mission ──
    const result = yield* executeMission(ctx, best, hubStation);
    if (result === "stop") return;

    // ── Service ──
    await refuelIfNeeded(ctx);
    await repairIfNeeded(ctx);

    yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "mission_runner" });
  }
}

// ── Mission Execution ──

async function* executeMission(
  ctx: BotContext,
  mission: Mission,
  hubStation: string,
): AsyncGenerator<RoutineYield, "done" | "stop" | "failed", void> {
  yield `executing: ${mission.title} (${mission.type})`;

  const MAX_CYCLES = 40;
  let cycles = 0;
  let lastProgress = -1;
  let stallCount = 0;

  while (!ctx.shouldStop && cycles < MAX_CYCLES) {
    cycles++;

    // ── Check mission progress ──
    let active: Mission | undefined;
    try {
      const activeMissions = await ctx.api.getActiveMissions();
      active = activeMissions.find((m) => m.id === mission.id);
    } catch {
      yield "failed to check mission progress";
      return "failed";
    }

    if (!active) {
      // Mission disappeared — might have been auto-completed
      yield "mission no longer active (may be complete)";
      return "done";
    }

    // Check if all objectives complete
    const incomplete = active.objectives.filter(o => !o.complete);
    if (incomplete.length === 0) {
      // All objectives done — complete the mission
      yield* completeMission(ctx, mission, hubStation);
      return "done";
    }

    // Track progress to detect stalls
    const totalProgress = active.objectives.reduce((s, o) => s + o.progress, 0);
    if (totalProgress === lastProgress) {
      stallCount++;
      if (stallCount >= 8) {
        yield `mission stalled (no progress for ${stallCount} cycles) — abandoning`;
        try { await ctx.api.abandonMission(mission.id); } catch { /* ok */ }
        return "failed";
      }
    } else {
      stallCount = 0;
      lastProgress = totalProgress;
    }

    // ── Work on first incomplete objective ──
    const obj = incomplete[0];
    const action = classifyObjective(obj);
    yield `objective [${action}]: ${obj.description} (${obj.progress}/${obj.target})`;

    const handled = yield* handleObjective(ctx, mission, obj, action, hubStation);
    if (!handled) {
      // Try completing mission anyway (some missions auto-complete)
      try {
        await ctx.api.completeMission(mission.id);
        await ctx.refreshState();
        yield "mission completed (auto-complete)";
        return "done";
      } catch { /* not ready */ }
    }

    // ── Safety check ──
    const issue = safetyCheck(ctx);
    if (issue) {
      yield `mission interrupted: ${issue}`;
      const emergencyHandled = await handleEmergency(ctx);
      if (!emergencyHandled) {
        try { await ctx.api.abandonMission(mission.id); } catch { /* ok */ }
        return "stop";
      }
    }
  }

  if (ctx.shouldStop) return "stop";

  // Ran out of cycles
  yield `too many cycles (${MAX_CYCLES}) — abandoning mission`;
  try { await ctx.api.abandonMission(mission.id); } catch { /* ok */ }
  return "failed";
}

// ── Objective Handlers ──

async function* handleObjective(
  ctx: BotContext,
  mission: Mission,
  obj: MissionObjective,
  action: ObjectiveAction,
  hubStation: string,
): AsyncGenerator<RoutineYield, boolean, void> {
  switch (action) {
    case "mine":
      return yield* handleMineObjective(ctx, obj);
    case "deliver":
      return yield* handleDeliverObjective(ctx, mission, obj, hubStation);
    case "travel":
      return yield* handleTravelObjective(ctx, mission, obj);
    case "survey":
      return yield* handleSurveyObjective(ctx, mission, obj);
    case "sell":
      return yield* handleSellObjective(ctx);
    case "buy":
    case "collect":
      return yield* handleCollectObjective(ctx, obj);
    case "craft":
      return yield* handleCraftObjective(ctx, obj);
    case "kill":
      // Should have been filtered out, but handle gracefully
      yield "skipping combat objective";
      return false;
    case "unknown":
      return yield* handleUnknownObjective(ctx, mission, obj, hubStation);
  }
}

/** Mine objective: find a belt and mine ore */
async function* handleMineObjective(
  ctx: BotContext,
  obj: MissionObjective,
): AsyncGenerator<RoutineYield, boolean, void> {
  // Undock if needed
  if (ctx.player.dockedAtBase) {
    try { await ctx.api.undock(); await ctx.refreshState(); } catch { /* ok */ }
  }

  // Navigate to target system if objective specifies one
  if (obj.systemId && obj.systemId !== ctx.player.currentSystem) {
    yield `traveling to target system for mining`;
    try {
      await navigateTo(ctx, obj.systemId);
    } catch (err) {
      yield `travel failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  await ensureSystemDetail(ctx);
  const system = await ctx.api.getSystem();
  const belt = system.pois.find((p: any) =>
    p.type === "asteroid_belt" || p.type === "ice_field" || p.type === "gas_cloud"
    || p.type === "asteroid" || p.type === "nebula"
  );

  if (!belt) {
    // Try neighboring systems
    yield "no mineable POI in current system, checking neighbors";
    const neighbors = ctx.galaxy.getSystem(ctx.player.currentSystem)?.connections ?? [];
    for (const neighborId of neighbors) {
      const neighborSys = ctx.galaxy.getSystem(neighborId);
      const neighborBelt = neighborSys?.pois.find(p =>
        p.type === "asteroid_belt" || p.type === "ice_field" || p.type === "gas_cloud"
      );
      if (neighborBelt) {
        yield `found belt in ${neighborSys!.name}, traveling`;
        try {
          await navigateTo(ctx, neighborId, neighborBelt.id);
          break;
        } catch { continue; }
      }
    }
    // Re-check after travel
    if (!ctx.player.dockedAtBase) {
      yield "mining at current location";
      try {
        await ctx.api.mine();
        await ctx.refreshState();
        return true;
      } catch { return false; }
    }
    return false;
  }

  // Travel to belt
  if (ctx.player.currentPoi !== belt.id) {
    yield `traveling to ${belt.name ?? belt.id}`;
    try {
      await ctx.api.travel(belt.id);
      await ctx.refreshState();
    } catch (err) {
      yield `travel to belt failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  // Mine multiple times per cycle to make progress
  const mineCycles = Math.min(3, obj.target - obj.progress);
  for (let i = 0; i < mineCycles; i++) {
    if (ctx.shouldStop) return true;
    yield `mining (${i + 1}/${mineCycles})`;
    try {
      await ctx.api.mine();
      await ctx.refreshState();
    } catch (err) {
      yield `mine failed: ${err instanceof Error ? err.message : String(err)}`;
      break;
    }
    // Check if cargo is getting full — dock and sell/deposit
    if (ctx.ship.cargoUsed / ctx.ship.cargoCapacity > 0.85) {
      yield "cargo nearly full, docking to offload";
      try {
        await findAndDock(ctx);
        // Sell or deposit cargo
        for (const item of ctx.ship.cargo) {
          if (item.quantity <= 0) continue;
          try { await ctx.api.sell(item.itemId, item.quantity); } catch { /* ok */ }
        }
        await ctx.refreshState();
        // Undock to continue mining
        try { await ctx.api.undock(); await ctx.refreshState(); } catch { /* ok */ }
        // Re-travel to belt
        if (ctx.player.currentPoi !== belt.id) {
          try { await ctx.api.travel(belt.id); await ctx.refreshState(); } catch { /* ok */ }
        }
      } catch { /* ok */ }
    }
  }

  return true;
}

/** Deliver objective: bring items to a station */
async function* handleDeliverObjective(
  ctx: BotContext,
  mission: Mission,
  obj: MissionObjective,
  hubStation: string,
): AsyncGenerator<RoutineYield, boolean, void> {
  // Determine target base
  const targetBase = obj.baseId ?? findMissionTargetBase(mission) ?? hubStation;

  // Check if we need to acquire the item first
  const requiredItem = obj.itemId ?? findMissionRequiredItem(mission)?.itemId;
  if (requiredItem) {
    const have = ctx.ship.cargo.find(c => c.itemId === requiredItem)?.quantity ?? 0;
    const need = obj.target - obj.progress;
    if (have < need) {
      // Try to withdraw from storage
      if (ctx.player.dockedAtBase) {
        yield `need ${need - have} more ${requiredItem}, checking storage`;
        try {
          await ctx.api.withdrawItems(requiredItem, need - have);
          await ctx.refreshState();
        } catch { /* not in storage */ }
      }
      // Try to buy
      const haveNow = ctx.ship.cargo.find(c => c.itemId === requiredItem)?.quantity ?? 0;
      if (haveNow < need) {
        if (!ctx.player.dockedAtBase) {
          try { await findAndDock(ctx); } catch { /* ok */ }
        }
        if (ctx.player.dockedAtBase) {
          yield `buying ${need - haveNow} ${requiredItem}`;
          try {
            await ctx.api.buy(requiredItem, need - haveNow);
            await ctx.refreshState();
          } catch (err) {
            yield `buy failed: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }
  }

  // Navigate to target base
  if (targetBase && ctx.player.dockedAtBase !== targetBase) {
    yield `delivering to ${targetBase}`;
    try {
      await navigateAndDock(ctx, targetBase);
    } catch (err) {
      // Fallback: try the hub station
      yield `delivery navigation failed: ${err instanceof Error ? err.message : String(err)}`;
      if (hubStation && hubStation !== targetBase) {
        try { await navigateAndDock(ctx, hubStation); } catch { return false; }
      } else {
        return false;
      }
    }
  } else if (!ctx.player.dockedAtBase) {
    try { await dockAtCurrent(ctx); } catch {
      try { await findAndDock(ctx); } catch { return false; }
    }
  }

  // Try completing — delivery missions often auto-complete on dock
  try {
    await ctx.api.completeMission(mission.id);
    await ctx.refreshState();
    return true;
  } catch { /* not ready yet */ }

  return true;
}

/** Travel/explore objective: visit a specific location */
async function* handleTravelObjective(
  ctx: BotContext,
  mission: Mission,
  obj: MissionObjective,
): AsyncGenerator<RoutineYield, boolean, void> {
  // Undock if needed
  if (ctx.player.dockedAtBase) {
    try { await ctx.api.undock(); await ctx.refreshState(); } catch { /* ok */ }
  }

  // Navigate to target system if specified
  const targetSystem = obj.systemId ?? findMissionTargetSystem(mission);
  if (targetSystem && targetSystem !== ctx.player.currentSystem) {
    yield `traveling to system ${targetSystem}`;
    try {
      await navigateTo(ctx, targetSystem);
    } catch (err) {
      yield `travel failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  // Navigate to target POI if specified
  if (obj.poiId && ctx.player.currentPoi !== obj.poiId) {
    yield `visiting POI ${obj.poiId}`;
    try {
      await navigateToPoi(ctx, obj.poiId);
    } catch {
      // POI might be in current system
      try { await ctx.api.travel(obj.poiId); await ctx.refreshState(); } catch { /* ok */ }
    }
    return true;
  }

  // If target base is specified, dock there (inspect/visit objectives)
  const targetBase = obj.baseId ?? findMissionTargetBase(mission);
  if (targetBase) {
    yield `docking at target base ${targetBase}`;
    try {
      await navigateAndDock(ctx, targetBase);
      return true;
    } catch { /* ok */ }
  }

  // Try to find a POI/base matching the description text (e.g. "Inspect Sirius Observatory Station")
  await ensureSystemDetail(ctx);
  const descLower = obj.description.toLowerCase();
  const allSystems = ctx.galaxy.getAllSystems();
  for (const sys of allSystems) {
    for (const poi of sys.pois) {
      const poiName = (poi.name ?? "").toLowerCase();
      const baseName = (poi.baseName ?? "").toLowerCase();
      if (poiName && descLower.includes(poiName) || baseName && descLower.includes(baseName)) {
        yield `found target: ${poi.name} in ${sys.name}`;
        if (sys.id !== ctx.player.currentSystem) {
          try { await navigateTo(ctx, sys.id); } catch { continue; }
        }
        if (poi.hasBase && poi.baseId) {
          try { await navigateAndDock(ctx, poi.baseId); return true; } catch { /* ok */ }
        } else {
          try { await navigateToPoi(ctx, poi.id); return true; } catch { /* ok */ }
        }
      }
    }
  }

  // No specific target found — visit POIs in the current system
  const system = ctx.galaxy.getSystem(ctx.player.currentSystem);
  if (system) {
    for (const poi of system.pois) {
      if (ctx.shouldStop) break;
      if (ctx.player.currentPoi === poi.id) continue;
      yield `visiting ${poi.name ?? poi.id}`;
      try {
        await ctx.api.travel(poi.id);
        await ctx.refreshState();
      } catch { /* ok */ }
      return true; // One POI per cycle
    }
  }

  return true;
}

/** Survey/scan objective: survey the system */
async function* handleSurveyObjective(
  ctx: BotContext,
  mission: Mission,
  obj: MissionObjective,
): AsyncGenerator<RoutineYield, boolean, void> {
  // Undock if needed
  if (ctx.player.dockedAtBase) {
    try { await ctx.api.undock(); await ctx.refreshState(); } catch { /* ok */ }
  }

  // Navigate to target system if specified
  const targetSystem = obj.systemId ?? findMissionTargetSystem(mission);
  if (targetSystem && targetSystem !== ctx.player.currentSystem) {
    yield `traveling to survey target system`;
    try {
      await navigateTo(ctx, targetSystem);
    } catch (err) {
      yield `travel failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  // Try survey
  yield "surveying system";
  try {
    await ctx.api.surveySystem();
    await ctx.refreshState();
  } catch (err) {
    yield `survey failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Also try scanning nearby objects
  try {
    const nearby = await ctx.api.getNearby();
    for (const target of nearby.slice(0, 2)) {
      try { await ctx.api.scan(target.playerId); } catch { /* ok */ }
    }
  } catch { /* ok */ }

  // Visit POIs (some survey missions want you to visit each POI)
  await ensureSystemDetail(ctx);
  const system = ctx.galaxy.getSystem(ctx.player.currentSystem);
  if (system) {
    for (const poi of system.pois) {
      if (ctx.shouldStop) break;
      if (ctx.player.currentPoi === poi.id) continue;
      yield `surveying ${poi.name ?? poi.id}`;
      try {
        await ctx.api.travel(poi.id);
        await ctx.refreshState();
        try { await ctx.api.surveySystem(); } catch { /* ok */ }
      } catch { /* ok */ }
      return true; // One POI per cycle
    }
  }

  return true;
}

/** Sell objective: sell cargo at a station */
async function* handleSellObjective(
  ctx: BotContext,
): AsyncGenerator<RoutineYield, boolean, void> {
  if (!ctx.player.dockedAtBase) {
    try { await dockAtCurrent(ctx); } catch {
      try { await findAndDock(ctx); } catch { return false; }
    }
  }

  let soldAny = false;
  for (const item of ctx.ship.cargo) {
    if (ctx.shouldStop) break;
    if (item.quantity <= 0) continue;
    // Don't sell fuel cells
    if (item.itemId === "fuel_cell") continue;
    try {
      await ctx.api.sell(item.itemId, item.quantity);
      await ctx.refreshState();
      soldAny = true;
    } catch { /* ok */ }
  }

  return soldAny || ctx.ship.cargo.length === 0;
}

/** Buy/collect objective: acquire items */
async function* handleCollectObjective(
  ctx: BotContext,
  obj: MissionObjective,
): AsyncGenerator<RoutineYield, boolean, void> {
  const itemId = obj.itemId;
  const need = obj.target - obj.progress;

  if (!ctx.player.dockedAtBase) {
    try { await dockAtCurrent(ctx); } catch {
      try { await findAndDock(ctx); } catch { return false; }
    }
  }

  // Try storage first
  if (itemId) {
    try {
      await ctx.api.withdrawItems(itemId, need);
      await ctx.refreshState();
      const have = ctx.ship.cargo.find(c => c.itemId === itemId)?.quantity ?? 0;
      if (have >= need) return true;
    } catch { /* ok */ }

    // Try buying
    yield `buying ${need} ${itemId}`;
    try {
      await ctx.api.buy(itemId, need);
      await ctx.refreshState();
      return true;
    } catch (err) {
      yield `buy failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    // No item ID — try parsing from description
    const parsed = parseItemFromDescription(obj.description);
    if (parsed) {
      yield `attempting to buy "${parsed}" (parsed from objective)`;
      try {
        await ctx.api.buy(parsed, need);
        await ctx.refreshState();
        return true;
      } catch { /* item ID might be wrong */ }
    }
  }

  return false;
}

/** Craft objective: craft items at a station */
async function* handleCraftObjective(
  ctx: BotContext,
  obj: MissionObjective,
): AsyncGenerator<RoutineYield, boolean, void> {
  if (!ctx.player.dockedAtBase) {
    try { await dockAtCurrent(ctx); } catch {
      try { await findAndDock(ctx); } catch { return false; }
    }
  }

  const itemId = obj.itemId;
  if (!itemId) {
    yield "craft objective has no target item — skipping";
    return false;
  }

  // Find recipe for the required item
  const recipes = ctx.crafting.getAllRecipes();
  const recipe = recipes.find(r => r.outputItem === itemId);
  if (!recipe) {
    yield `no recipe for ${itemId}`;
    return false;
  }

  // Check and acquire ingredients
  for (const ing of recipe.ingredients) {
    const have = ctx.ship.cargo.find(c => c.itemId === ing.itemId)?.quantity ?? 0;
    if (have < ing.quantity) {
      const need = ing.quantity - have;
      // Try storage
      try { await ctx.api.withdrawItems(ing.itemId, need); await ctx.refreshState(); } catch { /* ok */ }
      // Try buying
      const haveNow = ctx.ship.cargo.find(c => c.itemId === ing.itemId)?.quantity ?? 0;
      if (haveNow < ing.quantity) {
        try { await ctx.api.buy(ing.itemId, ing.quantity - haveNow); await ctx.refreshState(); } catch {
          yield `cannot acquire ingredient ${ing.itemId}`;
          return false;
        }
      }
    }
  }

  // Craft
  yield `crafting ${itemId}`;
  try {
    await ctx.api.craft(recipe.id);
    await ctx.refreshState();
    return true;
  } catch (err) {
    yield `craft failed: ${err instanceof Error ? err.message : String(err)}`;
    return false;
  }
}

/** Unknown objective: try docking at hub and completing */
async function* handleUnknownObjective(
  ctx: BotContext,
  mission: Mission,
  obj: MissionObjective,
  hubStation: string,
): AsyncGenerator<RoutineYield, boolean, void> {
  yield `unknown objective: "${obj.description}" — trying generic approach`;

  // Navigate to any target specified
  const targetSystem = obj.systemId ?? findMissionTargetSystem(mission);
  if (targetSystem && targetSystem !== ctx.player.currentSystem) {
    try { await navigateTo(ctx, targetSystem); } catch { /* ok */ }
  }

  const targetBase = obj.baseId ?? findMissionTargetBase(mission);
  if (targetBase) {
    try { await navigateAndDock(ctx, targetBase); } catch { /* ok */ }
  } else if (hubStation && ctx.player.dockedAtBase !== hubStation) {
    try { await navigateAndDock(ctx, hubStation); } catch { /* ok */ }
  } else if (!ctx.player.dockedAtBase) {
    try { await findAndDock(ctx); } catch { /* ok */ }
  }

  // Try completing
  try {
    await ctx.api.completeMission(mission.id);
    await ctx.refreshState();
    return true;
  } catch { /* not ready */ }

  // Visit a POI if undocked
  if (!ctx.player.dockedAtBase) {
    await ensureSystemDetail(ctx);
    const system = ctx.galaxy.getSystem(ctx.player.currentSystem);
    if (system) {
      const unvisited = system.pois.find(p => p.id !== ctx.player.currentPoi);
      if (unvisited) {
        try { await ctx.api.travel(unvisited.id); await ctx.refreshState(); } catch { /* ok */ }
      }
    }
  }

  return false;
}

/** Complete a finished mission — dock and submit */
async function* completeMission(
  ctx: BotContext,
  mission: Mission,
  hubStation: string,
): AsyncGenerator<RoutineYield, void, void> {
  // Some missions require docking to complete
  if (!ctx.player.dockedAtBase) {
    const targetBase = findMissionTargetBase(mission);
    if (targetBase) {
      try { await navigateAndDock(ctx, targetBase); } catch {
        try { await findAndDock(ctx); } catch { /* ok */ }
      }
    } else if (hubStation) {
      try { await navigateAndDock(ctx, hubStation); } catch {
        try { await findAndDock(ctx); } catch { /* ok */ }
      }
    } else {
      try { await findAndDock(ctx); } catch { /* ok */ }
    }
  }

  yield "completing mission";
  try {
    await ctx.api.completeMission(mission.id);
    await ctx.refreshState();
    const reward = mission.rewards.find((r) => r.type === "credits");
    yield `mission complete! ${reward ? `+${reward.amount}cr` : ""}`;
  } catch (err) {
    yield `completion failed: ${err instanceof Error ? err.message : String(err)}`;
    // Try completing undocked
    if (ctx.player.dockedAtBase) {
      try { await ctx.api.undock(); await ctx.refreshState(); } catch { /* ok */ }
      try {
        await ctx.api.completeMission(mission.id);
        await ctx.refreshState();
        yield "mission completed (after undock)";
      } catch { /* truly failed */ }
    }
  }
}
