import type { FleetAdvisorResult } from "./types";

export interface FleetAdvisorInput {
  currentBots: number;
  currentRoles: Record<string, number>;
  totalStations: number;
  freshStations: number;
  staleStations: number;
  knownSystems: number;
  unknownSystems: number;
  dangerousSystems: number;
  avgJumpsBetweenStations: number;
  avgScanCycleMinutes: number;
  profitableRoutes: number;
  currentProfitPerHour: number;
  tradeCapacityUsed: number;
}

const AVG_SCAN_TIME_MIN = 5;
const TARGET_SCAN_WINDOW_MIN = 15;
const ROUTES_PER_TRADER_HOUR = 2.5;

export class FleetAdvisor {
  compute(input: FleetAdvisorInput): FleetAdvisorResult {
    const breakdown: FleetAdvisorResult["breakdown"] = [];
    const bottlenecks: string[] = [];
    const profitPerHour = Math.max(1, input.currentProfitPerHour);

    // Scanner need — only recommend if stale ratio is significant (>20% stale)
    const scanCyclePerBot = input.totalStations * AVG_SCAN_TIME_MIN;
    const scannersNeeded = Math.ceil(scanCyclePerBot / TARGET_SCAN_WINDOW_MIN);
    const currentScanners = (input.currentRoles.explorer ?? 0) + (input.currentRoles.scout ?? 0);
    const scannerDelta = Math.max(0, scannersNeeded - currentScanners);
    const staleRatio = input.totalStations > 0 ? input.staleStations / input.totalStations : 0;

    if (scannerDelta > 0 && staleRatio > 0.2) {
      const coverageGain = scannerDelta / Math.max(1, scannersNeeded);
      const profitGain = profitPerHour * coverageGain * 0.3;
      breakdown.push({
        role: "scanner",
        current: currentScanners,
        suggested: currentScanners + scannerDelta,
        reason: `${input.staleStations}/${input.totalStations} stations have stale data. Need ${scannersNeeded} scanners to refresh all within ${TARGET_SCAN_WINDOW_MIN}min`,
        estimatedProfitIncrease: profitGain,
      });
      bottlenecks.push(`${input.staleStations}/${input.totalStations} stations stale — traders operating on outdated prices`);
    }

    // Explorer need
    if (input.unknownSystems > 0) {
      const explorersNeeded = Math.ceil(input.unknownSystems / 10);
      const currentExplorers = input.currentRoles.explorer ?? 0;
      const explorerDelta = Math.max(0, explorersNeeded - currentExplorers);
      if (explorerDelta > 0) {
        const expectedNewStations = input.unknownSystems * 0.3;
        const profitGain = expectedNewStations * profitPerHour * 0.05;
        breakdown.push({
          role: "explorer",
          current: currentExplorers,
          suggested: currentExplorers + explorerDelta,
          reason: `${input.unknownSystems} unexplored systems may contain undiscovered stations and resources`,
          estimatedProfitIncrease: profitGain,
        });
        bottlenecks.push(`${input.unknownSystems} systems unexplored — potential trade routes undiscovered`);
      }
    }

    // Trader need
    const currentTraders = input.currentRoles.trader ?? 0;
    const routeCapacity = currentTraders * ROUTES_PER_TRADER_HOUR;
    const unservicedRoutes = input.profitableRoutes * (1 - input.tradeCapacityUsed);
    if (unservicedRoutes > 0.5) {
      const tradersNeeded = Math.ceil(unservicedRoutes / ROUTES_PER_TRADER_HOUR);
      const traderDelta = Math.min(tradersNeeded, 3);
      if (traderDelta > 0) {
        const profitGain = (unservicedRoutes / Math.max(1, input.profitableRoutes)) * profitPerHour * 0.5;
        breakdown.push({
          role: "trader",
          current: currentTraders,
          suggested: currentTraders + traderDelta,
          reason: `${Math.round(unservicedRoutes)} profitable routes unserviced (capacity: ${routeCapacity.toFixed(1)} routes/h, available: ${input.profitableRoutes})`,
          estimatedProfitIncrease: profitGain,
        });
        bottlenecks.push(`${Math.round(unservicedRoutes)} profitable route(s) unused — no free trader`);
      }
    }

    // Escort need
    if (input.dangerousSystems >= 3) {
      const currentHunters = input.currentRoles.hunter ?? 0;
      if (currentHunters === 0) {
        const dangerRatio = input.dangerousSystems / Math.max(1, input.knownSystems);
        const profitGain = profitPerHour * dangerRatio * 0.4;
        breakdown.push({
          role: "escort",
          current: 0,
          suggested: 1,
          reason: `${input.dangerousSystems} dangerous systems — clearing routes increases trader safety and opens blocked trade paths`,
          estimatedProfitIncrease: profitGain,
        });
        bottlenecks.push(`${input.dangerousSystems} systems dangerous — traders avoid them, losing potential routes`);
      }
    }

    // Compute totals
    const totalSuggested = input.currentBots + breakdown.reduce((sum, b) => sum + Math.max(0, b.suggested - b.current), 0);
    const totalProfitIncrease = breakdown.reduce((sum, b) => sum + b.estimatedProfitIncrease, 0);
    const estimatedProfitIncreasePct = (totalProfitIncrease / profitPerHour) * 100;

    const result: FleetAdvisorResult = {
      currentBots: input.currentBots,
      suggestedBots: totalSuggested,
      breakdown,
      estimatedProfitIncreasePct: Math.round(estimatedProfitIncreasePct),
      scanCoverage: input.totalStations > 0 ? input.freshStations / input.totalStations : 0,
      tradeCapacity: input.tradeCapacityUsed,
      safetyScore: input.knownSystems > 0 ? 1 - (input.dangerousSystems / input.knownSystems) : 1,
      bottlenecks,
      computedAt: Date.now(),
    };

    console.log(`[FleetAdvisor] ${bottlenecks.length} bottleneck(s), suggest ${result.suggestedBots} bots (+${result.estimatedProfitIncreasePct}% profit)`);

    return result;
  }
}
