/**
 * Embedding-based memory store for strategic decisions.
 * Uses nomic-embed-text via Ollama for local embeddings,
 * stored in SQLite for fast cosine-similarity retrieval.
 *
 * Replaces the dead RagStore with a working feedback loop:
 *   outcome → embed → store → retrieve similar → inject into LLM context
 */

import { desc, sql, eq } from "drizzle-orm";
import type { DB } from "../data/db";
import { outcomeEmbeddings } from "../data/schema";

const MAX_ENTRIES = 2000;
const PRUNE_TO = 1500;
const EMBED_DIM = 768; // nomic-embed-text dimension

export type OutcomeCategory =
  | "trade_outcome"
  | "mine_outcome"
  | "craft_outcome"
  | "market_intel"
  | "strategic"
  | "route_performance";

export interface OutcomeEntry {
  text: string;
  category: OutcomeCategory;
  metadata: Record<string, unknown>;
  profitImpact?: number;
}

export interface RetrievedMemory {
  id: number;
  text: string;
  category: string;
  metadata: Record<string, unknown>;
  profitImpact: number | null;
  similarity: number;
  createdAt: string;
}

export class EmbeddingStore {
  private ollamaUrl: string;
  private model: string;
  private available = true;
  private lastHealthCheck = 0;
  private healthCheckIntervalMs = 60_000;

  constructor(
    private db: DB,
    config?: { ollamaUrl?: string; model?: string },
  ) {
    this.ollamaUrl = config?.ollamaUrl ?? "http://localhost:11434";
    this.model = config?.model ?? "nomic-embed-text";
  }

  /** Check if Ollama embedding model is reachable */
  async checkHealth(): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastHealthCheck < this.healthCheckIntervalMs) return this.available;
    this.lastHealthCheck = now;

    try {
      const resp = await fetch(`${this.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!resp.ok) { this.available = false; return false; }
      const data = await resp.json() as { models?: Array<{ name: string }> };
      this.available = data.models?.some(m => m.name.startsWith(this.model)) ?? false;
      if (!this.available) {
        console.log(`[EmbeddingStore] Model ${this.model} not found in Ollama. Pull it with: ollama pull ${this.model}`);
      }
      return this.available;
    } catch {
      this.available = false;
      return false;
    }
  }

  /** Generate embedding vector from text via Ollama */
  private async embed(text: string): Promise<number[] | null> {
    if (!this.available) return null;

    try {
      const resp = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: AbortSignal.timeout(5000),
      });

      if (!resp.ok) return null;

      const data = await resp.json() as { embeddings?: number[][] };
      const vec = data.embeddings?.[0];
      if (!vec || vec.length !== EMBED_DIM) return null;
      return vec;
    } catch {
      return null;
    }
  }

  /** Cosine similarity between two vectors */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  /**
   * Store an outcome with its embedding.
   * Non-blocking: if Ollama is down, silently skips.
   */
  async store(entry: OutcomeEntry): Promise<boolean> {
    const vec = await this.embed(entry.text);
    if (!vec) return false;

    this.db.insert(outcomeEmbeddings).values({
      text: entry.text,
      embedding: JSON.stringify(vec),
      category: entry.category,
      metadata: JSON.stringify(entry.metadata),
      profitImpact: entry.profitImpact ?? null,
    }).run();

    this.pruneIfNeeded();
    return true;
  }

  /**
   * Retrieve the most similar memories to a query.
   * Returns top-k by cosine similarity, optionally filtered by category.
   */
  async retrieve(
    query: string,
    options?: { limit?: number; category?: OutcomeCategory; minSimilarity?: number },
  ): Promise<RetrievedMemory[]> {
    const limit = options?.limit ?? 5;
    const minSim = options?.minSimilarity ?? 0.3;

    const queryVec = await this.embed(query);
    if (!queryVec) {
      // Fallback: return recent entries by category (no embedding available)
      return this.retrieveRecent(limit, options?.category);
    }

    // Load all embeddings (or filtered by category)
    let rows: Array<{
      id: number;
      text: string;
      embedding: string;
      category: string;
      metadata: string;
      profitImpact: number | null;
      createdAt: string | null;
    }>;

    if (options?.category) {
      rows = this.db.select()
        .from(outcomeEmbeddings)
        .where(eq(outcomeEmbeddings.category, options.category))
        .all();
    } else {
      rows = this.db.select().from(outcomeEmbeddings).all();
    }

    // Score and rank by cosine similarity
    const scored: RetrievedMemory[] = [];
    for (const row of rows) {
      let storedVec: number[];
      try { storedVec = JSON.parse(row.embedding); } catch { continue; }

      const similarity = this.cosineSimilarity(queryVec, storedVec);
      if (similarity < minSim) continue;

      let metadata: Record<string, unknown>;
      try { metadata = JSON.parse(row.metadata); } catch { metadata = {}; }

      scored.push({
        id: row.id,
        text: row.text,
        category: row.category,
        metadata,
        profitImpact: row.profitImpact,
        similarity,
        createdAt: row.createdAt ?? new Date().toISOString(),
      });
    }

    // Sort by similarity descending, take top-k
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  }

  /** Fallback retrieval when embeddings unavailable — recent entries by category */
  private retrieveRecent(limit: number, category?: string): RetrievedMemory[] {
    let query = this.db.select().from(outcomeEmbeddings);
    let rows;
    if (category) {
      rows = query.where(eq(outcomeEmbeddings.category, category))
        .orderBy(desc(outcomeEmbeddings.id))
        .limit(limit)
        .all();
    } else {
      rows = query.orderBy(desc(outcomeEmbeddings.id)).limit(limit).all();
    }

    return rows.map(r => {
      let metadata: Record<string, unknown>;
      try { metadata = JSON.parse(r.metadata); } catch { metadata = {}; }
      return {
        id: r.id,
        text: r.text,
        category: r.category,
        metadata,
        profitImpact: r.profitImpact,
        similarity: 1.0, // No similarity score available
        createdAt: r.createdAt ?? new Date().toISOString(),
      };
    });
  }

  /**
   * Format retrieved memories as context for LLM injection.
   * Returns empty string if no relevant memories found.
   */
  async buildContextForQuery(
    query: string,
    options?: { limit?: number; category?: OutcomeCategory },
  ): Promise<string> {
    const memories = await this.retrieve(query, { limit: options?.limit ?? 5, category: options?.category });
    if (memories.length === 0) return "";

    const lines = memories.map(m => {
      const age = this.formatAge(m.createdAt);
      const profit = m.profitImpact != null
        ? ` (${m.profitImpact > 0 ? "+" : ""}${Math.round(m.profitImpact)}cr)`
        : "";
      return `  - [${age}] ${m.text}${profit}`;
    });

    return `RELEVANT PAST OUTCOMES:\n${lines.join("\n")}`;
  }

  /** Format a timestamp as relative age string */
  private formatAge(isoDate: string): string {
    const ageMs = Date.now() - new Date(isoDate).getTime();
    const hours = Math.floor(ageMs / 3_600_000);
    if (hours < 1) return `${Math.floor(ageMs / 60_000)}min ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  /** Prune old low-value entries when over cap */
  private pruneIfNeeded(): void {
    const count = (this.db.all(sql`SELECT COUNT(*) as count FROM outcome_embeddings`) as Array<{ count: number }>)[0]?.count ?? 0;
    if (count <= MAX_ENTRIES) return;

    const deleteCount = count - PRUNE_TO;
    // Delete oldest entries with lowest profit impact first
    this.db.run(sql`
      DELETE FROM outcome_embeddings
      WHERE id IN (
        SELECT id FROM outcome_embeddings
        ORDER BY COALESCE(profit_impact, 0) ASC, id ASC
        LIMIT ${deleteCount}
      )
    `);
    console.log(`[EmbeddingStore] Pruned ${deleteCount} old entries (${count} → ${PRUNE_TO})`);
  }

  /** Get store stats */
  getStats(): { totalEntries: number; categories: Record<string, number>; available: boolean } {
    const total = (this.db.all(sql`SELECT COUNT(*) as count FROM outcome_embeddings`) as Array<{ count: number }>)[0]?.count ?? 0;
    const cats = this.db.all(sql`
      SELECT category, COUNT(*) as count FROM outcome_embeddings GROUP BY category
    `) as Array<{ category: string; count: number }>;

    const categories: Record<string, number> = {};
    for (const c of cats) categories[c.category] = c.count;

    return { totalEntries: total, categories, available: this.available };
  }

  /** Whether the embedding model is available */
  isAvailable(): boolean { return this.available; }
}
