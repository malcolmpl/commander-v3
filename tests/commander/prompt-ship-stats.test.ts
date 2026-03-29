import { describe, test, expect } from "bun:test";
import { buildUserPrompt } from "../../src/commander/prompt-builder";

const mockBot = {
  botId: "test_bot",
  username: "test",
  status: "running" as const,
  routine: "trader" as const,
  lastRoutine: null,
  routineState: "",
  role: "trader",
  fuelPct: 90,
  cargoPct: 50,
  cargoCapacity: 2000,
  hullPct: 95,
  shipClass: "accretion",
  speed: 3,
  systemId: "sol",
  poiId: null,
  docked: false,
  moduleIds: [],
  moduleWear: 100,
  skills: {},
  credits: 1000,
  ownedShips: [],
  rapidRoutines: new Map(),
};

describe("Ship stats in LLM prompt", () => {
  test("formatFleet includes cargoCap", () => {
    const output = buildUserPrompt({
      fleet: { bots: [mockBot], totalCredits: 5000 },
      economy: { deficits: [], surpluses: [], netProfit: 0 },
      goals: [],
      tick: 1,
    } as any);
    expect(output).toContain("cargoCap=2000");
  });

  test("system prompt includes ship value guidance", () => {
    const { buildSystemPrompt } = require("../../src/commander/prompt-builder");
    const sysPrompt = buildSystemPrompt();
    expect(sysPrompt).toContain("SHIP VALUE");
    expect(sysPrompt).toContain("cargoCap");
  });
});
