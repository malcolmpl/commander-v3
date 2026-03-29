import { describe, test, expect, beforeEach } from "bun:test";
import { MarketRotation } from "../../src/commander/market-rotation";

describe("MarketRotation", () => {
  let rotation: MarketRotation;

  beforeEach(() => {
    rotation = new MarketRotation({ hubSystemId: "sol" });
  });

  test("unknown stations get highest priority", () => {
    rotation.updateStation("sta_a", "sys_a", Infinity, 3);
    rotation.updateStation("sta_b", "sys_b", 600_000, 2);
    const queue = rotation.getQueue();
    expect(queue[0].stationId).toBe("sta_a");
  });

  test("older data gets higher priority than newer", () => {
    rotation.updateStation("sta_old", "sys_a", 1_800_000, 2);
    rotation.updateStation("sta_new", "sys_b", 300_000, 2);
    const queue = rotation.getQueue();
    expect(queue[0].stationId).toBe("sta_old");
  });

  test("distant stations get bonus (not penalty) to prevent neglect", () => {
    rotation.updateStation("sta_near", "sys_a", 900_000, 1);
    rotation.updateStation("sta_far", "sys_b", 900_000, 8);
    const queue = rotation.getQueue();
    expect(queue[0].stationId).toBe("sta_far");
  });

  test("assignBot marks station and returns it", () => {
    rotation.updateStation("sta_a", "sys_a", 1_800_000, 3);
    const assigned = rotation.assignBot("bot_1");
    expect(assigned).not.toBeNull();
    expect(assigned!.stationId).toBe("sta_a");
    expect(assigned!.assignedBot).toBe("bot_1");
  });

  test("assigned stations are skipped for next assignment", () => {
    rotation.updateStation("sta_a", "sys_a", 1_800_000, 3);
    rotation.updateStation("sta_b", "sys_b", 1_200_000, 2);
    rotation.assignBot("bot_1");
    const second = rotation.assignBot("bot_2");
    expect(second!.stationId).toBe("sta_b");
  });

  test("clearAssignment frees station", () => {
    rotation.updateStation("sta_a", "sys_a", 1_800_000, 3);
    rotation.assignBot("bot_1");
    rotation.clearAssignment("bot_1");
    const next = rotation.assignBot("bot_2");
    expect(next!.stationId).toBe("sta_a");
  });

  test("getStaleCount returns stations above threshold", () => {
    rotation.updateStation("sta_a", "sys_a", 1_200_000, 2);
    rotation.updateStation("sta_b", "sys_b", 300_000, 2);
    expect(rotation.getStaleCount(900_000)).toBe(1);
  });
});
