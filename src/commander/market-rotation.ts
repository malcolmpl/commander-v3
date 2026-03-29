import type { StationScanPriority } from "./types";

export interface MarketRotationConfig {
  hubSystemId: string;
  staleThresholdMs?: number;
}

const DEFAULT_STALE_MS = 900_000;
const DISTANCE_BONUS_FACTOR = 0.1;
const NEVER_SCANNED_AGE = 999_999_999;

export class MarketRotation {
  private stations = new Map<string, StationScanPriority>();
  private assignments = new Map<string, string>();
  private config: MarketRotationConfig;

  constructor(config: MarketRotationConfig) {
    this.config = config;
  }

  updateStation(stationId: string, systemId: string, ageMs: number, distanceFromHub: number): void {
    const existing = this.stations.get(stationId);
    const assignedBot = existing?.assignedBot ?? null;
    const ageNorm = ageMs === Infinity ? NEVER_SCANNED_AGE : ageMs / 60_000;
    const distBonus = 1 + distanceFromHub * DISTANCE_BONUS_FACTOR;
    const priority = ageNorm * distBonus;
    this.stations.set(stationId, {
      stationId, systemId, ageMs, distanceFromHub, priority, assignedBot,
    });
  }

  getQueue(): StationScanPriority[] {
    return Array.from(this.stations.values())
      .sort((a, b) => b.priority - a.priority);
  }

  assignBot(botId: string): StationScanPriority | null {
    this.clearAssignment(botId);
    const queue = this.getQueue();
    for (const station of queue) {
      if (!station.assignedBot) {
        station.assignedBot = botId;
        this.assignments.set(botId, station.stationId);
        return station;
      }
    }
    return null;
  }

  clearAssignment(botId: string): void {
    const stationId = this.assignments.get(botId);
    if (stationId) {
      const station = this.stations.get(stationId);
      if (station) station.assignedBot = null;
      this.assignments.delete(botId);
    }
  }

  getStaleCount(thresholdMs?: number): number {
    const threshold = thresholdMs ?? this.config.staleThresholdMs ?? DEFAULT_STALE_MS;
    let count = 0;
    for (const s of this.stations.values()) {
      if (s.ageMs > threshold) count++;
    }
    return count;
  }

  getTotalStations(): number {
    return this.stations.size;
  }

  getCoverage(thresholdMs?: number): number {
    const total = this.stations.size;
    if (total === 0) return 0;
    const fresh = total - this.getStaleCount(thresholdMs);
    return fresh / total;
  }

  getTopTargets(n = 5): StationScanPriority[] {
    return this.getQueue()
      .filter(s => !s.assignedBot)
      .slice(0, n);
  }
}
