/**
 * LLM Brain - shared implementation for all LLM-backed brains.
 * Handles prompt building, response parsing, health tracking, and error recovery.
 * Ollama, Gemini, and Claude brains are thin wrappers around this.
 */

import { generateText, type LanguageModel } from "ai";
import type {
  CommanderBrain,
  EvaluationInput,
  EvaluationOutput,
  BrainHealth,
  Assignment,
  ReassignmentState,
} from "./types";
import { buildSystemPrompt, buildUserPrompt, parseLlmResponse } from "./prompt-builder";

export interface LlmBrainConfig {
  name: string;
  model: LanguageModel;
  maxTokens?: number;
  timeoutMs?: number;
  /** Prefix prepended to user prompt (e.g. "/no_think\n" for Ollama qwen3) */
  promptPrefix?: string;
}

/** Rolling window for latency/success tracking */
const HEALTH_WINDOW = 20;

export class LlmBrain implements CommanderBrain {
  readonly name: string;
  private readonly model: LanguageModel;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly systemPrompt: string;

  private readonly promptPrefix: string;

  // Health tracking
  private latencies: number[] = [];
  private successes: boolean[] = [];
  private lastError?: string;

  // Reassignment cooldowns
  private reassignments = new Map<string, ReassignmentState>();
  private reassignmentCooldownMs = 120_000; // 2 min default

  constructor(config: LlmBrainConfig) {
    this.name = config.name;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 1024;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.systemPrompt = buildSystemPrompt();
    this.promptPrefix = config.promptPrefix ?? "";
  }

  async evaluate(input: EvaluationInput): Promise<EvaluationOutput> {
    const startTime = Date.now();
    const userPrompt = buildUserPrompt(input, input.extraContext);
    const validBotIds = new Set(input.fleet.bots.map(b => b.botId));
    const now = Date.now();

    try {
      const result = await generateText({
        model: this.model,
        system: this.systemPrompt,
        prompt: this.promptPrefix + userPrompt,
        maxOutputTokens: this.maxTokens,
        abortSignal: AbortSignal.timeout(this.timeoutMs),
      });

      // Use text if available, fall back to reasoning content (qwen3 thinking mode)
      let responseText = result.text;
      if (!responseText && result.reasoning) {
        const parts = Array.isArray(result.reasoning) ? result.reasoning : [result.reasoning];
        responseText = parts.map((p: { text?: string }) => p.text ?? String(p)).join("\n");
      }

      if (!responseText) {
        throw new Error("Empty response from model (no text or reasoning)");
      }

      const parsed = parseLlmResponse(responseText, validBotIds);

      // Convert to full assignments with scores
      const assignments: Assignment[] = [];
      for (const a of parsed.assignments) {
        const bot = input.fleet.bots.find(b => b.botId === a.botId);
        if (!bot) continue;

        // Skip if on cooldown
        if (!this.canReassign(a.botId, now)) continue;

        // Skip if already on this routine
        if (bot.routine === a.routine && bot.status === "running") continue;

        assignments.push({
          botId: a.botId,
          routine: a.routine,
          params: {},
          score: 100, // LLM doesn't produce numeric scores
          reasoning: a.reasoning,
          previousRoutine: bot.routine,
        });

        // Record assignment
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
        tokenUsage: result.usage ? {
          input: result.usage.inputTokens ?? 0,
          output: result.usage.outputTokens ?? 0,
        } : undefined,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.recordHealth(false, latencyMs);

      throw err; // Let tiered brain handle fallback
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

    // Keep rolling window
    if (this.successes.length > HEALTH_WINDOW) {
      this.successes.shift();
      this.latencies.shift();
    }
  }
}
