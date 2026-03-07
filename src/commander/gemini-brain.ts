/**
 * Gemini Brain - Google Gemini 2.5 Pro via @ai-sdk/google.
 * Cloud LLM for fleet evaluation.
 */

import { google } from "@ai-sdk/google";
import { LlmBrain } from "./llm-brain";

export interface GeminiBrainConfig {
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export function createGeminiBrain(config: GeminiBrainConfig = {}): LlmBrain {
  const modelName = config.model ?? "gemini-2.5-pro";
  const model = google(modelName);

  return new LlmBrain({
    name: `gemini/${modelName}`,
    model,
    maxTokens: config.maxTokens ?? 1024,
    timeoutMs: config.timeoutMs ?? 30_000,
  });
}
