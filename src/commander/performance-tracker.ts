/**
 * Performance Tracker - tracks per-bot outcome metrics between eval cycles.
 * Records credit deltas per routine so the LLM can learn which assignments work.
 */

import type { FleetStatus } from "../bot/types";

interface BotSnapshot {
  botId: string;
  username: string;
  routine: string | null;
  credits: number;
  /** When this routine assignment started */
  timestamp: number;
}

export interface OutcomeRecord {
  botId: string;
  username: string;
  routine: string;
  creditsDelta: number;
  durationMs: number;
  creditsPerMin: number;
  timestamp: number;
}

export class PerformanceTracker {
  private snapshots = new Map<string, BotSnapshot>();
  private outcomes: OutcomeRecord[] = [];
  private maxOutcomes = 100;

  /**
   * Call once per eval cycle with current fleet state.
   * Detects routine changes and records completed outcomes.
   */
  update(fleet: FleetStatus): void {
    const now = Date.now();

    for (const bot of fleet.bots) {
      const prev = this.snapshots.get(bot.botId);

      if (prev && prev.routine && prev.routine !== (bot.routine ?? bot.lastRoutine)) {
        // Routine changed — record outcome of the completed routine
        const duration = now - prev.timestamp;
        if (duration > 60_000) { // Only record if routine ran > 1 min
          const delta = bot.credits - prev.credits;
          this.outcomes.push({
            botId: bot.botId,
            username: prev.username,
            routine: prev.routine,
            creditsDelta: delta,
            durationMs: duration,
            creditsPerMin: duration > 0 ? (delta / duration) * 60_000 : 0,
            timestamp: now,
          });
          if (this.outcomes.length > this.maxOutcomes) this.outcomes.shift();
        }
      }

      // Update snapshot — only reset timestamp when routine actually changes
      const currentRoutine = bot.routine ?? bot.lastRoutine;
      this.snapshots.set(bot.botId, {
        botId: bot.botId,
        username: bot.username,
        routine: currentRoutine,
        credits: prev?.routine === currentRoutine ? prev.credits : bot.credits,
        timestamp: prev?.routine === currentRoutine ? prev.timestamp : now,
      });
    }
  }

  /** Get the N most recent completed outcomes */
  getRecentOutcomes(limit = 10): OutcomeRecord[] {
    return this.outcomes.slice(-limit);
  }

  /** Aggregate stats per routine */
  getRoutineStats(): Map<string, { avgCreditsPerMin: number; count: number }> {
    const accum = new Map<string, { totalCpm: number; count: number }>();
    for (const o of this.outcomes) {
      const existing = accum.get(o.routine) ?? { totalCpm: 0, count: 0 };
      existing.totalCpm += o.creditsPerMin;
      existing.count++;
      accum.set(o.routine, existing);
    }
    const result = new Map<string, { avgCreditsPerMin: number; count: number }>();
    for (const [routine, s] of accum) {
      result.set(routine, { avgCreditsPerMin: s.totalCpm / s.count, count: s.count });
    }
    return result;
  }

  /** Build a text block for LLM prompt injection */
  buildContextBlock(): string {
    const recent = this.getRecentOutcomes(8);
    if (recent.length === 0) return "";

    const lines = recent.map(o => {
      const mins = Math.round(o.durationMs / 60_000);
      const sign = o.creditsDelta >= 0 ? "+" : "";
      return `  ${o.username} on ${o.routine}: ${sign}${o.creditsDelta}cr in ${mins}min (${sign}${Math.round(o.creditsPerMin)}cr/min)`;
    });

    const stats = this.getRoutineStats();
    const statLines = [...stats.entries()]
      .sort((a, b) => b[1].avgCreditsPerMin - a[1].avgCreditsPerMin)
      .map(([routine, s]) => `  ${routine}: avg ${Math.round(s.avgCreditsPerMin)}cr/min (${s.count} samples)`)
      .slice(0, 6);

    const parts = [`RECENT OUTCOMES:\n${lines.join("\n")}`];
    if (statLines.length > 0) {
      parts.push(`ROUTINE PERFORMANCE:\n${statLines.join("\n")}`);
    }
    return parts.join("\n\n");
  }
}
