/**
 * Bot engine types — v3 with RoutineYield and EventBus.
 */

import type { ApiClient } from "../core/api-client";
import type { Galaxy } from "../core/galaxy";
import type { Navigation } from "../core/navigation";
import type { Market } from "../core/market";
import type { Cargo } from "../core/cargo";
import type { Fuel } from "../core/fuel";
import type { Combat } from "../core/combat";
import type { Crafting } from "../core/crafting";
import type { Station } from "../core/station";
import type { GameCache } from "../data/game-cache";
import type { TrainingLogger } from "../data/training-logger";
import type { EventBus } from "../events/bus";
import type { RoutineYield } from "../events/types";
import type { PlayerState, ShipState, SessionInfo } from "../types/game";
import type { BotStatus, RoutineName } from "../types/protocol";

// ── Fleet-wide Config ──

export interface FleetConfig {
  homeSystem: string;
  homeBase: string;
  defaultStorageMode: "sell" | "deposit" | "faction_deposit";
  factionStorageStation: string;
  factionTaxPercent: number;
  minBotCredits: number;
}

// ── Bot Settings ──

export interface BotSettings {
  fuelEmergencyThreshold: number;
  autoRepair: boolean;
  maxCargoFillPct: number;
  storageMode: "sell" | "deposit" | "faction_deposit";
  factionStorage: boolean;
}

// ── Routine Types ──

export type RoutineParams = Record<string, unknown>;

/** A routine is an async generator that yields RoutineYield (string | typed event) */
export type Routine = (ctx: BotContext) => AsyncGenerator<RoutineYield, void, void>;

export type RoutineRegistry = Partial<Record<RoutineName, Routine>>;

// ── Fleet Awareness ──

export interface FleetBotInfo {
  botId: string;
  username: string;
  status: BotStatus;
  routine: RoutineName | null;
  lastRoutine: RoutineName | null;
  routineState: string;
  systemId: string | null;
  poiId: string | null;
  docked: boolean;
  credits: number;
  fuelPct: number;
  cargoPct: number;
  hullPct: number;
  moduleIds: string[];
  shipClass: string | null;
  cargoCapacity: number;
  ownedShips: Array<{ id: string; classId: string }>;
  skills: Record<string, number>;
  rapidRoutines: Map<RoutineName, number>;
  /** Average module durability (0-100). Lower = needs refit/repair. */
  moduleWear: number;
}

export interface FleetStatus {
  bots: FleetBotInfo[];
  totalCredits: number;
  activeBots: number;
}

// ── BotContext ──

export interface BotContext {
  // Identity
  botId: string;
  username: string;
  session: SessionInfo;

  // Core services
  api: ApiClient;
  nav: Navigation;
  market: Market;
  cargo: Cargo;
  fuel: Fuel;
  combat: Combat;
  crafting: Crafting;
  station: Station;
  galaxy: Galaxy;

  // Data
  cache: GameCache;
  logger: TrainingLogger;

  // v3: Event bus for typed event emission
  eventBus: EventBus;

  // Fleet awareness
  getFleetStatus: () => FleetStatus;

  // Routine params (set by Commander)
  params: RoutineParams;

  // Bot settings
  settings: BotSettings;

  // Fleet-wide config
  fleetConfig: FleetConfig;

  // State
  player: PlayerState;
  ship: ShipState;

  // Signal: graceful stop
  shouldStop: boolean;

  refreshState: () => Promise<void>;
  recordFactionWithdrawal: (amount: number) => void;
}
