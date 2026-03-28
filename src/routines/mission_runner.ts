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
  payFactionTax,
  fleetGetSystem,
} from "./helpers";

// ── Objective Classification ──

type ObjectiveAction = "mine" | "deliver" | "travel" | "sell" | "craft" | "kill" | "survey" | "buy" | "collect" | "trade" | "unknown";

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
  trade: ["trade route", "buy and sell", "buy at", "sell at", "trade mission"],
  unknown: [],
};

// Mission types we should avoid (combat is too unreliable for bots)
const UNSAFE_MISSION_TYPES = new Set(["combat", "bounty", "assassination", "pirate", "pvp", "warfare"]);
const UNSAFE_KEYWORDS = ["kill", "destroy", "defeat", "eliminate", "attack", "hunt", "bounty", "assassination"];

// Objective types we can reliably complete (whitelist approach)
const COMPLETABLE_ACTIONS: Set<ObjectiveAction> = new Set(["travel", "survey", "mine", "sell", "trade"]);
// These CAN work but need profitability checks (item cost vs reward)
const RISKY_ACTIONS: Set<ObjectiveAction> = new Set(["deliver", "buy", "collect", "craft"]);

/** Map structured objective types from API to our action types */
const STRUCTURED_TYPE_MAP: Record<string, ObjectiveAction> = {
  deliver_item: "deliver",
  mine_resource: "mine",
  visit_system: "travel",
  dock_at_base: "travel",
  kill_pirate: "kill",
  // sell_wreck: too complex (find wreck → tow → pirate base → sell) — filtered out as "unknown"
  craft_item: "craft",
  buy_item: "buy",
  survey_system: "survey",
  trade: "trade",
  trade_route: "trade",
  buy_and_sell: "trade",
  sell_item: "trade",
};

function classifyObjective(obj: MissionObjective): ObjectiveAction {
  // Use structured type from API if available (most reliable)
  // normalizeMission maps API "type" field → objectiveType
  const objType = obj.objectiveType;
  if (objType) {
    const mapped = STRUCTURED_TYPE_MAP[objType.toLowerCase()];
    if (mapped) return mapped;
    // Fallback: check if the type string contains an action keyword
    const t = objType.toLowerCase();
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

/** Find the issuing base for a mission (where it was offered) */
function findMissionIssuingBase(mission: Mission): string | undefined {
  return mission.issuingBase;
}

/** Detect trade missions (v0.241.0 dynamic trade missions based on market supply/demand) */
function isTradeTypeMission(mission: Mission): boolean {
  // Explicit trade mission fields from API
  if (mission.sourceBase && mission.destinationBase) return true;
  if (mission.buyPrice != null && mission.sellPrice != null) return true;
  // Type-based detection
  const t = mission.type.toLowerCase();
  if (t === "trade" || t === "trade_route" || t === "trading") return true;
  // Keyword detection in title
  const title = mission.title.toLowerCase();
  if (title.includes("trade route") || title.includes("trade run") || title.includes("trade mission") || title.includes("buy and sell")) return true;
  // Structural detection: has issuing base + sell_item objective at a different station
  if (mission.issuingBase && mission.objectives.some(o => o.objectiveType === "sell_item")) return true;
  return false;
}

/** Estimate jump distance to a target system. Returns Infinity if unreachable. */
function estimateJumps(ctx: BotContext, targetSystemId: string | undefined): number {
  if (!targetSystemId) return 0;
  if (targetSystemId === ctx.player.currentSystem) return 0;
  const path = ctx.galaxy.findPath(ctx.player.currentSystem, targetSystemId);
  return path ? path.length - 1 : Infinity;
}

/** Check if bot has enough fuel for a round trip (physics-based since v0.188.0) */
function hasFuelForJumps(ctx: BotContext, jumps: number): boolean {
  if (jumps <= 0) return true;
  const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);
  const roundTripFuel = jumps * 2 * fuelPerJump;
  const fuelNeeded = roundTripFuel + 2; // +2 safety buffer
  return ctx.ship.fuel >= fuelNeeded;
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

/** Estimate fuel cost in credits for a round trip (physics-based since v0.188.0) */
function estimateTripCost(ctx: BotContext, jumps: number): number {
  if (jumps <= 0) return 0;
  const fuelPerJump = ctx.nav.estimateJumpFuel(ctx.ship);
  const fuelCost = jumps * 2 * fuelPerJump * 15;
  return fuelCost;
}

/** Check if a mission is completable AND profitable by this bot */
function canCompleteMission(ctx: BotContext, mission: Mission, maxJumps: number, skipCombat: boolean): { ok: boolean; reason?: string } {
  // Skip combat missions
  if (skipCombat && isCombatMission(mission)) {
    return { ok: false, reason: "combat mission" };
  }

  const creditReward = mission.rewards.find(r => r.type === "credits")?.amount ?? 0;

  // Check travel distance
  const targetSystem = findMissionTargetSystem(mission);
  let totalJumps = 0;
  if (targetSystem) {
    const jumps = estimateJumps(ctx, targetSystem);
    if (jumps > maxJumps) {
      return { ok: false, reason: `too far (${jumps} jumps)` };
    }
    if (jumps === Infinity) {
      return { ok: false, reason: "unreachable system" };
    }
    if (!hasFuelForJumps(ctx, jumps)) {
      const fuelNeeded = jumps * 2 * ctx.nav.estimateJumpFuel(ctx.ship) + 2;
      return { ok: false, reason: `not enough fuel (need ${fuelNeeded}, have ${ctx.ship.fuel})` };
    }
    totalJumps = jumps;

    // Check reward vs travel cost — don't accept missions that cost more to complete than they pay
    const tripCost = estimateTripCost(ctx, jumps);
    if (creditReward > 0 && tripCost >= creditReward) {
      return { ok: false, reason: `unprofitable (reward ${creditReward}cr < trip cost ~${tripCost}cr)` };
    }
  }

  // ── Trade mission shortcut (v0.241.0) ──
  // Trade missions have sourceBase + destinationBase + buyPrice/sellPrice on the mission itself.
  // If the API gives us estimated profit, trust it; otherwise compute from buy/sell prices.
  if (isTradeTypeMission(mission)) {
    // Discount sell price by 25% — mission estimates are often optimistic (actual prices can be much lower)
    const sellPrice = (mission.sellPrice ?? 0) * 0.75;
    const buyPrice = mission.buyPrice ?? 0;
    const qty = mission.requiredQuantity ?? mission.objectives[0]?.target ?? 1;
    const profit = (sellPrice - buyPrice) * qty;
    if (profit <= 0) return { ok: false, reason: `trade mission unprofitable after 25% safety margin (buy ${buyPrice}, sell est. ${mission.sellPrice})` };

    // Check travel distance to source + destination
    const srcSystem = mission.sourceSystem ?? findMissionTargetSystem(mission);
    const dstSystem = mission.destinationSystem ?? srcSystem;
    const jumpsToSrc = estimateJumps(ctx, srcSystem);
    const jumpsSrcToDst = srcSystem && dstSystem && srcSystem !== dstSystem
      ? (ctx.galaxy.findPath(srcSystem, dstSystem)?.length ?? Infinity) - 1
      : 0;
    const totalTradeJumps = jumpsToSrc + jumpsSrcToDst;
    if (totalTradeJumps > maxJumps) return { ok: false, reason: `trade route too far (${totalTradeJumps} jumps)` };
    if (!hasFuelForJumps(ctx, totalTradeJumps + jumpsSrcToDst)) return { ok: false, reason: "not enough fuel for trade route" };

    // Check if we can afford the FULL buy (partial fills don't count — mission requires full quantity)
    const fullQuantity = mission.requiredQuantity ?? mission.objectives[0]?.target ?? 1;
    const buyCost = (mission.buyPrice ?? 0) * fullQuantity;
    if (buyCost <= 0) return { ok: false, reason: "trade mission with no buy price info" };
    if (buyCost > ctx.player.credits * 0.8) return { ok: false, reason: `can't afford full buy (${buyCost}cr, have ${ctx.player.credits}cr)` };

    // Check cargo space
    if (fullQuantity > ctx.ship.cargoCapacity) return { ok: false, reason: `cargo too small (need ${fullQuantity}, have ${ctx.ship.cargoCapacity})` };

    const tripCost = estimateTripCost(ctx, totalTradeJumps);
    if (profit - tripCost <= 0) return { ok: false, reason: `trade profit ${profit}cr doesn't cover fuel (~${tripCost}cr)` };

    return { ok: true };
  }

  // Estimate total item acquisition cost for profitability check
  let estimatedItemCost = 0;

  // Check all objectives for feasibility
  for (const obj of mission.objectives) {
    if (obj.complete) continue;
    const action = classifyObjective(obj);

    // Check objective-level target system
    if (obj.systemId) {
      const objJumps = estimateJumps(ctx, obj.systemId);
      if (objJumps > maxJumps) return { ok: false, reason: `objective too far (${objJumps} jumps)` };
      if (objJumps === Infinity) return { ok: false, reason: "objective in unreachable system" };
      if (objJumps > totalJumps) totalJumps = objJumps;
    }

    // Kill objectives: always skip
    if (action === "kill") {
      return { ok: false, reason: "combat objective" };
    }

    // Unknown objectives: skip — generic approach almost never works
    if (action === "unknown") {
      return { ok: false, reason: "unrecognized objective type" };
    }

    // Survey objectives: check if bot has a survey scanner module
    if (action === "survey") {
      const hasSurveyScanner = ctx.ship.modules.some((m) => m.moduleId.includes("survey"));
      if (!hasSurveyScanner) return { ok: false, reason: "no survey scanner equipped" };
    }

    // Mine objectives: check if bot has a mining laser
    if (action === "mine") {
      const hasMiningLaser = ctx.ship.modules.some((m) => m.moduleId.includes("mining"));
      if (!hasMiningLaser) return { ok: false, reason: "no mining laser equipped" };
    }

    // Deliver objectives: check item sourcing feasibility + cost
    if (action === "deliver") {
      if (obj.itemId) {
        const need = obj.target - obj.progress;
        const have = ctx.ship.cargo.find(c => c.itemId === obj.itemId)?.quantity ?? 0;
        if (have < need) {
          const shortfall = need - have;
          // Estimate buy cost for profitability check
          const unitPrice = ctx.crafting.getItemBasePrice(obj.itemId);
          if (unitPrice > 0) {
            estimatedItemCost += unitPrice * shortfall;
          }
          // Zero-price or unknown items: still allow if reward covers trip cost
          // (faction storage may have them, or they can be mined cheaply)
        }
      } else {
        // Deliver objective with no item ID — can't determine what to deliver
        return { ok: false, reason: "deliver objective with no item specified" };
      }
    }

    // Buy/collect objectives: estimate cost
    if (action === "buy" || action === "collect") {
      if (obj.itemId) {
        const need = obj.target - obj.progress;
        const unitPrice = ctx.crafting.getItemBasePrice(obj.itemId);
        if (unitPrice > 0) {
          estimatedItemCost += unitPrice * need;
        }
        // If no price known, still risky but allow (might be cheap/free)
      }
    }

    // Craft objectives: check recipe exists and ingredients are obtainable
    if (action === "craft") {
      if (!obj.itemId) return { ok: false, reason: "craft objective with no target item" };
      const recipes = ctx.crafting.getAllRecipes();
      const recipe = recipes.find(r => r.outputItem === obj.itemId);
      if (!recipe) return { ok: false, reason: `no recipe for ${obj.itemId}` };
      // Estimate ingredient costs
      for (const ing of recipe.ingredients) {
        const need = ing.quantity * (obj.target - obj.progress);
        const unitPrice = ctx.crafting.getItemBasePrice(ing.itemId);
        estimatedItemCost += unitPrice * need;
      }
    }
  }

  // ── Profitability check: total cost vs reward ──
  const totalTripCost = estimateTripCost(ctx, totalJumps);
  const totalCost = totalTripCost + estimatedItemCost;
  if (creditReward > 0 && totalCost >= creditReward * 0.8) {
    // Mission costs ≥80% of reward — not worth the risk
    return { ok: false, reason: `low profit (reward ${creditReward}cr, est. cost ~${Math.round(totalCost)}cr)` };
  }
  // Zero-reward missions: only accept if they're zero-cost (travel/survey only)
  if (creditReward === 0 && estimatedItemCost > 0) {
    return { ok: false, reason: "no credit reward but requires spending" };
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

  // Track abandoned mission titles to prevent re-acceptance loops
  const abandonedTitles = new Set<string>();

  // Auto-discover hub station
  if (!hubStation) {
    if (ctx.player.dockedAtBase) {
      hubStation = ctx.player.dockedAtBase;
    } else {
      try {
        const system = await fleetGetSystem(ctx);
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
      ctx.setActiveMissions(activeMissions.map(m => ({
        id: m.id, title: m.title, type: m.type,
        objectives: m.objectives.map(o => ({ description: o.description, progress: o.progress, target: o.target, complete: o.complete })),
      })));
    } catch { /* ok, will browse new ones */ }

    // Resume an active mission if we have one (check feasibility first)
    const activeMission = activeMissions.find(m => {
      if (!m.objectives.some(o => !o.complete)) return false;
      if (abandonedTitles.has(m.title)) return false;
      const check = canCompleteMission(ctx, m, maxJumps, skipCombat);
      return check.ok;
    });
    if (activeMission) {
      yield `resuming active mission: ${activeMission.title}`;
      const result = yield* executeMission(ctx, activeMission, hubStation);
      if (result === "stop") return;
      if (result === "failed") {
        abandonedTitles.add(activeMission.title);
        yield `will not re-accept "${activeMission.title}" this session`;
      }
      yield typedYield("cycle_complete", { type: "cycle_complete", botId: ctx.botId, routine: "mission_runner" });
      continue;
    }

    // Abandon infeasible active missions (equipment missing, too far, etc.)
    for (const m of activeMissions) {
      if (m.objectives.every(o => o.complete)) continue;
      const check = canCompleteMission(ctx, m, maxJumps, skipCombat);
      if (!check.ok) {
        yield `abandoning infeasible mission: ${m.title} (${check.reason})`;
        try { await ctx.api.abandonMission(m.id); } catch { /* ok */ }
      }
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

    // Filter out previously abandoned missions (prevents accept→fail→re-accept loops)
    if (abandonedTitles.size > 0) {
      candidates = candidates.filter((m) => !abandonedTitles.has(m.title));
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
    // Prefer: highest net profit per effort (reward minus travel cost, divided by effort)
    feasible.sort((a, b) => {
      const rewardA = a.mission.rewards.find((r) => r.type === "credits")?.amount ?? 0;
      const rewardB = b.mission.rewards.find((r) => r.type === "credits")?.amount ?? 0;

      const jumpsA = estimateJumps(ctx, findMissionTargetSystem(a.mission));
      const jumpsB = estimateJumps(ctx, findMissionTargetSystem(b.mission));

      // Trade missions: use estimated profit directly (more reliable than reward field)
      const tradeProfitA = isTradeTypeMission(a.mission) ? (a.mission.estimatedProfit ?? 0) : 0;
      const tradeProfitB = isTradeTypeMission(b.mission) ? (b.mission.estimatedProfit ?? 0) : 0;

      // Net profit = reward minus estimated fuel cost (+ trade profit bonus)
      const netA = rewardA + tradeProfitA - estimateTripCost(ctx, jumpsA);
      const netB = rewardB + tradeProfitB - estimateTripCost(ctx, jumpsB);

      // Score: net profit per estimated effort (jumps + objectives)
      // Trade missions get effort=1 since they're a single buy→sell flow
      const effortA = isTradeTypeMission(a.mission) ? Math.max(1, jumpsA) : Math.max(1, jumpsA + a.mission.objectives.length);
      const effortB = isTradeTypeMission(b.mission) ? Math.max(1, jumpsB) : Math.max(1, jumpsB + b.mission.objectives.length);

      const scoreA = netA / effortA;
      const scoreB = netB / effortB;

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
    if (result === "failed") {
      abandonedTitles.add(best.title);
      yield `will not re-accept "${best.title}" this session`;
    }

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

  // ── Trade mission fast-path: buy at source → sell at dest → complete ──
  if (isTradeTypeMission(mission)) {
    yield `trade mission: buy ${mission.requiredItem} at ${mission.sourceBase} → sell at ${mission.destinationBase}`;
    const success = yield* handleTradeObjective(ctx, mission);
    if (!success) {
      yield "trade mission failed — abandoning";
      try { await ctx.api.abandonMission(mission.id); } catch { /* ok */ }
      return "failed";
    }
    // Try to complete after trade
    yield* completeMission(ctx, mission, hubStation);
    return "done";
  }

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
      // Mission disappeared — might have been auto-completed, or API inconsistency
      yield "mission no longer active (may be complete)";
      return cycles <= 1 ? "failed" : "done";
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
    case "trade":
      return yield* handleTradeObjective(ctx, mission);
    case "kill":
      // Should have been filtered out, but handle gracefully
      yield "skipping combat objective";
      return false;
    case "unknown":
      // Unknown objectives are filtered out in canCompleteMission, but handle gracefully
      yield `unrecognized objective: "${obj.description}" — skipping`;
      return false;
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
  const system = await fleetGetSystem(ctx);
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
  // Some missions report target=1 (completion count) while needing many units — use cargo space as guide
  const remaining = obj.target - obj.progress;
  const cargoSpace = Math.max(1, ctx.ship.cargoCapacity - ctx.ship.cargoUsed);
  const mineCycles = remaining <= 1 ? Math.min(10, cargoSpace) : Math.min(10, remaining);
  for (let i = 0; i < mineCycles; i++) {
    if (ctx.shouldStop) return true;
    yield `mining (${i + 1}/${mineCycles})`;
    try {
      await ctx.api.mine();
      await ctx.refreshState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield `mine failed: ${msg}`;
      // Cargo full — offload before retrying
      if (msg.includes("cargo_full")) {
        yield* offloadMissionCargo(ctx, obj, belt);
        continue; // Retry mining after offload
      }
      break;
    }
    // Check if cargo is getting full — dock and sell/deposit
    if (ctx.ship.cargoUsed / ctx.ship.cargoCapacity > 0.85) {
      yield* offloadMissionCargo(ctx, obj, belt);
    }
  }

  return true;
}

/** Offload non-mission cargo to make room for mining */
async function* offloadMissionCargo(
  ctx: BotContext,
  obj: MissionObjective,
  belt: { id: string; name?: string },
): AsyncGenerator<RoutineYield, void, void> {
  yield "cargo full, docking to offload";
  try {
    await findAndDock(ctx);
    await ctx.refreshState();

    const missionItemId = obj.itemId;
    const cargoSnapshot = [...ctx.ship.cargo];

    // Phase 1: Sell/deposit/jettison non-mission items
    let offloaded = 0;
    for (const item of cargoSnapshot) {
      if (item.quantity <= 0) continue;
      if (missionItemId && item.itemId === missionItemId) continue; // Keep mission items
      try {
        await ctx.api.sell(item.itemId, item.quantity);
        offloaded += item.quantity;
      } catch {
        try {
          await ctx.api.factionDepositItems(item.itemId, item.quantity);
          offloaded += item.quantity;
        } catch {
          try {
            await ctx.api.jettison(item.itemId, item.quantity);
            offloaded += item.quantity;
          } catch (err) {
            yield `could not offload ${item.quantity} ${item.itemId}: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }

    await ctx.refreshState();

    // Phase 2: If cargo still full (all mission items), deposit excess mission items
    // Keep only what we need for the objective, deposit/sell the rest
    if (!ctx.cargo.hasSpace(ctx.ship, 1) && missionItemId) {
      const missionCargo = ctx.ship.cargo.find(c => c.itemId === missionItemId);
      if (missionCargo && missionCargo.quantity > 0) {
        const needed = Math.max(0, obj.target - obj.progress);
        const excess = missionCargo.quantity - needed;
        if (excess > 0) {
          yield `depositing ${excess} excess ${missionItemId} (have ${missionCargo.quantity}, need ${needed})`;
          try {
            await ctx.api.factionDepositItems(missionItemId, excess);
            offloaded += excess;
          } catch {
            try {
              await ctx.api.sell(missionItemId, excess);
              offloaded += excess;
            } catch { /* keep trying */ }
          }
          await ctx.refreshState();
        } else if (needed <= 0) {
          // Already have enough — no need to mine more, just return
          yield `already have ${missionCargo.quantity} ${missionItemId} (need ${obj.target})`;
        }
      }
    }

    yield `offloaded ${offloaded} items`;

    // Undock and return to belt
    try { await ctx.api.undock(); await ctx.refreshState(); } catch { /* ok */ }
    if (ctx.player.currentPoi !== belt.id) {
      try { await ctx.api.travel(belt.id); await ctx.refreshState(); } catch { /* ok */ }
    }
  } catch (err) {
    yield `offload failed: ${err instanceof Error ? err.message : String(err)}`;
  }
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
      if (!ctx.player.dockedAtBase) {
        try { await findAndDock(ctx); } catch { /* ok */ }
      }
      if (ctx.player.dockedAtBase) {
        const shortfall = need - have;
        // Try faction storage first (free, we have massive ore stockpiles)
        yield `need ${shortfall} more ${requiredItem}, checking faction storage`;
        try {
          await ctx.api.factionWithdrawItems(requiredItem, shortfall);
          await ctx.refreshState();
        } catch { /* not in faction storage */ }

        // Try personal storage
        const haveNow1 = ctx.ship.cargo.find(c => c.itemId === requiredItem)?.quantity ?? 0;
        if (haveNow1 < need) {
          try {
            await ctx.api.withdrawItems(requiredItem, need - haveNow1);
            await ctx.refreshState();
          } catch { /* not in personal storage */ }
        }

        // Try to buy as last resort
        const haveNow2 = ctx.ship.cargo.find(c => c.itemId === requiredItem)?.quantity ?? 0;
        if (haveNow2 < need) {
          yield `buying ${need - haveNow2} ${requiredItem}`;
          try {
            await ctx.api.buy(requiredItem, need - haveNow2);
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


/** Trade objective: buy at source, sell at destination (v0.241.0 trade missions) */
async function* handleTradeObjective(
  ctx: BotContext,
  mission: Mission,
): AsyncGenerator<RoutineYield, boolean, void> {
  // Trade missions may encode route in mission fields OR in the objective
  const obj = mission.objectives[0];
  const sourceBase = mission.sourceBase ?? findMissionIssuingBase(mission);
  const destBase = mission.destinationBase ?? mission.targetBase ?? obj?.baseId;
  const itemId = mission.requiredItem ?? obj?.itemId;
  const quantity = mission.requiredQuantity ?? obj?.target ?? 1;

  if (!sourceBase || !destBase || !itemId) {
    yield "trade mission missing source/dest/item — treating as deliver";
    return false;
  }

  // ── Phase 1: Navigate to source and buy ──
  if (ctx.player.dockedAtBase !== sourceBase) {
    yield `heading to source station for ${itemId}`;
    try {
      await navigateAndDock(ctx, sourceBase);
    } catch (err) {
      yield `nav to source failed: ${err instanceof Error ? err.message : String(err)}`;
      return false;
    }
  }

  // Check cargo space — make room if needed
  const freeSpace = ctx.ship.cargoCapacity - ctx.ship.cargoUsed;
  if (freeSpace < quantity) {
    yield `clearing ${quantity - freeSpace} cargo slots`;
    for (const item of [...ctx.ship.cargo]) {
      if (item.itemId === "fuel_cell" || item.quantity <= 0) continue;
      try {
        await ctx.api.sell(item.itemId, item.quantity);
        await ctx.refreshState();
      } catch {
        try { await ctx.api.factionDepositItems(item.itemId, item.quantity); await ctx.refreshState(); } catch { /* ok */ }
      }
      if (ctx.ship.cargoCapacity - ctx.ship.cargoUsed >= quantity) break;
    }
  }

  // Buy the required items
  const alreadyHave = ctx.ship.cargo.find(c => c.itemId === itemId)?.quantity ?? 0;
  const toBuy = Math.max(0, quantity - alreadyHave);
  if (toBuy > 0) {
    // Cap buy to what we can afford (leave 5% credits buffer)
    const maxAffordable = mission.buyPrice
      ? Math.floor((ctx.player.credits * 0.95) / mission.buyPrice)
      : toBuy;
    const buyQty = Math.min(toBuy, maxAffordable);
    if (buyQty <= 0) {
      yield `can't afford to buy ${itemId} at ${mission.buyPrice}cr each`;
      return false;
    }
    yield `buying ${buyQty} ${itemId}`;
    try {
      await ctx.api.buy(itemId, buyQty);
      await ctx.refreshState();
    } catch (err) {
      yield `buy failed: ${err instanceof Error ? err.message : String(err)}`;
      // Try with less quantity
      if (buyQty > 1) {
        const halfQty = Math.ceil(buyQty / 2);
        try { await ctx.api.buy(itemId, halfQty); await ctx.refreshState(); } catch { return false; }
      } else {
        return false;
      }
    }
  }

  // ── Phase 2: Navigate to destination and sell ──
  if (ctx.player.dockedAtBase) {
    try { await ctx.api.undock(); await ctx.refreshState(); } catch { /* ok */ }
  }

  yield `heading to destination to sell ${itemId}`;
  try {
    await navigateAndDock(ctx, destBase);
  } catch (err) {
    yield `nav to destination failed: ${err instanceof Error ? err.message : String(err)}`;
    // Emergency: sell at current location if possible
    if (!ctx.player.dockedAtBase) {
      try { await findAndDock(ctx); } catch { return false; }
    }
    const held = ctx.ship.cargo.find(c => c.itemId === itemId)?.quantity ?? 0;
    if (held > 0) {
      try { await ctx.api.sell(itemId, held); await ctx.refreshState(); } catch { /* ok */ }
    }
    return false;
  }

  // Sell the trade items
  const held = ctx.ship.cargo.find(c => c.itemId === itemId)?.quantity ?? 0;
  if (held > 0) {
    yield `selling ${held} ${itemId}`;
    try {
      await ctx.api.sell(itemId, held);
      await ctx.refreshState();
    } catch (err) {
      yield `sell failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return true;
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
    const creditsBefore = ctx.player.credits;
    await ctx.api.completeMission(mission.id);
    await ctx.refreshState();
    const reward = mission.rewards.find((r) => r.type === "credits");
    const earned = ctx.player.credits - creditsBefore;
    yield `mission complete! ${reward ? `+${reward.amount}cr` : ""}`;
    // Pay faction tax on mission rewards
    if (earned > 0 && ctx.player.dockedAtBase) {
      const tax = await payFactionTax(ctx, earned);
      if (tax.message) yield tax.message;
    }
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
