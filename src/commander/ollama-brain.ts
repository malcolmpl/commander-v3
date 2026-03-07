/**
 * Ollama Brain — calls Ollama's native /api/chat endpoint directly.
 * Uses think:false + stream:false for fast, clean JSON responses.
 * The OpenAI-compatible endpoint (/v1) doesn't properly support think:false,
 * causing qwen3 to waste all tokens on reasoning with empty content.
 * Native API: 3s per eval vs 40s+ through OpenAI compat layer.
 */

import type {
  CommanderBrain,
  EvaluationInput,
  EvaluationOutput,
  BrainHealth,
  Assignment,
  ReassignmentState,
} from "./types";
import { buildSystemPrompt, buildUserPrompt, parseLlmResponse } from "./prompt-builder";

export interface OllamaBrainConfig {
  baseUrl?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Rolling window for latency/success tracking */
const HEALTH_WINDOW = 20;

export function createOllamaBrain(config: OllamaBrainConfig = {}): OllamaNativeBrain {
  return new OllamaNativeBrain(config);
}

class OllamaNativeBrain implements CommanderBrain {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;

  // Health tracking
  private latencies: number[] = [];
  private successes: boolean[] = [];
  private lastError?: string;

  // Reassignment cooldowns
  private reassignments = new Map<string, ReassignmentState>();
  private reassignmentCooldownMs = 120_000;

  constructor(config: OllamaBrainConfig = {}) {
    this.model = config.model ?? "qwen3:8b";
    this.baseUrl = config.baseUrl ?? "http://localhost:11434";
    this.maxTokens = config.maxTokens ?? 1024;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.name = `ollama/${this.model}`;
    this.systemPrompt = buildSystemPrompt();
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    const startTime = Date.now();
    const userPrompt = buildUserPrompt(input);
    const validBotIds = new Set(input.fleet.bots.map(b => b.botId));
    const now = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          think: false,
          stream: false,
          messages: [
            { role: "system", content: this.systemPrompt },
            { role: "user", content: userPrompt },
          ],
          options: { num_predict: this.maxTokens },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        message?: { content?: string };
        eval_count?: number;
        prompt_eval_count?: number;
      };

      const responseText = data.message?.content ?? "";
      if (!responseText) {
        throw new Error("Empty response from Ollama");
      }

      const parsed = parseLlmResponse(responseText, validBotIds);

      // Convert to full assignments
      const assignments: Assignment[] = [];
      for (const a of parsed.assignments) {
        const bot = input.fleet.bots.find(b => b.botId === a.botId);
        if (!bot) continue;
        if (!this.canReassign(a.botId, now)) continue;
        if (bot.routine === a.routine && bot.status === "running") continue;

        assignments.push({
          botId: a.botId,
          routine: a.routine,
          params: {},
          score: 100,
          reasoning: a.reasoning,
          previousRoutine: bot.routine,
        });

        this.reassignments.set(a.botId, {
          lastAssignment: now,
          lastRoutine: a.routine,
          cooldownUntil: now + this.reassignmentCooldownMs,
        });
      }

      const latencyMs = Date.now() - startTime;
      this.recordHealth(true, latencyMs);

      return {
        assignments,
        reasoning: parsed.reasoning || `${this.name} evaluation`,
        brainName: this.name,
        latencyMs,
        confidence: parsed.confidence,
        tokenUsage: {
          input: data.prompt_eval_count ?? 0,
          output: data.eval_count ?? 0,
        },
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.recordHealth(false, latencyMs);
      throw err;
    }
  }

  canReassign(botId: string, now: number): boolean {
    const state = this.reassignments.get(botId);
    if (!state) return true;
    return now >= state.cooldownUntil;
  }

  clearCooldown(botId: string): void {
    this.reassignments.delete(botId);
  }

  clearAllCooldowns(): void {
    this.reassignments.clear();
  }

  getHealth(): BrainHealth {
    const total = this.successes.length;
    const successCount = this.successes.filter(Boolean).length;
    const avgLatency = this.latencies.length > 0
      ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length
      : 0;

    return {
      name: this.name,
      available: total === 0 || (successCount / total) > 0.3,
      avgLatencyMs: Math.round(avgLatency),
      successRate: total === 0 ? 1 : successCount / total,
      lastError: this.lastError,
    };
  }

  private recordHealth(success: boolean, latencyMs: number): void {
    this.successes.push(success);
    this.latencies.push(latencyMs);
    if (this.successes.length > HEALTH_WINDOW) {
      this.successes.shift();
      this.latencies.shift();
    }
  }
}
