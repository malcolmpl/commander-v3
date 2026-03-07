/**
 * Persistent commander memory store (inspired by CHAPERON).
 * Stores strategic facts that persist across evaluation cycles.
 * Examples: "System X has best iron prices", "Bot Y performs well as miner"
 */

import type { DB } from "./db";
import { commanderMemory } from "./schema";
import { eq } from "drizzle-orm";

export interface MemoryFact {
  key: string;
  fact: string;
  importance: number;
  updatedAt: string;
}

export class MemoryStore {
  constructor(private db: DB) {}

  /** Record or update a memory fact */
  set(key: string, fact: string, importance: number = 5): void {
    this.db
      .insert(commanderMemory)
      .values({
        key,
        fact,
        importance: Math.max(0, Math.min(10, importance)),
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: commanderMemory.key,
        set: {
          fact,
          importance: Math.max(0, Math.min(10, importance)),
          updatedAt: new Date().toISOString(),
        },
      })
      .run();
  }

  /** Get a specific memory */
  get(key: string): MemoryFact | null {
    const row = this.db
      .select()
      .from(commanderMemory)
      .where(eq(commanderMemory.key, key))
      .get();
    return row ? { ...row, updatedAt: row.updatedAt ?? new Date().toISOString() } : null;
  }

  /** Get all memories, sorted by importance desc */
  getAll(): MemoryFact[] {
    return this.db
      .select()
      .from(commanderMemory)
      .orderBy(commanderMemory.importance)
      .all()
      .reverse()
      .map((r) => ({ ...r, updatedAt: r.updatedAt ?? new Date().toISOString() }));
  }

  /** Get top N memories by importance (for LLM context injection) */
  getTop(n: number): MemoryFact[] {
    return this.getAll().slice(0, n);
  }

  /** Delete a memory */
  delete(key: string): void {
    this.db.delete(commanderMemory).where(eq(commanderMemory.key, key)).run();
  }

  /** Get memory count */
  count(): number {
    return this.getAll().length;
  }

  /** Build a text block for LLM context injection */
  buildContextBlock(): string {
    const memories = this.getTop(20);
    if (memories.length === 0) return "";

    const lines = memories.map(
      (m) => `  [${m.importance}] ${m.key}: ${m.fact}`
    );
    return `COMMANDER MEMORY (persistent knowledge):\n${lines.join("\n")}`;
  }
}
