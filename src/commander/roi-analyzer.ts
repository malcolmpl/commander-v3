import type { ROIEstimate, ShipInvestmentROI } from "./types";

export interface ROIConfig {
  fuelCostPerJump: number;
  ticksPerJump: number;
  dangerCostMultiplier: number;
}

export interface TradeParams {
  buyPrice: number;
  sellPrice: number;
  volume: number;
  jumps: number;
  dataAgeMs: number;
  dangerScore: number;
}

export interface MineParams {
  resourceValue: number;
  estimatedYield: number;
  jumpsToSite: number;
  jumpsToDepot: number;
  remainingResources: number;
  dangerScore: number;
}

export interface CraftParams {
  outputValue: number;
  materialCosts: Array<{ itemId: string; qty: number; unitCost: number }>;
  craftTimeTicks: number;
}

export interface MineCraftChainParams {
  mineStep: MineParams;
  craftStep: CraftParams;
}

export interface ShipInvestParams {
  currentCargoCapacity: number;
  newCargoCapacity: number;
  acquisitionCost: number;
  currentProfitPerHour: number;
}

export class ROIAnalyzer {
  constructor(private config: ROIConfig) {}

  tradeROI(p: TradeParams): ROIEstimate {
    const grossProfit = (p.sellPrice - p.buyPrice) * p.volume;
    const roundTripJumps = p.jumps * 2;
    const fuelCost = roundTripJumps * this.config.fuelCostPerJump;
    const dangerPenalty = p.dangerScore * this.config.dangerCostMultiplier * roundTripJumps;
    const totalTicks = roundTripJumps * this.config.ticksPerJump + 4;
    const netProfit = grossProfit - fuelCost - dangerPenalty;
    const confidence = Math.pow(0.97, Math.min(p.dataAgeMs / 60_000, 60));
    return {
      type: "trade",
      grossProfit,
      costs: { fuel: fuelCost, timeTicks: totalTicks, materials: 0, riskPenalty: dangerPenalty },
      netProfit,
      profitPerTick: netProfit / Math.max(1, totalTicks),
      confidence,
      reasoning: `Buy @${p.buyPrice} → Sell @${p.sellPrice} × ${p.volume} units, ${p.jumps} jumps${p.dangerScore > 0 ? `, danger=${(p.dangerScore * 100).toFixed(0)}%` : ""}`,
    };
  }

  mineROI(p: MineParams): ROIEstimate {
    const grossProfit = p.resourceValue * p.estimatedYield;
    const roundTripJumps = p.jumpsToSite + p.jumpsToDepot;
    const fuelCost = roundTripJumps * this.config.fuelCostPerJump;
    const dangerPenalty = p.dangerScore * this.config.dangerCostMultiplier * roundTripJumps;
    const miningTicks = Math.ceil(p.estimatedYield / 5);
    const totalTicks = roundTripJumps * this.config.ticksPerJump + miningTicks + 4;
    const netProfit = grossProfit - fuelCost - dangerPenalty;
    const depletionFactor = Math.min(p.remainingResources / p.estimatedYield, 5) / 5;
    const confidence = depletionFactor;
    return {
      type: "mine",
      grossProfit,
      costs: { fuel: fuelCost, timeTicks: totalTicks, materials: 0, riskPenalty: dangerPenalty },
      netProfit,
      profitPerTick: netProfit / Math.max(1, totalTicks),
      confidence,
      reasoning: `Mine ${p.estimatedYield} units @${p.resourceValue}cr, ${p.jumpsToSite}+${p.jumpsToDepot} jumps, ${p.remainingResources} remaining`,
      requirements: p.remainingResources < p.estimatedYield * 2
        ? [`Resource nearly depleted (${p.remainingResources} left)`]
        : undefined,
    };
  }

  craftROI(p: CraftParams): ROIEstimate {
    const materialCost = p.materialCosts.reduce((sum, m) => sum + m.qty * m.unitCost, 0);
    const grossProfit = p.outputValue;
    const netProfit = grossProfit - materialCost;
    return {
      type: "craft",
      grossProfit,
      costs: { fuel: 0, timeTicks: p.craftTimeTicks, materials: materialCost, riskPenalty: 0 },
      netProfit,
      profitPerTick: netProfit / Math.max(1, p.craftTimeTicks),
      confidence: 0.95,
      reasoning: `Craft → ${p.outputValue}cr, materials=${materialCost}cr`,
    };
  }

  mineCraftChainROI(p: MineCraftChainParams): ROIEstimate {
    const mineResult = this.mineROI(p.mineStep);
    const craftResult = this.craftROI({
      ...p.craftStep,
      materialCosts: p.craftStep.materialCosts.map(m => ({ ...m, unitCost: 0 })),
    });
    const totalFuel = mineResult.costs.fuel;
    const totalTicks = mineResult.costs.timeTicks + craftResult.costs.timeTicks;
    const grossProfit = craftResult.grossProfit;
    const netProfit = grossProfit - totalFuel - mineResult.costs.riskPenalty;
    return {
      type: "mine_craft",
      grossProfit,
      costs: { fuel: totalFuel, timeTicks: totalTicks, materials: 0, riskPenalty: mineResult.costs.riskPenalty },
      netProfit,
      profitPerTick: netProfit / Math.max(1, totalTicks),
      confidence: Math.min(mineResult.confidence, craftResult.confidence),
      reasoning: `Mine(${mineResult.reasoning}) → Craft(${craftResult.reasoning})`,
      requirements: mineResult.requirements,
    };
  }

  shipInvestmentROI(p: ShipInvestParams): ShipInvestmentROI {
    const cargoRatio = p.newCargoCapacity / Math.max(1, p.currentCargoCapacity);
    const profitMultiplier = Math.sqrt(cargoRatio);
    const newProfitPerHour = p.currentProfitPerHour * profitMultiplier;
    const profitIncreasePerHour = newProfitPerHour - p.currentProfitPerHour;
    const paybackHours = profitIncreasePerHour > 0
      ? p.acquisitionCost / profitIncreasePerHour
      : Infinity;
    return {
      botId: "",
      currentShip: "",
      proposedShip: "",
      cargoDelta: p.newCargoCapacity - p.currentCargoCapacity,
      acquisitionCost: p.acquisitionCost,
      acquisitionPath: this.tradeROI({
        buyPrice: p.acquisitionCost, sellPrice: 0, volume: 1,
        jumps: 0, dataAgeMs: 0, dangerScore: 0,
      }),
      profitIncreasePerHour,
      paybackHours,
      approved: false,
    };
  }

  comparePaths(paths: ROIEstimate[]): ROIEstimate[] {
    const sorted = [...paths].sort((a, b) => {
      const aWeighted = a.profitPerTick * a.confidence;
      const bWeighted = b.profitPerTick * b.confidence;
      return bWeighted - aWeighted;
    });
    if (sorted.length > 0) {
      const top = sorted[0];
      console.log(`[ROI] Best path: ${top.type} — ${top.profitPerTick.toFixed(1)} cr/tick (confidence=${(top.confidence * 100).toFixed(0)}%)`);
    }
    return sorted;
  }
}
