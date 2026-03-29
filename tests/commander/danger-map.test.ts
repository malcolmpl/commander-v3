import { describe, test, expect, beforeEach } from "bun:test";
import { DangerMap } from "../../src/commander/danger-map";

describe("DangerMap", () => {
  let dm: DangerMap;

  beforeEach(() => {
    dm = new DangerMap({ decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
  });

  test("new system has zero danger", () => {
    expect(dm.getScore("sys_unknown")).toBe(0);
  });

  test("recording attack increases danger", () => {
    dm.recordAttack("sys_dangerous", Date.now());
    expect(dm.getScore("sys_dangerous")).toBeGreaterThan(0);
  });

  test("multiple attacks stack", () => {
    const now = Date.now();
    dm.recordAttack("sys_a", now);
    const after1 = dm.getScore("sys_a");
    dm.recordAttack("sys_a", now + 1000);
    const after2 = dm.getScore("sys_a");
    expect(after2).toBeGreaterThan(after1);
  });

  test("danger decays over time", () => {
    const past = Date.now() - 3_600_000;
    dm.recordAttack("sys_old", past);
    const fresh = new DangerMap({ decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    fresh.recordAttack("sys_fresh", Date.now());
    expect(dm.getScore("sys_old")).toBeLessThan(fresh.getScore("sys_fresh") * 0.5);
  });

  test("score capped at maxScore", () => {
    const now = Date.now();
    for (let i = 0; i < 100; i++) dm.recordAttack("sys_war", now + i);
    expect(dm.getScore("sys_war")).toBeLessThanOrEqual(1.0);
  });

  test("getRouteCost returns sum of danger along path", () => {
    const now = Date.now();
    dm.recordAttack("sys_b", now);
    dm.recordAttack("sys_c", now);
    const cost = dm.getRouteCost(["sys_a", "sys_b", "sys_c", "sys_d"]);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBeGreaterThan(4);
  });

  test("serialize/deserialize preserves state", () => {
    dm.recordAttack("sys_x", Date.now());
    const json = dm.serialize();
    const dm2 = DangerMap.deserialize(json, { decayHalfLifeMs: 1_800_000, maxScore: 1.0 });
    expect(dm2.getScore("sys_x")).toBeCloseTo(dm.getScore("sys_x"), 2);
  });

  test("needsEscort returns true for high-danger systems", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) dm.recordAttack("sys_pirate", now);
    expect(dm.needsEscort("sys_pirate")).toBe(true);
    expect(dm.needsEscort("sys_safe")).toBe(false);
  });

  test("getAllDangerous returns systems above threshold", () => {
    const now = Date.now();
    dm.recordAttack("sys_hot", now);
    dm.recordAttack("sys_hot", now);
    const dangerous = dm.getAllDangerous(0.1);
    expect(dangerous.some(d => d.systemId === "sys_hot")).toBe(true);
    expect(dangerous.some(d => d.systemId === "sys_safe")).toBe(false);
  });
});
