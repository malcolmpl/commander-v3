import { describe, test, expect } from "bun:test";
import { ROIAnalyzer } from "../../src/commander/roi-analyzer";

describe("ROIAnalyzer", () => {
  const analyzer = new ROIAnalyzer({
    fuelCostPerJump: 50,
    ticksPerJump: 5,
    dangerCostMultiplier: 200,
  });

  test("trade ROI accounts for travel time and fuel", () => {
    const roi = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 4, dataAgeMs: 60_000, dangerScore: 0,
    });
    expect(roi.grossProfit).toBe(5000);
    expect(roi.netProfit).toBe(4600);
    expect(roi.profitPerTick).toBeCloseTo(4600 / 44, 0);
    expect(roi.confidence).toBeGreaterThan(0.9);
  });

  test("trade ROI reduces confidence for stale data", () => {
    const fresh = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0,
    });
    const stale = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 1_800_000, dangerScore: 0,
    });
    expect(stale.confidence).toBeLessThan(fresh.confidence);
  });

  test("trade ROI includes danger penalty", () => {
    const safe = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0,
    });
    const risky = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 200, volume: 50,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0.5,
    });
    expect(risky.netProfit).toBeLessThan(safe.netProfit);
  });

  test("mine ROI accounts for travel, remaining resources, and depletion risk", () => {
    const roi = analyzer.mineROI({
      resourceValue: 30, estimatedYield: 100, jumpsToSite: 3,
      jumpsToDepot: 3, remainingResources: 500, dangerScore: 0,
    });
    expect(roi.grossProfit).toBe(3000);
    expect(roi.netProfit).toBeLessThan(roi.grossProfit);
    expect(roi.type).toBe("mine");
  });

  test("mine ROI penalizes nearly depleted resources", () => {
    const rich = analyzer.mineROI({
      resourceValue: 30, estimatedYield: 100, jumpsToSite: 3,
      jumpsToDepot: 3, remainingResources: 5000, dangerScore: 0,
    });
    const depleted = analyzer.mineROI({
      resourceValue: 30, estimatedYield: 100, jumpsToSite: 3,
      jumpsToDepot: 3, remainingResources: 50, dangerScore: 0,
    });
    expect(depleted.confidence).toBeLessThan(rich.confidence);
  });

  test("craft ROI computes material cost vs output value", () => {
    const roi = analyzer.craftROI({
      outputValue: 500,
      materialCosts: [{ itemId: "ore_iron", qty: 10, unitCost: 20 }],
      craftTimeTicks: 5,
    });
    expect(roi.grossProfit).toBe(500);
    expect(roi.costs.materials).toBe(200);
    expect(roi.netProfit).toBe(300);
  });

  test("mine→craft chain ROI sums both steps", () => {
    const roi = analyzer.mineCraftChainROI({
      mineStep: {
        resourceValue: 20, estimatedYield: 50, jumpsToSite: 2,
        jumpsToDepot: 2, remainingResources: 1000, dangerScore: 0,
      },
      craftStep: {
        outputValue: 800,
        materialCosts: [{ itemId: "ore_iron", qty: 50, unitCost: 0 }],
        craftTimeTicks: 10,
      },
    });
    expect(roi.type).toBe("mine_craft");
    expect(roi.grossProfit).toBe(800);
    expect(roi.costs.fuel).toBeGreaterThan(0);
  });

  test("comparePaths ranks by profitPerTick", () => {
    const trade = analyzer.tradeROI({
      buyPrice: 100, sellPrice: 150, volume: 80,
      jumps: 2, dataAgeMs: 60_000, dangerScore: 0,
    });
    const mine = analyzer.mineROI({
      resourceValue: 10, estimatedYield: 100, jumpsToSite: 5,
      jumpsToDepot: 5, remainingResources: 5000, dangerScore: 0,
    });
    const ranked = analyzer.comparePaths([trade, mine]);
    expect(ranked[0].profitPerTick).toBeGreaterThanOrEqual(ranked[1].profitPerTick);
  });

  test("shipInvestmentROI calculates payback period", () => {
    const roi = analyzer.shipInvestmentROI({
      currentCargoCapacity: 70,
      newCargoCapacity: 150,
      acquisitionCost: 50_000,
      currentProfitPerHour: 5000,
    });
    expect(roi.profitIncreasePerHour).toBeGreaterThan(0);
    expect(roi.paybackHours).toBeGreaterThan(0);
    expect(roi.paybackHours).toBeLessThan(100);
  });
});
