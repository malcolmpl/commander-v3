/**
 * Scoring brain - deterministic Commander implementation.
 * Scores every bot × routine combination and assigns the best fits.
 */

import type { Goal } from "../config/schema";
import type { RoutineName } from "../types/protocol";
import type { FleetBotInfo, FleetStatus } from "../bot/types";
import type {
  CommanderBrain,
  EvaluationInput,
  EvaluationOutput,
  Assignment,
  BotScore,
  StrategyWeights,
  EconomySnapshot,
  WorldContext,
  SupplyDeficit,
  ReassignmentState,
} from "./types";
// TradeRoute import removed — traders now use faction-sell-only mode
import type { PendingUpgrade } from "./types";
import type { ShipClass } from "../types/game";
import { scoreShipForRole, LEGACY_SHIPS } from "../core/ship-fitness";
import { getStrategyWeights } from "./strategies";

const ALL_ROUTINES: RoutineName[] = [
  "miner", "crafter", "trader", "quartermaster", "explorer",
  "return_home", "scout", "ship_upgrade", "refit",
  "harvester", "hunter", "salvager", "scavenger", "mission_runner",
];

/** Routines that operate in the field and should not be interrupted for return_home */
const FIELD_ROUTINES: Set<RoutineName> = new Set(["trader", "hunter", "explorer"]);

/** Maximum concurrent bots per routine (enforced in greedy assignment loop) */
/** Note: explorer scales with fleet size — see getMaxCount() */
const ROUTINE_MAX_COUNT: Partial<Record<RoutineName, number>> = {
  scout: 1,
  explorer: 1, // Default; overridden by getMaxCount() for larger fleets
  quartermaster: 1, // Only one faction home manager
  crafter: 3,      // Allow more crafters — high-end product focus with saturation guards
  scavenger: 1,    // One scavenger roaming at a time
  hunter: 1,       // Cap combat bots — burns fuel with unreliable returns
  salvager: 1,     // One salvager at a time
  ship_upgrade: 1, // One upgrade at a time fleet-wide
  refit: 2,        // Max 2 refitting at once — one-shot, quick
};

/** Dynamic max count: scales explorer cap with fleet size */
function getMaxCount(routine: RoutineName, fleetSize: number): number | undefined {
  if (routine === "explorer") {
    // 1 explorer for 1-5 bots, 2 for 6+ bots
    return fleetSize >= 6 ? 2 : 1;
  }
  return ROUTINE_MAX_COUNT[routine];
}

/** Scoring configuration */
export interface ScoringConfig {
  /** Base score per routine (tunable defaults) */
  baseScores: Record<RoutineName, number>;
  /** Supply deficit multiplier */
  supplyMultiplier: number;
  /** Skill match bonus */
  skillBonus: number;
  /** Switch cost per estimated tick */
  switchCostPerTick: number;
  /** Diversity penalty when > N bots on same routine */
  diversityThreshold: number;
  /** Diversity penalty amount per extra bot */
  diversityPenaltyPerBot: number;
  /** Min score improvement to trigger reassignment (0-1) */
  reassignmentThreshold: number;
  /** Cooldown in ms before a bot can be reassigned */
  reassignmentCooldownMs: number;
}

const DEFAULT_CONFIG: ScoringConfig = {
  baseScores: {
    miner: 70,        // TOP PRIORITY: feeds supply chain with ore → faction storage
    harvester: 45,    // Multi-target extraction (ice/gas), lower than miner
    trader: 55,       // Arbitrage trading — buys low, sells high using market data
    explorer: 40,     // Charts systems, data gathering — useful but no direct revenue
    crafter: 75,      // TOP PRIORITY: converts ore → high-end goods → faction storage
    hunter: 10,       // SUPPRESSED: burns fuel, unreliable returns
    salvager: 10,     // SUPPRESSED: burns fuel
    mission_runner: 50, // Reliable income: smart mission selection, skips combat, refreshes market data
    return_home: 5,     // Utility routine — only for idle bots away from home
    scout: 10,          // One-shot data gathering — scored high only when data is needed
    quartermaster: 40,  // Faction home manager — sells crafted goods, reliable revenue
    scavenger: 10,      // SUPPRESSED: burns fuel, unreliable
    ship_upgrade: 0,    // Only scores > 0 when Commander queues an upgrade
    refit: 0,           // Only scores > 0 when bot has suboptimal modules for role
  },
  supplyMultiplier: 15,
  skillBonus: 10,
  switchCostPerTick: 5,
  diversityThreshold: 4,     // Allow up to 4 bots on same routine before penalty
  diversityPenaltyPerBot: 15, // Gentler penalty — we want miner/crafter heavy
  reassignmentThreshold: 0.3,
  reassignmentCooldownMs: 300_000, // 5 minutes — enough for 1-2 full routine cycles
};

export class ScoringBrain implements CommanderBrain {
  private config: ScoringConfig;
  private reassignmentState = new Map<string, ReassignmentState>();
  /** Persistent tracking of active miner/harvester → belt assignments across eval cycles */
  private activeBeltAssignments = new Map<string, string>(); // botId → beltPoiId

  constructor(config?: Partial<ScoringConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Update config dynamically (e.g., from dashboard settings) */
  updateConfig(partial: Partial<ScoringConfig>): void {
    Object.assign(this.config, partial);
  }

  /**
   * Evaluate the fleet and produce assignments.
   * Core algorithm:
   * 1. Get strategy weights from active goals
   * 2. Score every bot × routine combination
   * 3. Greedy assignment (highest score first)
   * 4. Respect cooldowns and thresholds
   */
  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    const { fleet, goals, economy, world, tick } = input;
    const startTime = Date.now();
    const now = startTime;

    // Only evaluate ready/running bots
    const candidates = fleet.bots.filter(
      (b) => b.status === "ready" || b.status === "running"
    );

    // Clean up stale belt assignments: remove bots no longer mining
    for (const [botId] of this.activeBeltAssignments) {
      const bot = fleet.bots.find((b) => b.botId === botId);
      if (!bot || (bot.routine !== "miner" && bot.routine !== "harvester")) {
        this.activeBeltAssignments.delete(botId);
      }
    }

    if (candidates.length === 0) {
      return { assignments: [], reasoning: "No bots available for assignment.", brainName: "scoring", latencyMs: Date.now() - startTime, confidence: 1.0 };
    }

    // Clear cooldowns for bots stuck on over-cap routines
    // (e.g., 4 bots on scout when max is 1 — 3 need to be freed immediately)
    // Also check lastRoutine for idle bots (between cycles, b.routine is null)
    const fleetSize = candidates.length;
    for (const routine of Object.keys(ROUTINE_MAX_COUNT) as RoutineName[]) {
      const maxCount = getMaxCount(routine, fleetSize)!;
      const botsOnRoutine = candidates.filter(
        (b) => b.routine === routine || (!b.routine && b.lastRoutine === routine)
      );
      if (botsOnRoutine.length > maxCount) {
        // Keep the first N, clear cooldowns on the rest so they can be reassigned
        for (let i = maxCount; i < botsOnRoutine.length; i++) {
          this.clearCooldown(botsOnRoutine[i].botId);
        }
      }
    }

    // Get strategy weights from goals
    const weights = getStrategyWeights(goals);

    // Pre-filter routines that can never win (saves 30-50% of scoring work)
    const activeRoutines = ALL_ROUTINES.filter((r) => {
      // ship_upgrade: skip entirely if no pending upgrades
      if (r === "ship_upgrade" && this.pendingUpgrades.size === 0) return false;
      // refit: skip if no bots have suboptimal modules
      if (r === "refit" && !this.anyBotNeedsRefit(candidates, economy)) return false;
      // quartermaster: needs homeBase and 3+ bots
      if (r === "quartermaster" && (!this.homeBase || fleetSize < 3)) return false;
      // scout: only useful when homeSystem is known but data is missing
      if (r === "scout" && this.homeBase && world?.hasAnyMarketData) return false;
      return true;
    });

    // Score all bot × routine combinations
    const allScores: BotScore[] = [];
    for (const bot of candidates) {
      for (const routine of activeRoutines) {
        const score = this.scoreAssignment(bot, routine, weights, economy, fleet, world);
        allScores.push(score);
      }
    }

    // Greedy assignment: pick best score for each bot
    const assignments: Assignment[] = [];
    const assignedBots = new Set<string>();
    const routineCounts = new Map<RoutineName, number>();

    // Count current routine distribution (from previous cycle)
    for (const bot of fleet.bots) {
      if (bot.routine) {
        routineCounts.set(bot.routine, (routineCounts.get(bot.routine) ?? 0) + 1);
      }
    }

    // Track routines assigned THIS cycle for dynamic diversity
    const cycleRoutineCounts = new Map<RoutineName, number>();

    // Sort scores descending
    allScores.sort((a, b) => b.finalScore - a.finalScore);

    // Assign each bot to its best routine, respecting diversity.
    // Two-pass: first let bots keep current routines within diversity threshold,
    // then assign remaining bots using per-bot best-adjusted-score.

    // Helper: lock a bot to a routine — if idle, create an assignment to restart it
    const lockBot = (bot: FleetBotInfo, routine: RoutineName) => {
      assignedBots.add(bot.botId);
      cycleRoutineCounts.set(routine, (cycleRoutineCounts.get(routine) ?? 0) + 1);
      // Idle bots need an actual assignment to restart their routine
      if (!bot.routine) {
        // One-shot routines shouldn't be restarted — let them fall through to Pass 2
        const oneShot: RoutineName[] = ["ship_upgrade", "scout", "return_home", "refit"];
        if (oneShot.includes(routine)) {
          // Undo the lock — let Pass 2 pick a new routine
          assignedBots.delete(bot.botId);
          cycleRoutineCounts.set(routine, (cycleRoutineCounts.get(routine) ?? 0) - 1);
          // Clear the cooldown so Pass 2 can assign freely
          this.reassignmentState.delete(bot.botId);
          return;
        }
        assignments.push({
          botId: bot.botId,
          routine,
          params: this.buildParams(routine, bot, economy, goals, assignments, world),
          score: 0,
          reasoning: `Cooldown: continue as ${routine}`,
          previousRoutine: routine,
        });
      }
    };

    // Pass 0: Lock bots still on cooldown — they keep their current/last routine unconditionally.
    // Uses lastRoutine for idle bots so finishing a cycle doesn't reset the cooldown.
    // Exception: if the routine rapid-completed, don't lock — let Pass 2 find something better.
    // Exception: if the routine is at max count, don't lock — clear cooldown for Pass 2.
    for (const bot of candidates) {
      const effectiveRoutine = (bot.routine ?? bot.lastRoutine) as RoutineName | null;
      if (!effectiveRoutine) continue;
      if (!this.canReassign(bot.botId, now)) {
        // Don't lock idle bots to routines that keep rapid-completing — that creates infinite loops
        if (!bot.routine && bot.rapidRoutines.has(effectiveRoutine)) {
          this.clearCooldown(bot.botId); // Free them for Pass 2
          continue;
        }
        // Don't lock past max count — free excess bots for Pass 2
        const maxCount = getMaxCount(effectiveRoutine, fleetSize);
        if (maxCount !== undefined) {
          const alreadyLocked = cycleRoutineCounts.get(effectiveRoutine) ?? 0;
          if (alreadyLocked >= maxCount) {
            this.clearCooldown(bot.botId);
            continue;
          }
        }
        lockBot(bot, effectiveRoutine);
      }
    }

    // Pass 1: Auto-continue bots already on a routine within diversity threshold.
    // Uses lastRoutine for idle bots so they're treated as still in that role.
    // When more bots want the same routine than the threshold allows, keep the
    // NEWEST assignments (they just switched) and rotate OUT the longest-running
    // ones (only those whose cooldown has expired).
    const routineGroups = new Map<RoutineName, FleetBotInfo[]>();
    for (const bot of candidates) {
      const effectiveRoutine = bot.routine ?? bot.lastRoutine;
      if (!effectiveRoutine) continue;
      if (assignedBots.has(bot.botId)) continue; // Already locked by cooldown
      const routine = effectiveRoutine as RoutineName;
      const group = routineGroups.get(routine) ?? [];
      group.push(bot);
      routineGroups.set(routine, group);
    }

    for (const [routine, bots] of routineGroups) {
      const maxCount = getMaxCount(routine, fleetSize);
      const lockedCount = cycleRoutineCounts.get(routine) ?? 0; // Bots locked by cooldown
      const threshold = maxCount !== undefined ? Math.min(maxCount, this.config.diversityThreshold) : this.config.diversityThreshold;
      const slotsLeft = Math.max(0, threshold - lockedCount);

      if (bots.length <= slotsLeft) {
        // All fit within remaining threshold — keep them all
        for (const bot of bots) {
          lockBot(bot, routine);
        }
      } else if (slotsLeft > 0) {
        // More bots than remaining slots — keep newest, rotate out oldest
        bots.sort((a, b) => {
          const aTime = this.reassignmentState.get(a.botId)?.lastAssignment ?? 0;
          const bTime = this.reassignmentState.get(b.botId)?.lastAssignment ?? 0;
          return aTime - bTime; // oldest first
        });
        const keepers = bots.slice(bots.length - slotsLeft);
        const rotatedOut = bots.slice(0, bots.length - slotsLeft);
        for (const bot of keepers) {
          lockBot(bot, routine);
        }
        if (rotatedOut.length > 0) {
          console.log(`[Commander] Diversity: ${routine} has ${bots.length + lockedCount}/${threshold} — rotating out [${rotatedOut.map(b => b.botId).join(",")}]`);
        }
      } else {
        // All slots taken by cooldown-locked bots — rotate out everyone
        console.log(`[Commander] Diversity: ${routine} slots full (${lockedCount} locked) — rotating out [${bots.map(b => b.botId).join(",")}]`);
      }
    }

    // Pass 2: Assign remaining bots to best available routine (diversity-adjusted).
    // These bots were excluded from Pass 1 because their routine is over-represented.
    // They MUST switch — skip their current routine entirely.
    // KEY: Evaluate ALL valid routines and pick the highest ADJUSTED score,
    // not the first positive one (which would ignore diversity penalties).
    for (const bot of candidates) {
      if (assignedBots.has(bot.botId)) continue;

      const effectiveRoutine = bot.routine ?? bot.lastRoutine;
      // This bot's current routine is over the diversity threshold — must switch
      const mustSwitch = effectiveRoutine && (cycleRoutineCounts.get(effectiveRoutine as RoutineName) ?? 0) >= this.config.diversityThreshold;

      // Get this bot's scores
      const botScores = allScores.filter((s) => s.botId === bot.botId);

      // Find the best ADJUSTED score across all valid routines
      let bestScore: BotScore | null = null;
      let bestAdjusted = -Infinity;

      for (const score of botScores) {
        // Skip current routine if bot must switch for diversity
        if (mustSwitch && score.routine === effectiveRoutine) continue;

        // Hard cap: skip if this routine has reached its max count this cycle
        // Exception: free ship switches (alreadyOwned) bypass the cap — they're instant
        const maxCount = getMaxCount(score.routine, fleetSize);
        if (maxCount !== undefined) {
          const alreadyAssigned = cycleRoutineCounts.get(score.routine) ?? 0;
          if (alreadyAssigned >= maxCount) {
            // Allow alreadyOwned ship switches through even when cap is hit
            if (score.routine === "ship_upgrade") {
              const pending = this.pendingUpgrades.get(bot.botId);
              if (pending?.alreadyOwned) { /* exempt — free switch */ }
              else continue;
            } else {
              continue;
            }
          }
        }

        // Dynamic diversity: penalize routines already assigned this cycle
        const cycleCount = cycleRoutineCounts.get(score.routine) ?? 0;
        const adjustedScore = score.finalScore - (cycleCount * this.config.diversityPenaltyPerBot);

        // Track the best adjusted score (not just the first valid one)
        // Allow negative scores — better to assign something than leave bot idle
        if (adjustedScore > bestAdjusted) {
          bestScore = score;
          bestAdjusted = adjustedScore;
        }
      }

      if (bestScore) {
        const cycleCount = cycleRoutineCounts.get(bestScore.routine) ?? 0;
        console.log(`[Commander] Pass2: ${bestScore.botId} ${effectiveRoutine ?? "idle"} → ${bestScore.routine} (adjusted=${bestAdjusted.toFixed(0)}, mustSwitch=${mustSwitch})`);
        assignments.push({
          botId: bestScore.botId,
          routine: bestScore.routine,
          params: this.buildParams(bestScore.routine, bot, economy, goals, assignments, world),
          score: bestAdjusted,
          reasoning: bestScore.reasoning,
          previousRoutine: effectiveRoutine,
        });

        assignedBots.add(bestScore.botId);
        cycleRoutineCounts.set(bestScore.routine, cycleCount + 1);

        // Track reassignment — always set cooldown so the bot gets time to work
        this.reassignmentState.set(bestScore.botId, {
          lastAssignment: now,
          lastRoutine: bestScore.routine,
          cooldownUntil: now + this.config.reassignmentCooldownMs,
        });
      }
    }

    // Log top scores per bot for diagnostics (only when assignments changed)
    if (assignments.length > 0) {
      for (const bot of candidates) {
        const botScores = allScores
          .filter((s) => s.botId === bot.botId)
          .sort((a, b) => b.finalScore - a.finalScore)
          .slice(0, 3);
        const scoreStr = botScores.map((s) => `${s.routine}=${s.finalScore.toFixed(0)}`).join(", ");
        console.log(`[Commander] ${bot.botId} (fuel=${bot.fuelPct.toFixed(0)}% mods=[${bot.moduleIds.join(",")}]): ${scoreStr}`);
      }
    }

    // Fallback: if any idle bot (no routine) wasn't assigned, force-assign the best available routine
    for (const bot of candidates) {
      if (assignedBots.has(bot.botId)) continue;
      if (bot.routine) continue; // Already running something

      // Find the best routine for this bot regardless of score
      const botScores = allScores
        .filter((s) => s.botId === bot.botId)
        .sort((a, b) => b.finalScore - a.finalScore);

      if (botScores.length > 0) {
        const best = botScores[0];
        console.log(`[Commander] Fallback: forcing ${bot.botId} → ${best.routine} (score ${best.finalScore.toFixed(0)})`);
        assignments.push({
          botId: bot.botId,
          routine: best.routine,
          params: this.buildParams(best.routine, bot, economy, goals, assignments, world),
          score: best.finalScore,
          reasoning: `fallback: ${best.reasoning}`,
          previousRoutine: null,
        });
        assignedBots.add(bot.botId);
      }
    }

    // Build reasoning summary
    const reasoning = this.buildReasoning(assignments, candidates, economy, goals);

    return { assignments, reasoning, brainName: "scoring", latencyMs: Date.now() - startTime, confidence: 1.0 };
  }

  /** Score a single bot × routine combination */
  scoreAssignment(
    bot: FleetBotInfo,
    routine: RoutineName,
    weights: StrategyWeights,
    economy: EconomySnapshot,
    fleet: FleetStatus,
    world?: WorldContext
  ): BotScore {
    // 1. Base score × strategy weight
    const baseScore = this.config.baseScores[routine] * weights[routine];

    // 2. Supply chain bonus: deficit detection boosts relevance
    const supplyBonus = this.calcSupplyBonus(routine, economy);

    // 3. Skill bonus: reward bots suited to the role
    const skillBonus = this.calcSkillBonus(bot, routine);

    // 4. Risk penalty based on bot's current location safety
    const riskPenalty = this.calcRiskPenalty(bot, routine);

    // 5. Switch cost: penalize if bot needs to change roles (0 for idle bots)
    const switchCost = !bot.routine ? 0 :
      bot.routine === routine ? 0 :
      (bot.docked ? 2 : 6) * this.config.switchCostPerTick;

    // 6. Diversity penalty: too many bots on same routine (capped to never exceed base score)
    const currentCount = fleet.bots.filter((b) => b.routine === routine && b.botId !== bot.botId).length;
    const rawDiversityPenalty = currentCount >= this.config.diversityThreshold
      ? (currentCount - this.config.diversityThreshold + 1) * this.config.diversityPenaltyPerBot
      : 0;
    const diversityPenalty = Math.min(rawDiversityPenalty, baseScore * 0.8); // Never exceed 80% of base

    // 7. Rapid completion penalty: routine recently failed to find work (completed in < 60s)
    //    Tracks ALL recently-failed routines (not just the last one) to prevent alternating failures
    const RAPID_EXPIRY_MS = 120_000; // 2 minutes (entries also auto-cleaned in bot getter)
    const rapidAt = bot.rapidRoutines.get(routine);
    const rapidPenalty = (rapidAt && (Date.now() - rapidAt) < RAPID_EXPIRY_MS)
      ? 80 // Moderate penalty — suppresses but doesn't kill all options
      : 0;

    // 8. Information scarcity bonus: uses world context for data-aware scoring
    //    Scaled by strategy weight so income goals suppress exploration bonuses
    const rawInfoBonus = this.calcInfoScarcityBonus(routine, economy, world);
    const infoBonus = rawInfoBonus * weights[routine];

    // 9. Equipment penalty: bot lacks required modules for the routine
    const equipmentPenalty = this.calcEquipmentPenalty(bot, routine);

    // 10. World penalty: system lacks POIs needed for the routine
    const worldPenalty = this.calcWorldPenalty(bot, routine, world);

    // 11. Faction storage bonus: supply chain awareness
    const factionBonus = this.calcFactionStorageBonus(routine, economy);

    // 12. Idle routine penalty: routines that need external inputs but have none configured
    const idlePenalty = this.calcIdleRoutinePenalty(routine, economy, fleet, bot);

    // 13. Data staleness penalty: penalize data-dependent routines when market data is old
    const stalenessPenalty = this.calcStalenessPenalty(routine, world);

    // 14. Market insight bonus: reward trader/QM when demand intelligence exists
    const insightBonus = this.calcMarketInsightBonus(routine, world);

    const finalScore = baseScore + supplyBonus + skillBonus + infoBonus + factionBonus + insightBonus - riskPenalty - switchCost - diversityPenalty - rapidPenalty - equipmentPenalty - worldPenalty - idlePenalty - stalenessPenalty;

    const parts = [`${routine}: base=${baseScore.toFixed(0)}`];
    if (supplyBonus > 0) parts.push(`supply=+${supplyBonus.toFixed(0)}`);
    if (skillBonus > 0) parts.push(`skill=+${skillBonus.toFixed(0)}`);
    if (infoBonus !== 0) parts.push(`info=${infoBonus > 0 ? "+" : ""}${infoBonus.toFixed(0)}`);
    if (factionBonus !== 0) parts.push(`faction=${factionBonus > 0 ? "+" : ""}${factionBonus.toFixed(0)}`);
    if (riskPenalty > 0) parts.push(`risk=-${riskPenalty.toFixed(0)}`);
    if (switchCost > 0) parts.push(`switch=-${switchCost.toFixed(0)}`);
    if (diversityPenalty > 0) parts.push(`diversity=-${diversityPenalty.toFixed(0)}`);
    if (rapidPenalty > 0) parts.push(`rapid=-${rapidPenalty}`);
    if (equipmentPenalty > 0) parts.push(`equip=-${equipmentPenalty}`);
    if (worldPenalty > 0) parts.push(`world=-${worldPenalty}`);
    if (idlePenalty > 0) parts.push(`idle=-${idlePenalty}`);
    if (stalenessPenalty > 0) parts.push(`stale=-${stalenessPenalty.toFixed(0)}`);
    if (insightBonus > 0) parts.push(`insight=+${insightBonus}`);
    parts.push(`→ ${finalScore.toFixed(0)}`);
    const reasoning = parts.join(" ");

    return {
      botId: bot.botId,
      routine,
      baseScore,
      supplyBonus,
      skillBonus,
      infoBonus,
      factionBonus,
      riskPenalty,
      switchCost,
      diversityPenalty,
      rapidPenalty,
      equipmentPenalty,
      worldPenalty,
      idlePenalty,
      stalenessPenalty,
      insightBonus,
      finalScore,
      reasoning,
    };
  }

  /** Check if a bot can be reassigned (cooldown expired) */
  canReassign(botId: string, now: number): boolean {
    const state = this.reassignmentState.get(botId);
    if (!state) return true;
    return now >= state.cooldownUntil;
  }

  /** Force-clear cooldown for a bot (urgency override) */
  clearCooldown(botId: string): void {
    this.reassignmentState.delete(botId);
  }

  /** Clear all cooldowns */
  clearAllCooldowns(): void {
    this.reassignmentState.clear();
  }

  // ── Private Scoring Components ──

  private calcSupplyBonus(routine: RoutineName, economy: EconomySnapshot): number {
    let bonus = 0;

    for (const deficit of economy.deficits) {
      const priorityMult = deficit.priority === "critical" ? 3 : deficit.priority === "normal" ? 1.5 : 1;
      const relevance = this.routineRelevanceToDeficit(routine, deficit);
      bonus += deficit.shortfall * relevance * priorityMult * (this.config.supplyMultiplier / 10);
    }

    // Cap supply bonus — observed rates can spike wildly in early session minutes,
    // creating shortfalls of thousands that completely overwhelm all other factors
    return Math.min(bonus, 50);
  }

  private routineRelevanceToDeficit(routine: RoutineName, deficit: SupplyDeficit): number {
    // How relevant is this routine to addressing the deficit?
    const id = deficit.itemId;
    // Ores (mined from belts)
    if (id.startsWith("ore_") && !id.includes("ice")) {
      if (routine === "miner") return 1.0;
      if (routine === "harvester") return 0.5;
    }
    // Ice ores (harvested from ice fields)
    if (id.includes("ice") || id.includes("crystal")) {
      if (routine === "harvester") return 1.0;
      if (routine === "miner") return 0.3;
    }
    // Refined/crafted materials
    if (id.startsWith("refined_") || id.startsWith("component_")) {
      if (routine === "crafter") return 1.0;
    }
    return 0;
  }

  /**
   * Supply chain bonus: boost crafter when faction storage has raw materials,
   * boost miner when faction storage is low on ore.
   */
  private calcFactionStorageBonus(routine: RoutineName, economy: EconomySnapshot): number {
    if (economy.factionStorage.size === 0) return 0;

    const oreInStorage = [...economy.factionStorage.entries()]
      .filter(([id]) => id.includes("ore"))
      .reduce((sum, [, qty]) => sum + qty, 0);

    // Per-ore-type breakdown for surplus selling detection
    const oreBreakdown = new Map<string, number>();
    for (const [id, qty] of economy.factionStorage) {
      if (id.includes("ore")) oreBreakdown.set(id, (oreBreakdown.get(id) ?? 0) + qty);
    }

    switch (routine) {
      case "crafter":
        // Crafter should be strongly preferred when ANY ore is available to process
        if (oreInStorage >= 50) return 50;  // Lots of ore — definitely need crafters
        if (oreInStorage >= 20) return 40;  // Good supply
        if (oreInStorage >= 10) return 30;  // Decent supply — crafter should be active
        if (oreInStorage >= 3) return 20;   // Minimum viable batch — start crafting
        return 0;
      case "miner":
        // Miner gets bonus when storage is empty, penalty when ore is piling up
        if (oreInStorage < 3) return 25;    // Storage empty — need to mine
        if (oreInStorage < 10) return 10;   // Low ore — keep mining
        if (oreInStorage < 30) return 0;    // Neutral — enough ore for now
        if (oreInStorage < 100) return -20; // Piling up — crafter should take priority
        return -60; // 100+ ore: strong penalty — seriously over-stocked, stop mining
      case "trader":
        // Trader gets bonus when crafted goods are in storage (ready to sell)
        {
          const goodsInStorage = [...economy.factionStorage.entries()]
            .filter(([id]) => id.startsWith("refined_") || id.startsWith("component_"))
            .reduce((sum, [, qty]) => sum + qty, 0);
          if (goodsInStorage >= 20) return 25;
          if (goodsInStorage >= 5) return 10;
        }
        // Trader also gets bonus when ore is massively over-stocked (5000+)
        // At this point traders should sell raw ore to free up storage
        {
          let oreOverstock = 0;
          for (const [, qty] of oreBreakdown) {
            if (qty >= 5000) oreOverstock += qty;
          }
          if (oreOverstock > 0) return 40; // Sell excess ore
        }
        return 0;
      case "quartermaster":
        // QM should create sell orders for massively over-stocked ores (5000+)
        {
          let oreSellable = 0;
          for (const [, qty] of oreBreakdown) {
            if (qty >= 5000) oreSellable += qty;
          }
          if (oreSellable > 0) return 30;
        }
        return 0;
      default:
        return 0;
    }
  }

  private calcSkillBonus(bot: FleetBotInfo, routine: RoutineName): number {
    // Ship fitness bonus: bots in better ships for a role get priority
    if (bot.shipClass && this.shipCatalog.length > 0) {
      const shipClass = this.shipCatalog.find((s) => s.id === bot.shipClass)
        ?? LEGACY_SHIPS.find((s) => s.id === bot.shipClass);
      if (shipClass) {
        const fitness = scoreShipForRole(shipClass, routine);
        // +0 to +25 bonus based on ship fitness (normalized 0-100 → 0-25)
        return Math.round(fitness * 0.25);
      }
    }
    return 0;
  }

  /**
   * Information-aware scoring. Uses WorldContext when available for precise data-driven bonuses.
   * Revenue-generating routines (miner, trader, mission_runner) are preferred over pure intel.
   * Explorer only gets boosted when data is specifically needed for profitable activities.
   */
  private calcInfoScarcityBonus(routine: RoutineName, economy: EconomySnapshot, world?: WorldContext): number {
    // If no world context, fall back to economy-only check
    if (!world) {
      const hasData = economy.deficits.length > 0 || economy.surpluses.length > 0
        || economy.inventoryAlerts.length > 0 || economy.totalRevenue > 0;
      if (hasData) return 0;
      // Prioritize revenue-generating routines that work blind
      switch (routine) {
        case "miner": return 15;           // Works great blind, generates credits
        case "crafter": return 10;          // Works from faction storage — doesn't need market data
        case "mission_runner": return 15;   // Reliable income
        case "explorer": return 5;          // Intel is nice but doesn't earn
        case "trader": return -20;          // Useless without price data
        default: return 0;
      }
    }

    let bonus = 0;

    // Galaxy not loaded → boost routines that still work + mild explorer boost
    if (!world.galaxyLoaded) {
      if (routine === "miner") return 15;           // Auto-discovers belts, earns credits
      if (routine === "crafter") return 5;            // Uses faction storage, not market
      if (routine === "mission_runner") return 15;   // Docks, takes missions, earns
      if (routine === "explorer") return 10;         // Gathers map data (needed eventually)
      if (routine === "trader") return -30;          // Needs prices
      return -5;
    }

    // No market data at all → revenue routines first, explorer second
    if (!world.hasAnyMarketData) {
      switch (routine) {
        case "miner": bonus += 15; break;           // Mine and sell, always works
        case "crafter": bonus += 5; break;           // Uses faction storage, not market
        case "mission_runner": bonus += 15; break;   // Docks at stations (triggers market scan)
        case "explorer": bonus += 10; break;         // Visits systems, triggers scans on dock
        case "trader": bonus -= 30; break;           // Useless without price data
      }
      return bonus;
    }

    // Have some market data but stale stations nearby → boost routines that refresh data
    if (world.staleStationIds.length > 0) {
      if (routine === "mission_runner") bonus += 10;
      if (routine === "trader") bonus += 5;
      if (routine === "explorer") bonus += 5;
    }

    // Have fresh trade routes → boost trader
    if (world.tradeRouteCount > 0 && routine === "trader") {
      bonus += Math.min(world.bestTradeProfit * 5, 25);
    }

    // No trade routes found even with data → penalize trader
    if (world.hasAnyMarketData && world.tradeRouteCount === 0 && routine === "trader") {
      bonus -= 15;
    }

    return bonus;
  }

  /**
   * World penalty: check if the bot's current system has POIs the bot can actually use.
   * Cross-references bot modules with system POI types:
   * - mining_laser/drill → asteroid_belt, asteroid
   * - ice_harvester → ice_field
   * - gas_harvester → gas_cloud, nebula
   */
  private calcWorldPenalty(bot: FleetBotInfo, routine: RoutineName, world?: WorldContext): number {
    if (!world || !bot.systemId) return 0;

    const system = world.systemPois.get(bot.systemId);
    if (!system) return 0; // No data for this system, don't penalize (routine will auto-discover)

    switch (routine) {
      case "miner":
      case "harvester": {
        // Check if system has any extractable resource POIs
        const hasResources = system.hasBelts || system.hasIceFields || system.hasGasClouds;
        if (!hasResources) return 200; // HARD BLOCK: no resource POIs — miner would instantly fail
        if (!system.hasStation) return 30; // Can extract but nowhere to sell/deposit
        return 0;
      }
      case "trader": {
        if (!system.hasStation) return 100;
        const hasLocalMarketData = system.stationIds.some((sid) =>
          world.freshStationIds.includes(sid)
        );
        if (!hasLocalMarketData) return 40; // No price data — trader would be guessing
        return 0;
      }
      case "crafter": {
        if (!system.hasStation) return 80;
        return 0;
      }
      case "mission_runner": {
        if (!system.hasStation) return 60;
        return 0;
      }
      case "salvager":
        return 0; // Wrecks appear anywhere
      default:
        return 0;
    }
  }

  private calcRiskPenalty(bot: FleetBotInfo, routine: RoutineName): number {
    // Critical fuel (<15%): all routines penalized heavily (bot needs emergency refuel)
    if (bot.fuelPct < 15) {
      if (routine === "miner") return 50; // Miner will auto-dock but still penalize at critical
      return 150; // Hard block — bot needs to refuel, not work
    }
    // Low fuel (15-30%): penalize routines that travel a lot, miner is safest (auto-docks)
    if (bot.fuelPct < 30) {
      if (routine === "miner") return 0;
      if (routine === "mission_runner") return 20; // Can dock and refuel during missions
      return 80; // Most routines need fuel to function
    }
    // Below comfortable (30-50%): mild penalty for non-docking routines
    if (bot.fuelPct < 50 && routine !== "miner" && routine !== "mission_runner") {
      return 15;
    }
    // Risk for combat routines on low-hull bots
    if (routine === "hunter" && bot.cargoPct > 80) {
      return 10; // Don't send full cargo bots into combat
    }
    if (routine === "hunter" && bot.hullPct < 50) {
      return 20; // Don't send damaged bots into combat
    }
    return 0;
  }

  /**
   * Equipment penalty: check if the bot has the modules needed for a routine.
   * Returns a heavy penalty (effectively blocks assignment) if critical modules are missing.
   *
   * Extraction module requirements:
   * - Ore (asteroid_belt/asteroid): mining_laser or drill
   * - Ice (ice_field): ice_harvester
   * - Gas (gas_cloud/nebula): gas_harvester
   * - At least ONE matching extraction module required for miner/harvester
   */
  private calcEquipmentPenalty(bot: FleetBotInfo, routine: RoutineName): number {
    const mods = bot.moduleIds;
    const hasModule = (pattern: string) => mods.some((id) => id.includes(pattern));

    switch (routine) {
      case "miner":
        // No penalty — mining works with starter ships
        return 0;
      case "harvester": {
        // Harvester is only valuable with specialized modules (ice/gas harvesters)
        // Without them, it does the same thing as miner but with worse params
        const hasSpecialized = hasModule("ice_harvester") || hasModule("gas_harvester");
        return hasSpecialized ? 0 : 80; // Heavy penalty if no specialized gear
      }
      case "hunter": {
        // Must have actual weapon modules — mining_laser, survey_scanner etc. don't count
        const hasWeapon = hasModule("weapon_") || hasModule("cannon") || hasModule("missile")
          || hasModule("turret") || hasModule("gun") || hasModule("blaster") || hasModule("railgun");
        return hasWeapon ? 0 : 200;
      }
      case "salvager": {
        const hasSalvage = hasModule("tow") || hasModule("salvage");
        return hasSalvage ? 0 : 200;
      }
      case "crafter": {
        // Check if bot has any crafting-related skills
        const hasCraftingSkill = Object.entries(bot.skills).some(
          ([id, level]) => (id.includes("craft") || id.includes("refin") || id.includes("manufactur")) && level > 0
        );
        // Mild penalty if no crafting skills — bot can still attempt easy recipes to level up
        return hasCraftingSkill ? 0 : 20;
      }
      default:
        return 0;
    }
  }

  /**
   * Penalize routines that need external inputs but have none configured.
   * Also enforces hard caps: max 1 explorer in the fleet.
   * Handles return_home scoring: big bonus for idle bots away from home,
   * blocked for bots already home or recently on field routines.
   */
  private calcIdleRoutinePenalty(routine: RoutineName, economy: EconomySnapshot, fleet?: FleetStatus, bot?: FleetBotInfo): number {
    switch (routine) {
      case "explorer": {
        // Dynamic cap: 1 explorer for small fleets, 2 for 6+ bots
        const explorerMax = fleet ? getMaxCount("explorer", fleet.bots.length) ?? 1 : 1;
        const explorerCount = fleet?.bots.filter((b) => b.routine === "explorer").length ?? 0;
        if (explorerCount >= explorerMax) return 200; // Block additional explorers
        // Guaranteed slot: no explorer assigned in 2+ bot fleet → strong bonus
        // Score = 25 base + 55 bonus = 80, beats diversity-penalized duplicate miners
        return (fleet && fleet.bots.length >= 2) ? -55 : 0;
      }
      case "salvager":
        // Salvager is speculative (wrecks are random) — mild idle penalty
        return 10;
      case "return_home": {
        if (!bot) return 200;
        // No home configured → block entirely
        if (!this.homeBase && !this.homeSystem) return 200;

        // CREDIT EMERGENCY: bot is critically low on credits and needs to return
        // to faction base to withdraw from treasury. Override all other checks.
        if (this.minBotCredits > 0 && bot.credits < this.minBotCredits * 0.5) {
          // Already at home (docked) → handle at dock, don't force return
          if (this.homeBase && bot.docked && bot.systemId === this.homeSystem) return 200;
          // Away from home with critically low credits → MUST return
          return -150; // Very strong bonus — override nearly everything
        }

        // Already at home base (docked) → block
        if (this.homeBase && bot.docked && bot.systemId === this.homeSystem) return 200;
        // Already in home system → mild penalty (might still need to dock)
        if (this.homeSystem && bot.systemId === this.homeSystem) return 60;
        // Bot is idle (no routine) and away from home → big BONUS (negative penalty)
        if (!bot.routine) return -80;
        // Bot is on a field routine → block (let them stay in the field)
        if (FIELD_ROUTINES.has(bot.routine)) return 200;
        // Bot on a home-based routine → small bonus if away from home
        return -20;
      }
      case "scout": {
        if (!bot) return 200;
        // Scout is one-shot data gathering. Score high when we need data, block otherwise.
        // Hard cap: only 1 scout at a time
        const scoutCount = fleet?.bots.filter((b) => b.routine === "scout").length ?? 0;
        if (scoutCount >= 1) return 200;
        // If faction storage is already known, no need to scout
        if (this.homeBase && this.homeSystem) {
          // Check if home system has station data (i.e., we've visited it)
          // If homeBase is set, discovery already happened
          return 200;
        }
        // homeSystem set but no homeBase — we need station data!
        if (this.homeSystem && !this.homeBase) return -200; // Massive bonus → highest priority
        // No home configured at all — block
        return 200;
      }
      case "quartermaster": {
        if (!bot) return 200;
        // Only assign when faction home is configured
        if (!this.homeBase) return 200;
        // Hard cap: only 1 quartermaster
        const qmCount = fleet?.bots.filter((b) => b.routine === "quartermaster").length ?? 0;
        if (qmCount >= 1 && bot.routine !== "quartermaster") return 200;
        // Need at least 3 bots to justify a dedicated quartermaster
        if (fleet && fleet.bots.length < 3) return 200;

        let bonus = -10; // Base fleet management
        // Scale with sellable goods value
        const sellableValue = [...economy.factionStorage.entries()]
          .filter(([id, qty]) => qty > 0 && !id.startsWith("ore_"))
          .reduce((sum, [id, qty]) => sum + qty * (this.crafting?.getEffectiveSellPrice(id) ?? 0), 0);
        if (sellableValue > 500) bonus -= Math.min(30, Math.round(sellableValue / 200));
        // Bonus per active crafter (QM needs to sell their output)
        const crafterCount = fleet?.bots.filter((b) => b.routine === "crafter").length ?? 0;
        if (crafterCount > 0) bonus -= Math.min(20, crafterCount * 5);
        return bonus;
      }
      case "ship_upgrade": {
        if (!bot) return 200;
        const pending = this.pendingUpgrades.get(bot.botId);
        if (!pending) return 200; // No upgrade queued → block entirely
        // Hard cap: only 1 ship_upgrade at a time (exempt free switches — they're instant)
        if (!pending.alreadyOwned) {
          const upgradeCount = fleet?.bots.filter((b) => b.routine === "ship_upgrade").length ?? 0;
          if (upgradeCount >= 1 && bot.routine !== "ship_upgrade") return 200;
        }
        // Base 70 when upgrade is queued — high enough to interrupt most activities
        let bonus = -70;
        // ROI bonus: better deals score higher (cap -20)
        bonus -= Math.min(20, pending.roi * 10);
        // Free switch bonus: already-owned ships get priority (it's instant and free)
        if (pending.alreadyOwned) bonus -= 50;
        return bonus;
      }
      case "refit": {
        if (!bot) return 200;
        const refitScore = this.calcRefitNeed(bot, economy);
        if (refitScore <= 0) return 200; // No refit needed → block
        // Higher refitScore = more urgently needs refit → lower penalty (higher effective score)
        return -refitScore;
      }
      default:
        return 0;
    }
  }

  /**
   * Data staleness penalty: penalize routines that depend on fresh market data
   * when a high proportion of stations have stale/expired data.
   * Boosts routines that refresh data (docking triggers auto-scan).
   */
  private calcStalenessPenalty(routine: RoutineName, world?: WorldContext): number {
    if (!world || !world.hasAnyMarketData) return 0;

    // dataFreshnessRatio: 1.0 = all fresh, 0.0 = all stale
    const staleness = 1 - world.dataFreshnessRatio;
    if (staleness < 0.3) return 0; // Mostly fresh, no penalty

    switch (routine) {
      case "trader":
        // Traders depend heavily on accurate prices — stale data = bad trades
        return Math.round(staleness * 40);
      case "crafter":
        // Crafters need material price info for profitability
        return Math.round(staleness * 15);
      case "mission_runner":
        // Bonus: mission runners dock frequently, refreshing data
        return -Math.round(staleness * 10);
      case "explorer":
        // Bonus: explorers visit new systems and dock, refreshing data
        return -Math.round(staleness * 8);
      default:
        return 0;
    }
  }

  /** Market insight bonus: reward trader/QM when demand intelligence exists */
  private calcMarketInsightBonus(routine: RoutineName, world?: WorldContext): number {
    if (routine !== "trader" && routine !== "quartermaster") return 0;
    if (!world || world.demandInsightCount === 0) return 0;
    return Math.min(world.demandInsightCount * 3, 15); // Max +15
  }

  /** Build routine params based on fleet state and economy */
  private buildParams(
    routine: RoutineName,
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    goals: Goal[],
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const isFactionMode = this.defaultStorageMode === "faction_deposit";
    const hasFactionMaterials = economy.factionStorage.size > 0;

    // Base params - routines use these to guide behavior
    switch (routine) {
      case "miner": {
        const params = this.buildMinerParams(bot, economy, existingAssignments, world);
        // Persist belt assignment for cross-cycle deconfliction
        if (params.targetBelt) this.activeBeltAssignments.set(bot.botId, String(params.targetBelt));
        else this.activeBeltAssignments.delete(bot.botId);
        return params;
      }
      case "harvester":
        return this.buildHarvesterParams(bot, economy, existingAssignments, world);
      case "trader":
        return this.buildTraderParams(bot, economy, existingAssignments, world);
      case "explorer":
        return this.buildExplorerParams(bot, economy, existingAssignments);
      case "crafter":
        return this.buildCrafterParams(bot, economy, existingAssignments);
      case "hunter":
        return { huntZone: "", fleeThreshold: 25, engagementRules: "all" };
      case "salvager":
        return { salvageYard: homeBase || "", scrapMethod: "scrap" };
      case "mission_runner":
        return { autoAccept: true, missionTypes: [], minReward: 100, skipCombat: true, maxJumps: 4 };
      case "return_home":
        return { homeBase: this.homeBase, homeSystem: this.homeSystem };
      case "scout":
        return { targetSystem: this.homeSystem, scanMarket: true, checkFaction: true };
      case "quartermaster":
        return {
          homeBase: this.homeBase,
          buyOrderBudgetPct: 0.30,
          maxOrderAge: 7_200_000, // 2 hours
        };
      case "scavenger":
        return { sellMode: isFactionMode ? "faction_deposit" : "sell" };
      case "ship_upgrade":
        return this.buildShipUpgradeParams(bot);
      case "refit":
        return this.buildRefitParams(bot);
      default:
        return {};
    }
  }

  /** Build ship_upgrade params from the pending upgrades queue */
  private buildShipUpgradeParams(bot: FleetBotInfo): Record<string, unknown> {
    const pending = this.pendingUpgrades.get(bot.botId);
    if (!pending) return { targetShipClass: "", maxSpend: 0, sellOldShip: true };
    const reserve = Math.max(5000, this.minBotCredits);
    return {
      targetShipClass: pending.targetShipClass,
      maxSpend: pending.alreadyOwned ? 0 : Math.max(0, bot.credits - reserve),
      sellOldShip: !pending.alreadyOwned, // Don't sell when switching to an already-owned ship
      alreadyOwned: pending.alreadyOwned ?? false,
      ownedShipId: pending.ownedShipId ?? "",
      role: pending.role || this.inferPrimaryRole(bot),
    };
  }

  /**
   * Build trader params with route deconfliction.
   * Assigns each trader a different trade route so they don't compete for the same orders.
   * Uses live arbitrage data to pass specific routes + volume-aware buy limits.
   */
  private buildTraderParams(
    bot: FleetBotInfo,
    _economy: EconomySnapshot,
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    // Faction-sell primary, with insight-gated arbitrage when demand signals exist.
    const hasInsights = (world?.demandInsightCount ?? 0) > 0;

    // Deconflict traders: each gets a different route index to avoid competing for same routes
    const traderIndex = existingAssignments.filter(a => a.routine === "trader").length;

    // Find best available route for this trader using live market data
    const params: Record<string, unknown> = {
      sellFromFaction: true,
      enableArbitrage: hasInsights,
      traderIndex,
    };

    // If we have market data, assign a specific route with volume cap
    if (this.market) {
      const cachedStations = this.market.getCachedStationIds?.() ?? [];
      if (cachedStations.length >= 2) {
        const freeCapacity = Math.round(bot.cargoCapacity * (1 - bot.cargoPct / 100));
        const routes = this.market.findArbitrage(
          cachedStations, bot.systemId ?? "", freeCapacity,
        );

        // Collect volume already assigned to other traders in this evaluation
        const assignedVolume = new Map<string, number>(); // itemId → total units assigned
        for (const a of existingAssignments) {
          if (a.routine === "trader" && a.params?.assignedItem) {
            const item = String(a.params.assignedItem);
            assignedVolume.set(item, (assignedVolume.get(item) ?? 0) + Number(a.params.maxBuyQty ?? 0));
          }
        }

        // Pick the best route not already fully claimed by another trader
        for (const route of routes) {
          const alreadyClaimed = assignedVolume.get(route.itemId) ?? 0;
          const remainingVol = (route.volume > 0 ? route.volume : 999) - alreadyClaimed;
          if (remainingVol <= 0) continue; // Volume fully claimed by other traders

          params.assignedItem = route.itemId;
          params.assignedBuyStation = route.buyStationId;
          params.assignedSellStation = route.sellStationId;
          params.maxBuyQty = Math.min(remainingVol, freeCapacity);
          params.expectedBuyPrice = route.buyPrice;
          params.expectedSellPrice = route.sellPrice;
          break;
        }
      }
    }

    return params;
  }

  /** Fleet home base ID (set by Commander) */
  homeBase = "";
  /** Fleet home system ID (set by Commander) */
  homeSystem = "";
  /** Default storage mode (set by Commander) */
  defaultStorageMode: "sell" | "deposit" | "faction_deposit" = "sell";
  /** Minimum credits a bot should maintain (set by Commander from FleetConfig) */
  minBotCredits = 0;
  /** Crafting service (set by Commander for recipe-aware crafter params) */
  crafting: import("../core/crafting").Crafting | null = null;
  /** Galaxy service (set by Commander for belt-aware miner params) */
  galaxy: import("../core/galaxy").Galaxy | null = null;
  /** Market service (set by Commander for per-bot arbitrage) */
  market: import("../core/market").Market | null = null;
  /** Pending ship upgrades queued by Commander (botId → upgrade info) */
  pendingUpgrades = new Map<string, PendingUpgrade>();
  /** Ship catalog (set by Commander for ship fitness scoring) */
  shipCatalog: ShipClass[] = [];

  // ── Refit Detection ──

  /** Module patterns desired per role (matches refit.ts ROLE_MODULES) */
  private static REFIT_ROLE_MODULES: Record<string, string[]> = {
    miner:     ["mining_laser", "mining_laser", "mining_laser"],
    harvester: ["ice_harvester", "gas_harvester", "mining_laser"],
    explorer:  ["survey_scanner"],
    hunter:    ["weapon_laser", "weapon_laser", "weapon_laser"],
    crafter:   ["mining_laser"],
    default:   ["mining_laser"],
  };

  /** Check if ANY bot in the fleet needs a refit (pre-filter for performance) */
  private anyBotNeedsRefit(bots: FleetBotInfo[], economy: EconomySnapshot): boolean {
    for (const bot of bots) {
      if (this.calcRefitNeed(bot, economy) > 0) return true;
    }
    return false;
  }

  /**
   * Calculate how urgently a bot needs a module refit (0 = no need, higher = more urgent).
   * Checks: missing role modules, lower-tier modules when higher tiers are available.
   */
  private calcRefitNeed(bot: FleetBotInfo, economy: EconomySnapshot): number {
    const role = this.inferPrimaryRole(bot);
    const desired = ScoringBrain.REFIT_ROLE_MODULES[role];
    if (!desired || desired.length === 0) return 0;

    let score = 0;
    const mods = bot.moduleIds;

    // Count desired patterns
    const patternCounts = new Map<string, number>();
    for (const pattern of desired) {
      patternCounts.set(pattern, (patternCounts.get(pattern) ?? 0) + 1);
    }

    for (const [pattern, wantCount] of patternCounts) {
      // How many of this pattern does the bot have?
      const installed = mods.filter(id => id.includes(pattern));
      const haveCount = installed.length;

      // Missing modules
      if (haveCount < wantCount) {
        // Check if faction storage has any of this pattern
        const inStorage = [...economy.factionStorage.entries()]
          .some(([itemId, qty]) => itemId.includes(pattern) && qty > 0);
        if (inStorage) {
          score += (wantCount - haveCount) * 25; // 25 per missing module with supply
        }
      }

      // Check for tier upgrades: is a higher tier available in faction storage?
      for (const modId of installed) {
        const currentTier = this.extractModuleTier(modId);
        const bestAvailableTier = this.bestAvailableTier(pattern, economy.factionStorage);
        if (bestAvailableTier > currentTier) {
          score += (bestAvailableTier - currentTier) * 15; // 15 per tier level improvement
        }
      }
    }

    // Module wear: low durability means modules need repair (refit handles this)
    if (bot.moduleWear < 70) {
      score += Math.round((100 - bot.moduleWear) * 0.5); // Up to 15 extra score
    }

    return score;
  }

  /** Extract tier number from module ID (e.g., mining_laser_2 -> 2) */
  private extractModuleTier(moduleId: string): number {
    const match = moduleId.match(/_(\d+)$/);
    return match ? parseInt(match[1]) : 1;
  }

  /** Find the highest tier of a module pattern available in faction storage */
  private bestAvailableTier(pattern: string, factionStorage: Map<string, number>): number {
    let best = 0;
    for (const [itemId, qty] of factionStorage) {
      if (qty > 0 && itemId.includes(pattern)) {
        const tier = this.extractModuleTier(itemId);
        if (tier > best) best = tier;
      }
    }
    return best;
  }

  /** One-shot routines that don't represent a bot's primary role */
  private static ONE_SHOT_ROUTINES = new Set(["refit", "ship_upgrade", "scout", "return_home"]);

  /** Infer the bot's primary work role (skipping one-shot routines like refit/scout) */
  private inferPrimaryRole(bot: FleetBotInfo): string {
    // Check current routine first
    if (bot.routine && !ScoringBrain.ONE_SHOT_ROUTINES.has(bot.routine)) {
      return bot.routine;
    }
    // Check last routine
    if (bot.lastRoutine && !ScoringBrain.ONE_SHOT_ROUTINES.has(bot.lastRoutine)) {
      return bot.lastRoutine;
    }
    // Fallback: infer from equipped modules
    const mods = bot.moduleIds.join(" ");
    if (mods.includes("weapon_laser")) return "hunter";
    if (mods.includes("survey_scanner")) return "explorer";
    if (mods.includes("ice_harvester") || mods.includes("gas_harvester")) return "harvester";
    if (mods.includes("mining_laser")) return "miner";
    return "default";
  }

  /** Build refit params */
  private buildRefitParams(bot: FleetBotInfo): Record<string, unknown> {
    const role = this.inferPrimaryRole(bot);
    return {
      role,
      homeBase: this.homeBase,
      maxSpendPct: 0.30,
    };
  }

  /**
   * Build crafter params with intelligent recipe selection:
   * 1. Items with market demand (high sell price / confirmed demand)
   * 2. Items that use available faction storage materials
   * 3. Items that give XP for skill progression
   * Deconflicts: multiple crafters pick different recipes
   */
  private buildCrafterParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const crafting = this.crafting;

    // Base params — crafter sources from faction storage, deposits output back to faction
    // Traders handle selling from faction storage (supply chain separation)
    const baseParams = {
      recipeId: "",
      count: 1,
      materialSource: "storage",  // Pull from faction storage
      sellOutput: false,          // Deposit to faction — traders sell
      craftStation: homeBase,
    };

    if (!crafting || crafting.recipeCount === 0) return baseParams;

    // Collect recipes already assigned to other crafters this cycle
    const claimedRecipes = new Set<string>();
    const claimedOutputs = new Set<string>();
    const claimedMaterials = new Map<string, number>();
    for (const a of existingAssignments) {
      if (a.routine === "crafter" && a.params.recipeId) {
        claimedRecipes.add(String(a.params.recipeId));
        const recipe = crafting.getRecipe(String(a.params.recipeId));
        if (recipe) claimedOutputs.add(recipe.outputItem);
        // Track raw materials claimed by this assignment
        const batchCount = Number(a.params.count) || 1;
        const raws = crafting.getRawMaterials(String(a.params.recipeId), batchCount);
        for (const [itemId, qty] of raws) {
          claimedMaterials.set(itemId, (claimedMaterials.get(itemId) ?? 0) + qty);
        }
      }
    }

    // Get available recipes for this bot's skills
    const available = crafting.getAvailableRecipes(bot.skills ?? {});
    if (available.length === 0) return baseParams;

    // Pre-compute: which items are used as ingredients in ANY recipe
    const allRecipes = crafting.getAllRecipes();
    const ingredientUsageCount = new Map<string, number>();
    for (const r of allRecipes) {
      for (const ing of r.ingredients) {
        ingredientUsageCount.set(ing.itemId, (ingredientUsageCount.get(ing.itemId) ?? 0) + 1);
      }
    }

    // Score each recipe — prefer highest tier WHERE materials are available
    const scored: Array<{ recipe: typeof available[0]; score: number; reason: string; heaviestStep: number }> = [];
    for (const recipe of available) {
      if (claimedRecipes.has(recipe.id)) continue;
      if (claimedOutputs.has(recipe.outputItem)) continue; // Don't flood same item

      let score = 0;
      let reason = "";

      // ── Material availability (check FIRST — gates the tier bonus) ──
      // Raw materials (resolved through full chain): can we craft from scratch?
      const chain = crafting.buildChain(recipe.id, 1);
      const chainDepth = chain.length;
      const rawMaterials = crafting.getRawMaterials(recipe.id, 1);
      let hasAllRaws = true;
      let rawsAvailableCount = 0;
      let rawsMissingCount = 0;
      for (const [itemId, needed] of rawMaterials) {
        const inStorage = Math.max(0, (economy.factionStorage.get(itemId) ?? 0) - (claimedMaterials.get(itemId) ?? 0));
        if (inStorage >= needed) {
          rawsAvailableCount++;
        } else {
          hasAllRaws = false;
          if (inStorage === 0) rawsMissingCount++; // Completely absent — not even 1 unit
        }
      }

      // Intermediates already in storage? (shortcut — skip earlier chain steps)
      let hasImmediateIngredients = false;
      if (chainDepth > 1) {
        hasImmediateIngredients = recipe.ingredients.every(
          (ing) => Math.max(0, (economy.factionStorage.get(ing.itemId) ?? 0) - (claimedMaterials.get(ing.itemId) ?? 0)) >= ing.quantity,
        );
        if (hasImmediateIngredients) {
          score += 20; // Big bonus — chain already done, just assemble
          reason += "+intermediates_ready";
        }
      }

      const canCraft = hasAllRaws || hasImmediateIngredients;
      if (canCraft) {
        score += 30;
        reason += " +materials_ready";
      } else {
        // Penalty scales with missing material types — complex impossible recipes get crushed
        score -= 50 + rawsMissingCount * 30;
        reason += ` -missing:${rawsMissingCount}/${rawMaterials.size}`;
      }
      score += rawsAvailableCount * 5;

      // ── Cargo feasibility — skip recipes that can't fit in this ship ──
      let heaviestStepInputs = 0;
      for (const step of chain) {
        const stepInputs = step.inputs.reduce((sum, inp) => sum + inp.quantity, 0);
        heaviestStepInputs = Math.max(heaviestStepInputs, stepInputs);
      }
      if (heaviestStepInputs > bot.cargoCapacity) {
        // Recipe fundamentally requires more cargo than ship can hold — skip entirely
        reason += ` SKIP:cargo(need ${heaviestStepInputs}, have ${bot.cargoCapacity})`;
        scored.push({ recipe, score: -999, reason, heaviestStep: heaviestStepInputs });
        continue;
      }

      // ── Tier bonus — ONLY when materials are available ──
      // High-tier recipes score higher, but only if we can actually craft them
      if (chainDepth > 1 && canCraft) {
        const tierBonus = Math.min(chainDepth * 25, 80); // Cap at +80 — strongly prefer high-tier
        score += tierBonus;
        reason += ` tier:${chainDepth}(+${tierBonus})`;
      } else if (chainDepth > 1) {
        reason += ` tier:${chainDepth}(gated)`;
      }

      // Pre-compute: is this item used as ingredient in other recipes?
      const usageCount = ingredientUsageCount.get(recipe.outputItem) ?? 0;

      // ── Estimated profit (market prices when available, MSRP fallback) ──
      const { profit, hasMarketData } = crafting.estimateMarketProfit(recipe.id);
      if (profit > 0) {
        const profitScore = Math.min(profit / 10, 50); // Cap at 50 points
        // Boost confidence when using real market data
        score += hasMarketData ? profitScore * 1.2 : profitScore;
        reason += ` profit:${profit}cr${hasMarketData ? "(mkt)" : ""}`;
      } else if (profit < 0 && usageCount === 0) {
        // End product sells for less than its crafting cost — money loser
        // Skip intermediates (they feed higher-tier recipes regardless of own price)
        score -= hasMarketData ? 150 : 100; // Stronger penalty when market confirms it's unprofitable
        reason += ` -UNPROFITABLE:${profit}cr${hasMarketData ? "(mkt)" : ""}`;
      }

      // Factor 4: Supply chain value — output feeds higher-tier recipes
      if (usageCount > 0) {
        score += 15;
        reason += " +chain_value";
        const outputStock = economy.factionStorage.get(recipe.outputItem) ?? 0;
        if (outputStock === 0) {
          score += 40; // Blocking other crafters
          reason += " +demand_deficit";
        } else if (outputStock < 10) {
          score += 20;
          reason += " +demand_low";
        }
      }

      // Factor 5: XP rewards for skill progression
      for (const [skillId, xp] of Object.entries(recipe.xpRewards)) {
        const currentLevel = bot.skills?.[skillId] ?? 0;
        if (currentLevel < 5) {
          score += xp * (5 - currentLevel);
          reason += ` +xp:${skillId}`;
        }
      }

      // Factor 6: Output value — higher sell price = more valuable goods (high-end focus)
      const outputPrice = crafting.getEffectiveSellPrice(recipe.outputItem);
      if (outputPrice > 0) {
        score += Math.min(outputPrice / 15, 50); // Up to +50 for high-value products
      }

      // Factor 7: No-demand penalty — end products with no market data are likely unsellable
      // If the item isn't an intermediate (usageCount === 0) AND profit estimation relied
      // on MSRP (not real market data), apply a heavy penalty — nobody is buying this.
      if (usageCount === 0 && !hasMarketData) {
        score -= 80;
        reason += " -NO_DEMAND(no market data, end product)";
      }

      // Factor 8: Inventory saturation — aggressive overproduction prevention
      // End products (not used in other recipes) get a tight ceiling (15 units).
      // Intermediates (ingredients for higher-tier recipes) get a lenient ceiling (100 units).
      const outputInStorage = economy.factionStorage.get(recipe.outputItem) ?? 0;
      const isIntermediate = usageCount > 0;
      const stockCeiling = isIntermediate ? 100 : 15;

      if (outputInStorage >= stockCeiling) {
        // Over ceiling: harsh penalty that scales with excess ratio
        const excessRatio = outputInStorage / stockCeiling;
        const saturationPenalty = Math.min(300, Math.round(50 + excessRatio * 20));
        score -= saturationPenalty;
        reason += ` -OVERSATURATED:${outputInStorage}/${stockCeiling}`;
      } else if (outputInStorage > 5) {
        // Approaching ceiling: linear ramp up to -30 at ceiling
        const ratio = outputInStorage / stockCeiling;
        const penalty = Math.round(ratio * 30);
        score -= penalty;
        reason += ` -inventory:${outputInStorage}/${stockCeiling}`;
      }

      // Factor 9: Fleet consumable bonus — fuel cells are burned constantly by every bot
      if (recipe.outputItem === "fuel_cell" || recipe.outputItem === "fuel_cell_premium") {
        const fuelStock = economy.factionStorage.get(recipe.outputItem) ?? 0;
        const fleetSize = existingAssignments.length || 1;
        const fuelTarget = fleetSize * 10; // ~10 cells per bot as comfortable buffer
        if (fuelStock < fuelTarget) {
          const urgency = Math.min(60, Math.round((1 - fuelStock / fuelTarget) * 60));
          score += urgency;
          reason += ` +fuel_need(${fuelStock}/${fuelTarget})`;
        }
      }

      scored.push({ recipe, score, reason, heaviestStep: heaviestStepInputs });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0 && scored[0].score > 0) {  // Only assign crafter when a recipe has positive score
      const best = scored[0];
      // Calculate max batch count constrained by: materials, cargo space, and cap of 5
      const rawMaterials = crafting.getRawMaterials(best.recipe.id, 1);
      let maxByMaterials = 10;
      for (const [itemId, perBatch] of rawMaterials) {
        const inStorage = Math.max(0, (economy.factionStorage.get(itemId) ?? 0) - (claimedMaterials.get(itemId) ?? 0));
        maxByMaterials = Math.min(maxByMaterials, Math.floor(inStorage / perBatch));
      }
      // Cargo constraint: reuse heaviest step from scoring loop
      const maxByCargo = best.heaviestStep > 0
        ? Math.floor(bot.cargoCapacity / best.heaviestStep)
        : 10;
      const batchCount = Math.max(1, Math.min(maxByMaterials, maxByCargo, 5));
      return {
        ...baseParams,
        recipeId: best.recipe.id,
        count: batchCount,
      };
    }

    return baseParams;
  }

  /**
   * Build explorer params — equip survey scanner if available in faction storage.
   */
  private buildExplorerParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
  ): Record<string, unknown> {
    const explorerIndex = existingAssignments.filter(a => a.routine === "explorer").length;
    const equipModules: string[] = [];

    // Equip survey scanner if bot doesn't have one and faction storage has one
    const hasSurvey = bot.moduleIds.some((id) => id.includes("survey"));
    if (!hasSurvey) {
      // Check faction storage for a survey scanner
      const surveyInStorage = [...economy.factionStorage.entries()]
        .some(([itemId, qty]) => itemId.includes("survey") && qty > 0);
      if (surveyInStorage) {
        equipModules.push("survey");
      }
    }

    return { targetSystems: [], submitIntel: true, explorerIndex, equipModules };
  }

  /**
   * Build miner params with intelligent belt selection:
   * 1. Check what ores are most needed (faction storage deficits)
   * 2. Find belts with those resources (non-depleted)
   * 3. Pick closest non-claimed belt for this miner
   * 4. Specify equipment modules to install if available in faction storage
   */
  private buildMinerParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const baseParams = {
      targetBelt: "",
      sellStation: homeBase,
      depositToStorage: true,
      equipModules: [] as string[],
      unequipModules: [] as string[],
    };

    if (!this.galaxy) return baseParams;
    const galaxy = this.galaxy;

    // ── Demand-driven mining: figure out what ores crafters actually need ──
    // Map: POI type → ore prefixes found there
    const POI_ORE_MAP: Record<string, string[]> = {
      asteroid_belt: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
      asteroid: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
      ice_field: ["ore_ice"],
      gas_cloud: ["ore_crystal", "ore_gas"],
      nebula: ["ore_crystal", "ore_gas"],
    };

    // Reverse map: ore prefix → which POI types produce it
    const ORE_TO_POI: Map<string, string[]> = new Map();
    for (const [poiType, prefixes] of Object.entries(POI_ORE_MAP)) {
      for (const prefix of prefixes) {
        const existing = ORE_TO_POI.get(prefix) ?? [];
        existing.push(poiType);
        ORE_TO_POI.set(prefix, existing);
      }
    }

    // Equipment needed per POI type
    const POI_EQUIP: Record<string, string> = {
      ice_field: "ice_harvester",
      gas_cloud: "gas_harvester",
      nebula: "gas_harvester",
    };

    // Compute crafter demand: what raw materials do active/best recipes consume?
    // This creates a demand signal that miners follow, closing the supply chain loop.
    const crafterDemand = new Map<string, number>(); // ore itemId prefix → demand score

    // 1. Recipes already assigned to crafters this cycle
    for (const a of existingAssignments) {
      if (a.routine === "crafter" && a.params.recipeId && this.crafting) {
        const raws = this.crafting.getRawMaterials(String(a.params.recipeId), Number(a.params.count) || 1);
        for (const [itemId, qty] of raws) {
          if (itemId.startsWith("ore_")) {
            crafterDemand.set(itemId, (crafterDemand.get(itemId) ?? 0) + qty);
          }
        }
      }
    }

    // 2. If no crafters assigned yet, check top recipes by score to predict demand
    if (crafterDemand.size === 0 && this.crafting && this.crafting.recipeCount > 0) {
      const allRecipes = this.crafting.getAllRecipes();
      // Score recipes by simple profitability to predict what crafters will be assigned
      const topRecipes = allRecipes
        .map(r => ({ recipe: r, profit: this.crafting!.estimateMarketProfit(r.id).profit }))
        .filter(r => r.profit > 0)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 3);

      for (const { recipe } of topRecipes) {
        const raws = this.crafting.getRawMaterials(recipe.id, 1);
        for (const [itemId, qty] of raws) {
          if (itemId.startsWith("ore_")) {
            crafterDemand.set(itemId, (crafterDemand.get(itemId) ?? 0) + qty);
          }
        }
      }
    }

    // ── Score POI types: combine demand signal + storage deficit ──
    // For each POI type, compute: demand_score = crafter_demand - current_storage
    // Higher score = more urgently needed
    const poiScores: Array<{ poiType: string; score: number }> = [];
    const seenNormalized = new Set<string>();

    for (const [poiType, orePatterns] of Object.entries(POI_ORE_MAP)) {
      // Deduplicate asteroid/asteroid_belt and gas_cloud/nebula
      const norm = poiType === "asteroid" ? "asteroid_belt" : poiType === "nebula" ? "gas_cloud" : poiType;
      if (seenNormalized.has(norm)) continue;
      seenNormalized.add(norm);

      let demandScore = 0;
      let storageScore = 0;

      for (const prefix of orePatterns) {
        // Sum up storage for this ore type
        let stock = 0;
        for (const [itemId, qty] of economy.factionStorage) {
          if (itemId.startsWith(prefix)) stock += qty;
        }

        // Sum up crafter demand for ores matching this prefix
        let demand = 0;
        for (const [itemId, qty] of crafterDemand) {
          if (itemId.startsWith(prefix)) demand += qty;
        }

        // Demand-driven: how much more ore do crafters need vs what's in storage?
        const deficit = Math.max(0, demand - stock);
        demandScore += deficit * 3; // Strong weight on crafter demand
        // Also factor in low storage (general need even without active crafter assignments)
        if (stock < 10) storageScore += (10 - stock) * 2;
      }

      poiScores.push({ poiType: norm, score: demandScore + storageScore });
    }

    poiScores.sort((a, b) => b.score - a.score); // Highest demand first

    // Collect belts already claimed by other miners — both this eval AND persistent active assignments
    const claimedBelts = new Set<string>();
    for (const a of existingAssignments) {
      if (a.routine === "miner" && a.params.targetBelt) {
        claimedBelts.add(String(a.params.targetBelt));
      }
    }
    // Include persistent belt assignments from previous eval cycles
    for (const [botId, beltId] of this.activeBeltAssignments) {
      if (botId !== bot.botId) claimedBelts.add(beltId);
    }

    // Find best belt: iterate through needed resource types, find unclaimed non-depleted POIs
    const botSystem = bot.systemId ?? this.homeSystem;
    const hasResourcesLeft = (poi: { id: string; resources: Array<{ remaining: number }> }) =>
      !galaxy.isPoiDepleted(poi.id) &&
      (poi.resources.length === 0 || poi.resources.some((r) => r.remaining > 0));

    for (const { poiType } of poiScores) {
      // Find all POIs of this type
      const normalizedTypes = poiType === "asteroid_belt"
        ? ["asteroid_belt", "asteroid"] : poiType === "gas_cloud"
        ? ["gas_cloud", "nebula"] : [poiType];

      const candidates: Array<{ systemId: string; poiId: string; distance: number }> = [];
      for (const type of normalizedTypes) {
        const pois = this.galaxy.findPoisByType(type as import("../types/game").PoiType);
        for (const { systemId, poi } of pois) {
          if (claimedBelts.has(poi.id)) continue;
          if (!hasResourcesLeft(poi)) continue;
          // Real BFS distance from bot's current system
          const distance = botSystem
            ? (systemId === botSystem ? 0 : this.galaxy.getDistance(botSystem, systemId))
            : 99;
          if (distance < 0) continue; // Unreachable system
          candidates.push({ systemId, poiId: poi.id, distance });
        }
      }

      if (candidates.length === 0) continue;

      // Pick closest
      candidates.sort((a, b) => a.distance - b.distance);
      const best = candidates[0];

      // Check if bot needs special equipment for this POI type
      const neededModule = POI_EQUIP[poiType];
      const hasModule = neededModule
        ? bot.moduleIds.some((id) => id.includes(neededModule))
        : true;
      const moduleInStorage = neededModule
        ? (economy.factionStorage.get(neededModule) ?? 0) > 0
        : false;

      // Skip ice/gas if bot lacks module AND none in faction storage
      if (neededModule && !hasModule && !moduleInStorage) continue;

      // Build equip/unequip lists
      const equipModules: string[] = [];
      const unequipModules: string[] = [];
      if (neededModule && !hasModule && moduleInStorage) {
        equipModules.push(neededModule);
      }
      // If going to asteroid belt but has ice/gas harvester, suggest unequip to free slot
      if (!neededModule) {
        for (const modId of bot.moduleIds) {
          if (modId.includes("ice_harvester") || modId.includes("gas_harvester")) {
            unequipModules.push(modId);
          }
        }
      }

      return {
        ...baseParams,
        targetBelt: best.poiId,
        equipModules,
        unequipModules,
      };
    }

    return baseParams;
  }

  /**
   * Build harvester params — focuses on ice/gas POIs (specialized extraction).
   * Harvester adds value over miner by targeting ice_field and gas_cloud with
   * specialized modules. Falls back to asteroid belts if no ice/gas available.
   */
  private buildHarvesterParams(
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    existingAssignments: Assignment[],
    world?: WorldContext,
  ): Record<string, unknown> {
    const homeBase = this.homeBase;
    const baseParams = {
      targets: [] as Array<{ poiId: string; priority: number }>,
      depositStation: homeBase,
      resourceType: "ore",
      depositToStorage: true,
      equipModules: [] as string[],
      unequipModules: [] as string[],
    };

    if (!this.galaxy) return baseParams;
    const galaxy = this.galaxy;

    const POI_ORE_MAP: Record<string, string[]> = {
      ice_field: ["ore_ice"],
      gas_cloud: ["ore_crystal", "ore_gas"],
      nebula: ["ore_crystal", "ore_gas"],
      asteroid_belt: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
      asteroid: ["ore_iron", "ore_copper", "ore_titanium", "ore_gold", "ore_nickel", "ore_sol"],
    };

    const POI_EQUIP: Record<string, string> = {
      ice_field: "ice_harvester",
      gas_cloud: "gas_harvester",
      nebula: "gas_harvester",
    };

    const RESOURCE_TYPE_MAP: Record<string, string> = {
      ice_field: "ice",
      gas_cloud: "gas",
      nebula: "gas",
      asteroid_belt: "ore",
      asteroid: "ore",
    };

    // ── Demand-driven harvesting: factor crafter needs + specialization ──
    // Compute crafter demand for ores (same as miner logic)
    const harvesterCrafterDemand = new Map<string, number>();
    for (const a of existingAssignments) {
      if (a.routine === "crafter" && a.params.recipeId && this.crafting) {
        const raws = this.crafting.getRawMaterials(String(a.params.recipeId), Number(a.params.count) || 1);
        for (const [itemId, qty] of raws) {
          if (itemId.startsWith("ore_")) {
            harvesterCrafterDemand.set(itemId, (harvesterCrafterDemand.get(itemId) ?? 0) + qty);
          }
        }
      }
    }

    // Score POI types: combine demand signal + storage deficit + specialization bonus
    const harvesterPoiScores: Array<{ poiType: string; score: number; specialized: boolean }> = [];
    const harvesterSeen = new Set<string>();
    for (const [poiType, orePatterns] of Object.entries(POI_ORE_MAP)) {
      const norm = poiType === "asteroid" ? "asteroid_belt" : poiType === "nebula" ? "gas_cloud" : poiType;
      if (harvesterSeen.has(norm)) continue;
      harvesterSeen.add(norm);

      const specialized = norm in POI_EQUIP;
      let score = specialized ? 30 : 0; // Harvesters prefer specialized extraction

      for (const prefix of orePatterns) {
        let stock = 0;
        for (const [itemId, qty] of economy.factionStorage) {
          if (itemId.startsWith(prefix)) stock += qty;
        }
        let demand = 0;
        for (const [itemId, qty] of harvesterCrafterDemand) {
          if (itemId.startsWith(prefix)) demand += qty;
        }
        const deficit = Math.max(0, demand - stock);
        score += deficit * 3;
        if (stock < 10) score += (10 - stock) * 2;
      }

      harvesterPoiScores.push({ poiType: norm, score, specialized });
    }
    harvesterPoiScores.sort((a, b) => b.score - a.score);

    // Collect POIs already claimed by miners or harvesters (this eval + persistent)
    const claimedPois = new Set<string>();
    for (const a of existingAssignments) {
      if (a.routine === "miner" && a.params.targetBelt) {
        claimedPois.add(String(a.params.targetBelt));
      }
      if (a.routine === "harvester" && Array.isArray(a.params.targets)) {
        for (const t of a.params.targets as Array<{ poiId: string }>) {
          claimedPois.add(t.poiId);
        }
      }
    }
    // Include persistent belt assignments from previous eval cycles
    for (const [botId, beltId] of this.activeBeltAssignments) {
      if (botId !== bot.botId) claimedPois.add(beltId);
    }

    const botSystem = bot.systemId ?? this.homeSystem;
    const hasResourcesLeft = (poi: { id: string; resources: Array<{ remaining: number }> }) =>
      !galaxy.isPoiDepleted(poi.id) &&
      (poi.resources.length === 0 || poi.resources.some((r) => r.remaining > 0));

    // Find the best POI type to harvest
    for (const { poiType } of harvesterPoiScores) {
      const normalizedTypes = poiType === "asteroid_belt"
        ? ["asteroid_belt", "asteroid"] : poiType === "gas_cloud"
        ? ["gas_cloud", "nebula"] : [poiType];

      const candidates: Array<{ systemId: string; poiId: string; distance: number }> = [];
      for (const type of normalizedTypes) {
        const pois = this.galaxy.findPoisByType(type as import("../types/game").PoiType);
        for (const { systemId, poi } of pois) {
          if (claimedPois.has(poi.id)) continue;
          if (!hasResourcesLeft(poi)) continue;
          const distance = botSystem
            ? (systemId === botSystem ? 0 : this.galaxy.getDistance(botSystem, systemId))
            : 99;
          if (distance < 0) continue; // Unreachable
          candidates.push({ systemId, poiId: poi.id, distance });
        }
      }

      if (candidates.length === 0) continue;

      // Check equipment availability
      const neededModule = POI_EQUIP[poiType];
      const hasModule = neededModule
        ? bot.moduleIds.some((id) => id.includes(neededModule))
        : true;
      const moduleInStorage = neededModule
        ? (economy.factionStorage.get(neededModule) ?? 0) > 0
        : false;

      if (neededModule && !hasModule && !moduleInStorage) continue;

      // Build equip/unequip lists
      const equipModules: string[] = [];
      const unequipModules: string[] = [];
      if (neededModule && !hasModule && moduleInStorage) {
        equipModules.push(neededModule);
      }
      // Unequip wrong harvester type if switching (e.g. ice→gas or gas→asteroid)
      if (!neededModule) {
        for (const modId of bot.moduleIds) {
          if (modId.includes("ice_harvester") || modId.includes("gas_harvester")) {
            unequipModules.push(modId);
          }
        }
      } else {
        // Unequip the OTHER harvester type if present
        const otherHarvester = neededModule === "ice_harvester" ? "gas_harvester" : "ice_harvester";
        for (const modId of bot.moduleIds) {
          if (modId.includes(otherHarvester)) {
            unequipModules.push(modId);
          }
        }
      }

      // Sort by distance, build targets array (harvester can visit multiple POIs)
      candidates.sort((a, b) => a.distance - b.distance);
      const targets = candidates.slice(0, 3).map((c, i) => ({
        poiId: c.poiId,
        priority: 3 - i,
      }));

      return {
        ...baseParams,
        targets,
        resourceType: RESOURCE_TYPE_MAP[poiType] ?? "ore",
        equipModules,
        unequipModules,
      };
    }

    return baseParams;
  }

  private buildReasoning(
    assignments: Assignment[],
    candidates: FleetBotInfo[],
    economy: EconomySnapshot,
    goals: Goal[]
  ): string {
    const parts: string[] = [];

    // Goals summary
    if (goals.length > 0) {
      parts.push(`Goals: ${goals.map((g) => `${g.type}(p${g.priority})`).join(", ")}`);
    } else {
      parts.push("No active goals, using balanced strategy.");
    }

    // Economy summary
    if (economy.deficits.length > 0) {
      const criticalCount = economy.deficits.filter((d) => d.priority === "critical").length;
      parts.push(`Deficits: ${economy.deficits.length} (${criticalCount} critical)`);
    }
    if (economy.inventoryAlerts.length > 0) {
      parts.push(`Inventory alerts: ${economy.inventoryAlerts.length}`);
    }

    // Assignment summary
    if (assignments.length > 0) {
      parts.push(`Reassigning ${assignments.length} bot(s):`);
      for (const a of assignments) {
        const prev = a.previousRoutine ? ` (was: ${a.previousRoutine})` : "";
        parts.push(`  ${a.botId} → ${a.routine} (score: ${a.score.toFixed(0)})${prev}`);
      }
    } else {
      parts.push("No reassignments needed.");
    }

    return parts.join(" | ");
  }
}
