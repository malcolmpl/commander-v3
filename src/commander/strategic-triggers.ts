/**
 * Strategic triggers — determines when the LLM brain should be consulted.
 * The scoring brain handles 95% of routine assignments deterministically.
 * The LLM is only called when something strategically interesting happens.
 *
 * This replaces the old "call LLM every 60s" pattern with event-driven invocation.
 */

import type { FleetStatus, FleetBotInfo } from "../bot/types";
import type { EconomySnapshot, WorldContext } from "./types";

/** Describes why the LLM was triggered */
export interface StrategicTrigger {
  type:
    | "credit_stagnation"    // Fleet earned very little in a sustained window
    | "market_shift"         // Major price change on a traded item
    | "capability_change"    // New ship, new recipe unlocked, new bot joined
    | "goal_change"          // User changed strategy goals
    | "fleet_composition"    // Fleet size or role distribution changed significantly
    | "supply_crisis"        // Critical supply deficit that scoring brain can't resolve
    | "periodic_review";     // Scheduled strategic review (every N minutes)
  /** Human-readable reason for this trigger */
  reason: string;
  /** Context to help the LLM reason about this specific trigger */
  context: Record<string, unknown>;
  /** Priority: higher = more urgent */
  priority: number;
}

/** Tracks state between evaluations to detect changes */
interface TriggerState {
  lastLlmCall: number;
  lastCredits: number;
  lastCreditCheck: number;
  lastBotCount: number;
  lastGoalHash: string;
  lastShipClasses: Map<string, string>; // botId → shipClass
  creditHistory: Array<{ credits: number; at: number }>;
  periodicIntervalMs: number;
}

const DEFAULT_STATE: TriggerState = {
  lastLlmCall: 0,
  lastCredits: 0,
  lastCreditCheck: 0,
  lastBotCount: 0,
  lastGoalHash: "",
  lastShipClasses: new Map(),
  creditHistory: [],
  periodicIntervalMs: 600_000, // 10 minutes between periodic reviews
};

/** Stagnation: less than this cr earned in the observation window triggers alert */
const STAGNATION_THRESHOLD_CR = 500;
const STAGNATION_WINDOW_MS = 1_800_000; // 30 minutes
const CREDIT_SAMPLE_INTERVAL_MS = 60_000; // Sample credits every 60s

/** Minimum time between any two LLM calls (prevent spamming) */
const MIN_LLM_INTERVAL_MS = 300_000; // 5 minutes

export class StrategicTriggerEngine {
  private state: TriggerState;

  constructor(config?: { periodicIntervalMs?: number }) {
    this.state = {
      ...DEFAULT_STATE,
      periodicIntervalMs: config?.periodicIntervalMs ?? DEFAULT_STATE.periodicIntervalMs,
    };
  }

  /**
   * Evaluate whether a strategic trigger should fire.
   * Called every eval cycle (scoring brain runs regardless).
   * Returns null if no trigger — scoring brain result stands alone.
   * Returns a trigger if LLM should be consulted for strategic advice.
   */
  evaluate(
    fleet: FleetStatus,
    economy: EconomySnapshot,
    world: WorldContext,
    goals: Array<{ type: string; priority: number }>,
  ): StrategicTrigger | null {
    const now = Date.now();

    // Hard minimum: don't call LLM more than once per 2 minutes
    if (now - this.state.lastLlmCall < MIN_LLM_INTERVAL_MS) return null;

    // Check triggers in priority order (return first match)
    const trigger =
      this.checkGoalChange(goals) ??
      this.checkSupplyCrisis(economy) ??
      this.checkCapabilityChange(fleet) ??
      this.checkCreditStagnation(fleet, now) ??
      this.checkFleetComposition(fleet) ??
      this.checkPeriodicReview(now, fleet, economy);

    if (trigger) {
      this.state.lastLlmCall = now;
    }

    // Always sample credits for stagnation detection
    this.sampleCredits(fleet.totalCredits, now);

    return trigger;
  }

  /** Record that an LLM call was made (even if not triggered by us) */
  recordLlmCall(): void {
    this.state.lastLlmCall = Date.now();
  }

  /** Get trigger state summary (for dashboard/debugging) */
  getState(): {
    lastLlmCallAgo: number;
    creditTrend: number;
    periodicIntervalMs: number;
  } {
    const now = Date.now();
    return {
      lastLlmCallAgo: now - this.state.lastLlmCall,
      creditTrend: this.computeCreditTrend(),
      periodicIntervalMs: this.state.periodicIntervalMs,
    };
  }

  // ── Individual Trigger Checks ──

  private checkGoalChange(goals: Array<{ type: string; priority: number }>): StrategicTrigger | null {
    const hash = goals.map(g => `${g.type}:${g.priority}`).sort().join("|");
    if (hash === this.state.lastGoalHash) return null;

    const isFirstEval = this.state.lastGoalHash === "";
    this.state.lastGoalHash = hash;

    // Don't trigger on first eval (startup)
    if (isFirstEval) return null;

    return {
      type: "goal_change",
      reason: `Fleet goals changed: ${goals.map(g => g.type).join(", ")}`,
      context: { goals },
      priority: 90,
    };
  }

  private checkSupplyCrisis(economy: EconomySnapshot): StrategicTrigger | null {
    const critical = economy.deficits.filter(d => d.priority === "critical");
    if (critical.length === 0) return null;

    // Only trigger if critical deficit persists (not just momentary)
    const totalShortfall = critical.reduce((s, d) => s + d.shortfall, 0);
    if (totalShortfall < 50) return null;

    return {
      type: "supply_crisis",
      reason: `Critical supply deficit: ${critical.map(d => `${d.itemId} (need ${d.demandPerHour}/hr, have ${d.supplyPerHour}/hr)`).join(", ")}`,
      context: { deficits: critical },
      priority: 85,
    };
  }

  private checkCapabilityChange(fleet: FleetStatus): StrategicTrigger | null {
    const changes: string[] = [];

    // New ships acquired
    for (const bot of fleet.bots) {
      const shipClass = bot.shipClass ?? "unknown";
      const lastClass = this.state.lastShipClasses.get(bot.botId);
      if (lastClass && lastClass !== shipClass) {
        changes.push(`${bot.username} upgraded: ${lastClass} → ${shipClass}`);
      }
      this.state.lastShipClasses.set(bot.botId, shipClass);
    }

    // New bots joined
    if (this.state.lastBotCount > 0 && fleet.bots.length > this.state.lastBotCount) {
      const newCount = fleet.bots.length - this.state.lastBotCount;
      changes.push(`${newCount} new bot(s) joined the fleet`);
    }
    this.state.lastBotCount = fleet.bots.length;

    if (changes.length === 0) return null;

    return {
      type: "capability_change",
      reason: changes.join("; "),
      context: { changes, botCount: fleet.bots.length },
      priority: 70,
    };
  }

  private checkCreditStagnation(fleet: FleetStatus, now: number): StrategicTrigger | null {
    const trend = this.computeCreditTrend();
    // Only flag if we have enough data and trend is flat/negative
    if (this.state.creditHistory.length < 5) return null;
    const windowStart = this.state.creditHistory[0]?.at ?? now;
    if (now - windowStart < STAGNATION_WINDOW_MS * 0.5) return null; // Need at least half the window

    if (trend > STAGNATION_THRESHOLD_CR) return null; // Earning well

    return {
      type: "credit_stagnation",
      reason: `Fleet earned only ${Math.round(trend)}cr in the last ${Math.round((now - windowStart) / 60_000)}min (threshold: ${STAGNATION_THRESHOLD_CR}cr)`,
      context: {
        creditDelta: trend,
        windowMinutes: Math.round((now - windowStart) / 60_000),
        currentCredits: fleet.totalCredits,
      },
      priority: 60,
    };
  }

  private checkFleetComposition(fleet: FleetStatus): StrategicTrigger | null {
    // Only trigger on significant size changes (±2 bots from last check)
    if (this.state.lastBotCount === 0) return null; // Skip first eval
    const delta = Math.abs(fleet.bots.length - this.state.lastBotCount);
    if (delta < 2) return null;

    return {
      type: "fleet_composition",
      reason: `Fleet size changed: ${this.state.lastBotCount} → ${fleet.bots.length} bots`,
      context: {
        previousCount: this.state.lastBotCount,
        currentCount: fleet.bots.length,
        roles: this.countRoles(fleet),
      },
      priority: 50,
    };
  }

  private checkPeriodicReview(
    now: number,
    fleet: FleetStatus,
    economy: EconomySnapshot,
  ): StrategicTrigger | null {
    if (now - this.state.lastLlmCall < this.state.periodicIntervalMs) return null;

    return {
      type: "periodic_review",
      reason: `Scheduled strategic review (every ${Math.round(this.state.periodicIntervalMs / 60_000)}min)`,
      context: {
        botCount: fleet.bots.length,
        totalCredits: fleet.totalCredits,
        deficitCount: economy.deficits.length,
        surplusCount: economy.surpluses.length,
        creditTrend: this.computeCreditTrend(),
      },
      priority: 20,
    };
  }

  // ── Helpers ──

  private sampleCredits(credits: number, now: number): void {
    if (now - this.state.lastCreditCheck < CREDIT_SAMPLE_INTERVAL_MS) return;
    this.state.lastCreditCheck = now;

    this.state.creditHistory.push({ credits, at: now });

    // Trim to stagnation window
    const cutoff = now - STAGNATION_WINDOW_MS;
    while (this.state.creditHistory.length > 0 && this.state.creditHistory[0].at < cutoff) {
      this.state.creditHistory.shift();
    }
  }

  private computeCreditTrend(): number {
    if (this.state.creditHistory.length < 2) return Infinity;
    const first = this.state.creditHistory[0];
    const last = this.state.creditHistory[this.state.creditHistory.length - 1];
    return last.credits - first.credits;
  }

  private countRoles(fleet: FleetStatus): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const bot of fleet.bots) {
      const role = bot.role ?? "generalist";
      counts[role] = (counts[role] ?? 0) + 1;
    }
    return counts;
  }
}
