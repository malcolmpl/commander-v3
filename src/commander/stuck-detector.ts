/**
 * Stuck bot detector (inspired by CHAPERON's log monitor).
 * Detects bots whose routineState hasn't changed in a configurable window.
 * Can trigger early re-evaluation when a bot appears stuck.
 */

import type { FleetStatus } from "../bot/types";
import type { StuckBot } from "../types/protocol";

const DEFAULT_STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

interface BotStateSnapshot {
  routineState: string;
  routine: string | null;
  lastChangeAt: number;
}

export class StuckDetector {
  private snapshots = new Map<string, BotStateSnapshot>();
  private stuckThresholdMs: number;

  constructor(thresholdMs?: number) {
    this.stuckThresholdMs = thresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
  }

  /** Update with current fleet state. Returns list of stuck bots. */
  update(fleet: FleetStatus): StuckBot[] {
    const now = Date.now();
    const stuckBots: StuckBot[] = [];

    for (const bot of fleet.bots) {
      if (bot.status !== "running") {
        this.snapshots.delete(bot.botId);
        continue;
      }

      const prev = this.snapshots.get(bot.botId);
      const currentState = `${bot.routine}:${bot.routineState}`;

      if (!prev || prev.routineState !== currentState) {
        // State changed — reset timer
        this.snapshots.set(bot.botId, {
          routineState: currentState,
          routine: bot.routine,
          lastChangeAt: now,
        });
      } else {
        // State unchanged — check if stuck
        const stuckDuration = now - prev.lastChangeAt;
        if (stuckDuration >= this.stuckThresholdMs) {
          stuckBots.push({
            botId: bot.botId,
            username: bot.username,
            routine: bot.routine,
            stuckSinceMs: stuckDuration,
            lastStateChange: new Date(prev.lastChangeAt).toISOString(),
          });
        }
      }
    }

    // Clean up bots that are no longer in the fleet
    const activeBotIds = new Set(fleet.bots.map((b) => b.botId));
    for (const botId of this.snapshots.keys()) {
      if (!activeBotIds.has(botId)) {
        this.snapshots.delete(botId);
      }
    }

    return stuckBots;
  }

  /** Check if any bots are currently stuck (without updating) */
  hasStuckBots(): boolean {
    const now = Date.now();
    for (const snap of this.snapshots.values()) {
      if (now - snap.lastChangeAt >= this.stuckThresholdMs) return true;
    }
    return false;
  }
}
