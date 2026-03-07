/**
 * Commander types - interfaces for the scoring brain, economy engine,
 * fleet evaluation, and assignment decisions.
 */

import type { Goal, GoalType, StockTarget } from "../config/schema";
import type { RoutineName } from "../types/protocol";
import type { FleetStatus, FleetBotInfo } from "../bot/types";
import type { TradeRoute } from "../core/market";
import type { MarketInsight } from "../core/api-client";

// ── Commander Brain Interface ──

/**
 * Drop-in brain interface. v3: async evaluate, health reporting.
 * Implementations: ScoringBrain (deterministic), OllamaBrain, GeminiBrain, ClaudeBrain, TieredBrain.
 */
export interface CommanderBrain {
  evaluate(input: EvaluationInput): Promise<EvaluationOutput>;
  clearCooldown(botId: string): void;
  /** Optional health reporting for tiered brain system */
  getHealth?(): BrainHealth;
}

/** Brain health status for monitoring and fallback decisions */
export interface BrainHealth {
  name: string;
  available: boolean;
  avgLatencyMs: number;
  successRate: number;
  lastError?: string;
}

/** Real-world data context assembled by Commander from Galaxy/Cache/Market */
export interface WorldContext {
  /** Per-system POI availability (keyed by systemId) */
  systemPois: Map<string, {
    hasBelts: boolean;
    hasIceFields: boolean;
    hasGasClouds: boolean;
    hasStation: boolean;
    stationIds: string[];
    poiTypes: string[];
  }>;
  /** Station IDs with fresh (non-expired) market data */
  freshStationIds: string[];
  /** Station IDs near bots that need market data refresh */
  staleStationIds: string[];
  /** Whether any market data has ever been collected */
  hasAnyMarketData: boolean;
  /** Number of profitable trade routes found in fresh data */
  tradeRouteCount: number;
  /** Best trade route profitPerTick (0 if none) */
  bestTradeProfit: number;
  /** Whether galaxy topology is loaded */
  galaxyLoaded: boolean;
  /** Ranked trade routes from fresh market data (for trader assignment deconfliction) */
  tradeRoutes: TradeRoute[];
  /** All station IDs with cached market data (for per-bot arbitrage) */
  cachedStationIds: string[];
  /** Ratio of fresh vs total known stations (0-1). Lower = more stale data. */
  dataFreshnessRatio: number;
  /** Aggregated market insights from analyze_market calls */
  marketInsights: MarketInsight[];
  /** Count of high-priority demand insights (priority >= 5) */
  demandInsightCount: number;
}

export interface EvaluationInput {
  fleet: FleetStatus;
  goals: Goal[];
  economy: EconomySnapshot;
  world: WorldContext;
  tick: number;
  /** Extra context injected by Commander (performance outcomes, persistent memory) */
  extraContext?: string;
}

export interface EvaluationOutput {
  assignments: Assignment[];
  reasoning: string;
  /** Which brain produced this output */
  brainName: string;
  /** Time taken to evaluate in milliseconds */
  latencyMs: number;
  /** Confidence in the output (0-1). Deterministic brains return 1.0. */
  confidence: number;
  /** Token usage for LLM brains (undefined for deterministic) */
  tokenUsage?: { input: number; output: number };
}

// ── Brain Health ──

/** Health status for a brain implementation (used by tiered brain manager) */
export interface BrainHealth {
  name: string;
  available: boolean;
  avgLatencyMs: number;
  successRate: number;
  lastError?: string;
}

// ── Assignments ──

export interface Assignment {
  botId: string;
  routine: RoutineName;
  params: Record<string, unknown>;
  score: number;
  reasoning: string;
  previousRoutine: RoutineName | null;
}

// ── Economy ──

export interface MaterialDemand {
  itemId: string;
  quantityPerHour: number;
  source: string;
  priority: "critical" | "normal" | "low";
}

export interface MaterialSupply {
  itemId: string;
  quantityPerHour: number;
  source: string;
}

export interface SupplyDeficit {
  itemId: string;
  demandPerHour: number;
  supplyPerHour: number;
  shortfall: number;
  priority: "critical" | "normal" | "low";
}

export interface SupplySurplus {
  itemId: string;
  excessPerHour: number;
  stationId: string;
  currentStock: number;
}

export interface InventoryAlert {
  stationId: string;
  itemId: string;
  current: number;
  target: StockTarget;
  type: "below_min" | "above_max";
}

export interface EconomySnapshot {
  deficits: SupplyDeficit[];
  surpluses: SupplySurplus[];
  inventoryAlerts: InventoryAlert[];
  totalRevenue: number;
  totalCosts: number;
  netProfit: number;
  /** Faction storage inventory (itemId → quantity) */
  factionStorage: Map<string, number>;
}

// ── Scoring ──

export interface BotScore {
  botId: string;
  routine: RoutineName;
  baseScore: number;
  supplyBonus: number;
  skillBonus: number;
  infoBonus: number;
  factionBonus: number;
  riskPenalty: number;
  switchCost: number;
  diversityPenalty: number;
  rapidPenalty: number;
  equipmentPenalty: number;
  worldPenalty: number;
  idlePenalty: number;
  stalenessPenalty: number;
  insightBonus: number;
  finalScore: number;
  reasoning: string;
}

/** Pending ship upgrade queued by Commander for a bot */
export interface PendingUpgrade {
  targetShipClass: string;
  targetPrice: number;
  role: string;
  roi: number;
  /** If true, bot already owns this ship — just switch, don't buy */
  alreadyOwned?: boolean;
  /** Ship instance ID to switch to (when alreadyOwned=true) */
  ownedShipId?: string;
}

/** Goal-type weight profiles for routine scoring */
export interface StrategyWeights {
  miner: number;
  harvester: number;
  trader: number;
  explorer: number;
  crafter: number;
  hunter: number;
  salvager: number;
  mission_runner: number;
  return_home: number;
  scout: number;
  quartermaster: number;
  scavenger: number;
  ship_upgrade: number;
  refit: number;
}

// ── Reassignment Tracking ──

export interface ReassignmentState {
  lastAssignment: number;   // timestamp ms
  lastRoutine: RoutineName | null;
  cooldownUntil: number;    // timestamp ms
}
