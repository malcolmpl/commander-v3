/**
 * Contextual Bandit Brain (LinUCB) — learns per-role routine weights from outcomes.
 *
 * Replaces the hardcoded base weights in the scoring brain with learned values.
 * Uses LinUCB (Linear Upper Confidence Bound) algorithm:
 *   score = context · weights + α · sqrt(context · A_inv · context)
 *
 * Per-role: each BotRole has its own weight vectors (one per routine/arm).
 * Context includes ship stats, economy state, goal weights — so different ships
 * within the same role get different scores.
 *
 * Persists to PostgreSQL (bandit_weights table) with tenant scoping for crash recovery.
 * Falls back to scoring brain defaults when no data exists.
 */

import { eq } from "drizzle-orm";
import type { DB } from "../data/db";
import { banditWeights, banditEpisodes } from "../data/schema";
import type { BotRole } from "./roles";
import type { RoutineName } from "../types/protocol";
import type { FleetBotInfo } from "../bot/types";
import type { EconomySnapshot } from "./types";
import type { Goal } from "../config/schema";

// ── Context Feature Extraction ──

/** Number of features in the context vector */
export const CONTEXT_DIM = 23;

/** Feature names (for debugging) */
export const FEATURE_NAMES = [
  "fuel_pct", "cargo_pct", "hull_pct", "credits_log",
  "speed", "cargo_capacity_log", "has_mining_laser", "has_weapon",
  "has_ice_harvester", "has_gas_harvester", "has_cargo_expander",
  "has_shield", "has_scanner",
  "distance_to_home", "docked",
  "deficit_count", "surplus_count", "net_profit_sign",
  "market_freshness", "fleet_size_log",
  "goal_income", "goal_explore",
  "danger_level",
];

/**
 * Extract a fixed-size context vector from bot state + economy + goals.
 * All values normalized to roughly [0, 1] range.
 */
export function extractContext(
  bot: FleetBotInfo,
  economy: EconomySnapshot,
  goals: Goal[],
  fleetSize: number,
  homeSystem?: string,
): number[] {
  const mods = bot.moduleIds.map(m => m.toLowerCase());

  // Goal signals: extract weight for income-related and explore-related goals
  let goalIncome = 0, goalExplore = 0;
  for (const g of goals) {
    const w = g.priority / 10; // Normalize priority to ~0-1
    if (g.type === "maximize_income" || g.type === "establish_trade_route") goalIncome += w;
    if (g.type === "explore_region" || g.type === "level_skills") goalExplore += w;
  }

  return [
    (bot.fuelPct ?? 100) / 100,                                    // 0: fuel_pct
    (bot.cargoPct ?? 0) / 100,                                     // 1: cargo_pct
    (bot.hullPct ?? 100) / 100,                                    // 2: hull_pct
    Math.log10(Math.max(1, bot.credits ?? 1000)) / 6,              // 3: credits_log (normalized by log10(1M)=6)
    (bot.speed ?? 3) / 10,                                         // 4: speed
    Math.log10(Math.max(1, bot.cargoCapacity ?? 70)) / 3,          // 5: cargo_capacity_log
    mods.some(m => m.includes("mining_laser")) ? 1 : 0,            // 6: has_mining_laser
    mods.some(m => m.includes("pulse_laser") || m.includes("autocannon") || m.includes("railgun")) ? 1 : 0, // 7: has_weapon
    mods.some(m => m.includes("ice_harvester")) ? 1 : 0,           // 8: has_ice_harvester
    mods.some(m => m.includes("gas_harvester")) ? 1 : 0,           // 9: has_gas_harvester
    mods.some(m => m.includes("cargo_expander")) ? 1 : 0,          // 10: has_cargo_expander
    mods.some(m => m.includes("shield")) ? 1 : 0,                  // 11: has_shield
    mods.some(m => m.includes("scanner")) ? 1 : 0,                 // 12: has_scanner
    homeSystem && bot.systemId ? (bot.systemId === homeSystem ? 0 : 0.5) : 0.5, // 13: distance_to_home (rough)
    bot.docked ? 1 : 0,                                            // 14: docked
    Math.min(economy.deficits.length / 10, 1),                     // 15: deficit_count
    Math.min(economy.surpluses.length / 10, 1),                    // 16: surplus_count
    economy.netProfit > 0 ? 1 : (economy.netProfit < 0 ? -1 : 0), // 17: net_profit_sign
    Math.min(economy.dataFreshnessRatio ?? 0.5, 1),                // 18: market_freshness (real)
    Math.log10(Math.max(1, fleetSize)) / 2,                        // 19: fleet_size_log
    Math.min(goalIncome, 1),                                        // 20: goal_income
    Math.min(goalExplore, 1),                                       // 21: goal_explore
    0,                                                              // 22: danger_level (will be wired when danger map is integrated)
  ];
}

// ── LinUCB Per-Arm Model ──

interface ArmModel {
  /** Weight vector (d dimensions) */
  theta: number[];
  /** A matrix (d × d) — sum of outer products + λI */
  A: number[][];
  /** b vector (d dimensions) — sum of reward × context */
  b: number[];
  /** Number of times this arm was pulled */
  pulls: number;
}

function createArmModel(dim: number, prior?: number[]): ArmModel {
  // Initialize A = λI (regularization)
  const lambda = 1.0;
  const A: number[][] = Array.from({ length: dim }, (_, i) =>
    Array.from({ length: dim }, (_, j) => i === j ? lambda : 0)
  );
  // Initialize b = 0 (or prior × λ if warm-starting)
  const b = prior
    ? prior.map(p => p * lambda)
    : new Array(dim).fill(0);
  const theta = prior ?? new Array(dim).fill(0);

  return { theta, A, b, pulls: 0 };
}

/**
 * Resize an arm's matrices if its dimension doesn't match current CONTEXT_DIM.
 * New features get identity-matrix diagonal (neutral regularization) and zero weights.
 */
function resizeArm(arm: ArmModel, targetDim: number): ArmModel {
  const oldDim = arm.theta.length;
  if (oldDim === targetDim) return arm;

  const theta = new Array(targetDim).fill(0);
  const b = new Array(targetDim).fill(0);
  const A: number[][] = Array.from({ length: targetDim }, (_, i) =>
    Array.from({ length: targetDim }, (_, j) => i === j ? 1 : 0)
  );

  const copyDim = Math.min(oldDim, targetDim);
  for (let i = 0; i < copyDim; i++) {
    theta[i] = arm.theta[i];
    b[i] = arm.b[i];
    for (let j = 0; j < copyDim; j++) {
      A[i][j] = arm.A[i][j];
    }
  }

  return { theta, A, b, pulls: arm.pulls };
}

/**
 * Compute UCB score for an arm given context.
 * score = theta · context + alpha × sqrt(context · A_inv · context)
 */
function ucbScore(arm: ArmModel, context: number[], alpha: number): number {
  // theta · context (exploitation)
  let exploit = 0;
  for (let i = 0; i < context.length; i++) {
    exploit += arm.theta[i] * context[i];
  }

  // A_inv · context (for exploration bonus)
  // Use simplified diagonal approximation for speed (full matrix inversion is O(d³))
  let explore = 0;
  for (let i = 0; i < context.length; i++) {
    const aiiInv = 1 / Math.max(arm.A[i][i], 0.001);
    explore += context[i] * context[i] * aiiInv;
  }

  return exploit + alpha * Math.sqrt(explore);
}

/**
 * Update arm model with observed reward.
 * A = A + context × context^T
 * b = b + reward × context
 * theta = A_inv × b (ridge regression solution)
 */
function updateArm(arm: ArmModel, context: number[], reward: number): void {
  const d = context.length;

  // A += context × context^T
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < d; j++) {
      arm.A[i][j] += context[i] * context[j];
    }
  }

  // b += reward × context
  for (let i = 0; i < d; i++) {
    arm.b[i] += reward * context[i];
  }

  arm.pulls++;

  // Solve theta = A_inv × b using diagonal approximation (fast, good enough)
  for (let i = 0; i < d; i++) {
    arm.theta[i] = arm.b[i] / Math.max(arm.A[i][i], 0.001);
  }
}

// ── Bandit Brain ──

/** Default base scores from the scoring brain (warm-start priors) */
const DEFAULT_BASE_SCORES: Record<string, number> = {
  miner: 50, harvester: 40, crafter: 90, trader: 65,
  quartermaster: 40, explorer: 40, hunter: 15, salvager: 15,
  scavenger: 10, mission_runner: 50, scout: 10,
  ship_upgrade: 0, refit: 0, return_home: 5,
};

/** Routines the bandit can score (excludes one-shot routines handled by constraints) */
const BANDIT_ROUTINES: RoutineName[] = [
  "miner", "harvester", "crafter", "trader", "quartermaster",
  "explorer", "hunter", "salvager", "scavenger", "mission_runner",
  "scout", "return_home",
];

export class BanditBrain {
  private models = new Map<string, Map<string, ArmModel>>(); // role → routine → ArmModel
  private alpha: number;
  private persistInterval: number;
  private lastPersist = 0;
  private dirty = false;

  constructor(
    private db: DB,
    private tenantId: string,
    config?: { alpha?: number; persistIntervalMs?: number },
  ) {
    this.alpha = config?.alpha ?? 0.5; // Exploration coefficient (0.5 = moderate exploration)
    this.persistInterval = config?.persistIntervalMs ?? 300_000; // Persist every 5 min
  }

  /** Async initializer — call after construction to load persisted weights. */
  async init(): Promise<void> {
    await this.loadFromDb();
  }

  /**
   * Get bandit-adjusted base score for a routine given bot context.
   * Returns a score that replaces the hardcoded baseScore in scoring brain.
   * Higher = more likely to be assigned.
   */
  getScore(
    role: string,
    routine: RoutineName,
    bot: FleetBotInfo,
    economy: EconomySnapshot,
    goals: Goal[],
    fleetSize: number,
    homeSystem?: string,
  ): number {
    if (!BANDIT_ROUTINES.includes(routine)) {
      return DEFAULT_BASE_SCORES[routine] ?? 0;
    }

    const context = extractContext(bot, economy, goals, fleetSize, homeSystem);
    const arm = this.getOrCreateArm(role, routine);

    // If very few pulls, blend with default to avoid cold-start noise
    const ucb = ucbScore(arm, context, this.alpha);
    const defaultScore = DEFAULT_BASE_SCORES[routine] ?? 0;

    if (arm.pulls < 10) {
      // Warm-start: mostly default, with increasing bandit influence
      const banditWeight = arm.pulls / 10;
      return defaultScore * (1 - banditWeight) + ucb * banditWeight;
    }

    return ucb;
  }

  /**
   * Record an episode outcome — updates the arm model for the given role+routine.
   */
  async recordOutcome(
    role: string,
    routine: RoutineName,
    context: number[],
    reward: number,
    metadata?: {
      botId?: string;
      durationSec?: number;
      goalType?: string;
      rewardBreakdown?: Record<string, number>;
    },
  ): Promise<void> {
    const arm = this.getOrCreateArm(role, routine);
    updateArm(arm, context, reward);
    this.dirty = true;

    // Log to database for analysis
    await (this.db as any).insert(banditEpisodes).values({
      tenantId: this.tenantId,
      role,
      routine,
      context: JSON.stringify(context),
      reward,
      rewardBreakdown: JSON.stringify(metadata?.rewardBreakdown ?? {}),
      durationSec: metadata?.durationSec ?? 0,
      goalType: metadata?.goalType ?? null,
      botId: metadata?.botId ?? "",
    });

    // Periodic persistence
    const now = Date.now();
    if (now - this.lastPersist > this.persistInterval) {
      await this.persistToDb();
      this.lastPersist = now;
    }
  }

  /**
   * Get all base scores for a role (for debugging/dashboard).
   */
  getRoleScores(role: string): Record<string, { score: number; pulls: number }> {
    const result: Record<string, { score: number; pulls: number }> = {};
    const roleModels = this.models.get(role);
    if (!roleModels) {
      for (const r of BANDIT_ROUTINES) {
        result[r] = { score: DEFAULT_BASE_SCORES[r] ?? 0, pulls: 0 };
      }
      return result;
    }

    for (const r of BANDIT_ROUTINES) {
      const arm = roleModels.get(r);
      if (arm) {
        // Use a neutral context for display (all 0.5)
        const neutralCtx = new Array(CONTEXT_DIM).fill(0.5);
        result[r] = { score: ucbScore(arm, neutralCtx, 0), pulls: arm.pulls }; // No exploration for display
      } else {
        result[r] = { score: DEFAULT_BASE_SCORES[r] ?? 0, pulls: 0 };
      }
    }
    return result;
  }

  /** Get total episodes recorded across all roles */
  getTotalEpisodes(): number {
    let total = 0;
    for (const roleModels of this.models.values()) {
      for (const arm of roleModels.values()) {
        total += arm.pulls;
      }
    }
    return total;
  }

  /** Set exploration coefficient at runtime */
  setAlpha(alpha: number): void {
    this.alpha = Math.max(0, Math.min(2, alpha));
  }

  /** Force persistence */
  async flush(): Promise<void> {
    if (this.dirty) await this.persistToDb();
  }

  // ── Private ──

  private getOrCreateArm(role: string, routine: string): ArmModel {
    let roleModels = this.models.get(role);
    if (!roleModels) {
      roleModels = new Map();
      this.models.set(role, roleModels);
    }

    let arm = roleModels.get(routine);
    if (!arm) {
      // Create with prior from default scoring brain weight
      const prior = new Array(CONTEXT_DIM).fill(0);
      // Set bias term (first feature is fuel which is ~0.5-1.0)
      // Spread the default score across features so it roughly sums to the default
      const defaultScore = DEFAULT_BASE_SCORES[routine] ?? 0;
      if (defaultScore !== 0) {
        const spreadWeight = defaultScore / CONTEXT_DIM;
        for (let i = 0; i < CONTEXT_DIM; i++) prior[i] = spreadWeight;
      }
      arm = createArmModel(CONTEXT_DIM, prior);
      roleModels.set(routine, arm);
    }

    return arm;
  }

  private async loadFromDb(): Promise<void> {
    const rows = await (this.db as any)
      .select()
      .from(banditWeights)
      .where(eq(banditWeights.tenantId, this.tenantId));

    for (const row of rows) {
      try {
        const weights: Record<string, number[]> = JSON.parse(row.weights);
        const covariance: Record<string, number[][]> = JSON.parse(row.covariance);

        const roleModels = new Map<string, ArmModel>();
        for (const [routine, theta] of Object.entries(weights)) {
          const A = covariance[routine] ?? Array.from({ length: CONTEXT_DIM }, (_, i) =>
            Array.from({ length: CONTEXT_DIM }, (_, j) => i === j ? 1 : 0)
          );
          const b = theta.map((t, i) => t * Math.max(A[i]?.[i] ?? 1, 0.001));
          const arm = resizeArm({ theta, A, b, pulls: row.episodeCount }, CONTEXT_DIM);
          roleModels.set(routine, arm);
        }
        this.models.set(row.role, roleModels);
      } catch {
        // Corrupted data, skip
      }
    }

    if (rows.length > 0) {
      console.log(`[Bandit] Loaded weights for ${rows.length} role(s), ${this.getTotalEpisodes()} episodes`);
    }
  }

  private async persistToDb(): Promise<void> {
    for (const [role, roleModels] of this.models) {
      const weights: Record<string, number[]> = {};
      const covariance: Record<string, number[][]> = {};
      let totalPulls = 0;

      for (const [routine, arm] of roleModels) {
        weights[routine] = arm.theta;
        covariance[routine] = arm.A;
        totalPulls += arm.pulls;
      }

      await (this.db as any).insert(banditWeights).values({
        tenantId: this.tenantId,
        role,
        weights: JSON.stringify(weights),
        covariance: JSON.stringify(covariance),
        episodeCount: totalPulls,
      }).onConflictDoUpdate({
        target: [banditWeights.tenantId, banditWeights.role],
        set: {
          weights: JSON.stringify(weights),
          covariance: JSON.stringify(covariance),
          episodeCount: totalPulls,
          updatedAt: new Date(),
        },
      });
    }

    this.dirty = false;
    console.log(`[Bandit] Persisted weights for ${this.models.size} role(s)`);
  }
}
