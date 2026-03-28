/**
 * Tiered Brain - routes evaluation through an ordered chain of brains
 * with automatic fallback on failure. Optional shadow mode runs
 * the deterministic ScoringBrain in parallel for comparison logging.
 */

import type {
  CommanderBrain,
  EvaluationInput,
  EvaluationOutput,
  BrainHealth,
} from "./types";

export interface TieredBrainConfig {
  /** Ordered list of brains to try (first = preferred) */
  tiers: CommanderBrain[];
  /** If true, also run ScoringBrain in shadow and log comparison */
  shadowBrain?: CommanderBrain;
  /** Callback for shadow comparison results */
  onShadowResult?: (primary: EvaluationOutput, shadow: EvaluationOutput) => void;
}

export class TieredBrain implements CommanderBrain {
  private readonly tiers: CommanderBrain[];
  private readonly shadowBrain?: CommanderBrain;
  private readonly onShadowResult?: (primary: EvaluationOutput, shadow: EvaluationOutput) => void;
  private lastUsedBrain: string = "none";

  constructor(config: TieredBrainConfig) {
    this.tiers = config.tiers;
    this.shadowBrain = config.shadowBrain;
    this.onShadowResult = config.onShadowResult;
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    const errors: Array<{ brain: string; error: string }> = [];
    let lastEmptyResult: EvaluationOutput | null = null;

    // Try each tier in order
    for (const brain of this.tiers) {
      const health = brain.getHealth?.();

      // Skip unavailable brains
      if (health && !health.available) {
        errors.push({ brain: health.name, error: "unavailable (low success rate)" });
        continue;
      }

      try {
        const result = await brain.evaluate(input);

        // Treat 0 assignments as a soft failure if bots are available
        // (LLM brains sometimes return empty results without erroring)
        const availableBots = input.fleet.bots.filter(
          b => b.status === "ready" || b.status === "running"
        ).length;
        if (result.assignments.length === 0 && availableBots > 0) {
          const name = health?.name ?? result.brainName;
          console.log(`[TieredBrain] ${name} returned 0 assignments for ${availableBots} bots, trying next tier...`);
          errors.push({ brain: name, error: "returned 0 assignments" });
          lastEmptyResult = result;
          continue;
        }

        this.lastUsedBrain = result.brainName;

        // Run shadow comparison in background (non-blocking)
        if (this.shadowBrain && this.onShadowResult) {
          this.runShadow(input, result);
        }

        return result;
      } catch (err) {
        const name = health?.name ?? "unknown";
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ brain: name, error: msg });
        console.log(`[TieredBrain] ${name} failed: ${msg}, trying next tier...`);
      }
    }

    // If all tiers returned empty (not hard failures), return the last empty result
    // rather than throwing — this handles the case where scoring brain legitimately returns 0
    if (lastEmptyResult) {
      this.lastUsedBrain = lastEmptyResult.brainName;
      return lastEmptyResult;
    }

    // All tiers failed
    const errorSummary = errors.map(e => `${e.brain}: ${e.error}`).join("; ");
    throw new Error(`All brain tiers exhausted: ${errorSummary}`);
  }

  clearCooldown(botId: string): void {
    for (const brain of this.tiers) {
      brain.clearCooldown(botId);
    }
    this.shadowBrain?.clearCooldown(botId);
  }

  getHealth(): BrainHealth {
    const tierHealths = this.tiers
      .map(b => b.getHealth?.())
      .filter((h): h is BrainHealth => h !== undefined);

    const anyAvailable = tierHealths.some(h => h.available);
    const avgLatency = tierHealths.length > 0
      ? tierHealths.reduce((s, h) => s + h.avgLatencyMs, 0) / tierHealths.length
      : 0;

    return {
      name: `tiered(${this.lastUsedBrain})`,
      available: anyAvailable || this.tiers.length > 0,
      avgLatencyMs: Math.round(avgLatency),
      successRate: tierHealths.length > 0
        ? tierHealths.reduce((s, h) => s + h.successRate, 0) / tierHealths.length
        : 1,
      lastError: tierHealths.find(h => h.lastError)?.lastError,
    };
  }

  /** Get health for all tiers (for dashboard) */
  getTierHealths(): BrainHealth[] {
    return this.tiers
      .map(b => b.getHealth?.())
      .filter((h): h is BrainHealth => h !== undefined);
  }

  /** Which brain was used for the last evaluation */
  getLastUsedBrain(): string {
    return this.lastUsedBrain;
  }

  /** Get a tier brain by name prefix (e.g., "ollama" matches "ollama/qwen3:8b") */
  getTierByPrefix(prefix: string): CommanderBrain | undefined {
    return this.tiers.find(b => {
      const name = b.getHealth?.()?.name ?? (b as any).name ?? "";
      return name.startsWith(prefix);
    });
  }

  private async runShadow(input: EvaluationInput, primary: EvaluationOutput): Promise<void> {
    try {
      const shadow = await this.shadowBrain!.evaluate(input);
      this.onShadowResult!(primary, shadow);
    } catch (err) {
      // Shadow failures are non-critical
      console.log(`[TieredBrain] Shadow brain failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
