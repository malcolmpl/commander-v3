/**
 * Config schema + loader tests.
 */

import { describe, test, expect } from "bun:test";
import { AppConfigSchema, AiConfigSchema } from "../../src/config/schema";
import { loadConfig } from "../../src/config/loader";

describe("AppConfigSchema", () => {
  test("parses minimal config", () => {
    const config = AppConfigSchema.parse({});
    expect(config.commander.brain).toBe("tiered");
    expect(config.ai.ollama_model).toBe("qwen3:8b");
    expect(config.fleet.max_bots).toBe(20);
  });

  test("parses full config", () => {
    const config = AppConfigSchema.parse({
      commander: { brain: "scoring", evaluation_interval: 120 },
      ai: { ollama_model: "llama3", shadow_mode: true },
      goals: [{ type: "maximize_income", priority: 1 }],
      fleet: { max_bots: 10, home_system: "sol" },
    });
    expect(config.commander.brain).toBe("scoring");
    expect(config.ai.ollama_model).toBe("llama3");
    expect(config.ai.shadow_mode).toBe(true);
    expect(config.goals.length).toBe(1);
    expect(config.fleet.max_bots).toBe(10);
  });

  test("rejects invalid brain type", () => {
    expect(() => AppConfigSchema.parse({ commander: { brain: "invalid" } })).toThrow();
  });
});

describe("AiConfigSchema", () => {
  test("defaults", () => {
    const config = AiConfigSchema.parse({});
    expect(config.tier_order).toEqual(["ollama", "gemini", "claude", "scoring"]);
    expect(config.max_latency_ms).toBe(10000);
    expect(config.shadow_mode).toBe(false);
  });

  test("custom tier order", () => {
    const config = AiConfigSchema.parse({ tier_order: ["scoring"] });
    expect(config.tier_order).toEqual(["scoring"]);
  });
});

describe("loadConfig", () => {
  test("loads config.toml from project root", () => {
    const config = loadConfig("config.toml");
    expect(["scoring", "tiered"]).toContain(config.commander.brain);
    expect(config.ai.ollama_base_url).toBe("http://localhost:11434");
    expect(config.server.port).toBe(3000);
    expect(config.goals.length).toBeGreaterThan(0);
  });
});
