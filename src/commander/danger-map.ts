export interface DangerMapConfig {
  decayHalfLifeMs: number;
  maxScore: number;
}

interface AttackRecord {
  attacks: number;
  events: Array<{ score: number; at: number }>;
}

const ATTACK_SCORE = 0.15;
const DANGER_MULTIPLIER = 5.0;
const ESCORT_THRESHOLD = 0.5;

export class DangerMap {
  private systems = new Map<string, AttackRecord>();
  private config: DangerMapConfig;

  constructor(config: DangerMapConfig) {
    this.config = config;
  }

  recordAttack(systemId: string, timestamp: number): void {
    let record = this.systems.get(systemId);
    if (!record) {
      record = { attacks: 0, events: [] };
      this.systems.set(systemId, record);
    }
    record.attacks++;
    record.events.push({ score: ATTACK_SCORE, at: timestamp });
    const cutoff = timestamp - this.config.decayHalfLifeMs * 4;
    record.events = record.events.filter(e => e.at > cutoff);
    const score = this.getScore(systemId);
    console.log(`[DangerMap] Attack in ${systemId}, score now ${(score * 100).toFixed(0)}% (${record.attacks} total)`);
  }

  getScore(systemId: string): number {
    const record = this.systems.get(systemId);
    if (!record || record.events.length === 0) return 0;
    const now = Date.now();
    let total = 0;
    for (const event of record.events) {
      const age = now - event.at;
      const decay = Math.pow(0.5, age / this.config.decayHalfLifeMs);
      total += event.score * decay;
    }
    return Math.min(total, this.config.maxScore);
  }

  getRouteCost(systemIds: string[]): number {
    let cost = 0;
    for (const sid of systemIds) {
      const danger = this.getScore(sid);
      cost += 1.0 + danger * DANGER_MULTIPLIER;
    }
    return cost;
  }

  needsEscort(systemId: string): boolean {
    return this.getScore(systemId) >= ESCORT_THRESHOLD;
  }

  getAllDangerous(threshold = 0.1): Array<{ systemId: string; score: number; attacks: number; lastAttack: number }> {
    const result: Array<{ systemId: string; score: number; attacks: number; lastAttack: number }> = [];
    for (const [systemId, record] of this.systems) {
      const score = this.getScore(systemId);
      if (score >= threshold) {
        const lastAttack = record.events.length > 0
          ? Math.max(...record.events.map(e => e.at))
          : 0;
        result.push({ systemId, score, attacks: record.attacks, lastAttack });
      }
    }
    return result.sort((a, b) => b.score - a.score);
  }

  serialize(): string {
    const data: Record<string, { attacks: number; events: Array<{ score: number; at: number }> }> = {};
    for (const [systemId, record] of this.systems) {
      data[systemId] = record;
    }
    return JSON.stringify(data);
  }

  static deserialize(json: string, config: DangerMapConfig): DangerMap {
    const dm = new DangerMap(config);
    try {
      const data = JSON.parse(json);
      for (const [systemId, record] of Object.entries(data) as Array<[string, AttackRecord]>) {
        dm.systems.set(systemId, record);
      }
    } catch { /* corrupted data, start fresh */ }
    return dm;
  }
}
