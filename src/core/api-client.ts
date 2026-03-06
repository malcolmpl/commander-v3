/**
 * Typed HTTP API client for SpaceMolt.
 * Handles session management, retry logic, and response normalization.
 *
 * NOTE: This is a stub for Phase 1 (data layer compilation).
 * Full implementation ported from v2 in Phase 3.
 */

import type {
  PlayerState, ShipState, StarSystem, PoiDetail,
  MarketPrice, MarketOrder, MiningYield, TravelResult,
  TradeResult, CraftResult, CatalogItem, ShipClass,
  Skill, Recipe, NearbyPlayer, GameNotification,
  BattleStatus, Mission, SessionInfo, LoginResult,
  RegisterResult, CargoItem, EstimatePurchaseResult,
} from "../types/game";

export interface MarketInsight {
  category: string;
  item: string;
  item_id: string;
  message: string;
  priority: number;
}

export interface AnalyzeMarketResult {
  insights: MarketInsight[];
  skill_level: number;
  station: string;
  message: string;
}

const BASE_URL = "https://game.spacemolt.com/api/v1";
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

interface ApiResponse<T = unknown> {
  result: T;
  notifications: GameNotification[];
  session: SessionInfo;
  error: { code: string; message: string; wait_seconds?: number } | null;
}

export interface ApiClientOptions {
  username: string;
  onNotifications?: (notifications: GameNotification[]) => void;
  onSessionExpired?: () => void;
}

export class ApiClient {
  private sessionId: string | null = null;
  private readonly username: string;
  private mutationCount = 0;
  private queryCount = 0;
  private lastMutationAt = 0;

  constructor(opts: ApiClientOptions) {
    this.username = opts.username;
  }

  get stats() {
    return { mutations: this.mutationCount, queries: this.queryCount };
  }

  // Stub methods — full implementation in Phase 3
  async getVersion(): Promise<{ version: string }> {
    throw new Error("ApiClient not yet implemented — Phase 3");
  }

  async getMap(): Promise<StarSystem[]> {
    throw new Error("ApiClient not yet implemented — Phase 3");
  }

  async catalog(type: string, opts?: { page?: number; pageSize?: number; category?: string }): Promise<Record<string, unknown>[]> {
    throw new Error("ApiClient not yet implemented — Phase 3");
  }
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly waitSeconds?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// ── Normalizers (used by GameCache) ──

function str(v: unknown): string {
  return String(v ?? "");
}

function num(v: unknown): number {
  return Number(v ?? 0) || 0;
}

export function normalizeRecipe(raw: Record<string, unknown>): Recipe {
  const rawIngs = (raw.ingredients ?? raw.materials ?? raw.inputs) as Array<Record<string, unknown>> | undefined;
  const ingredients = (rawIngs ?? []).map((i) => ({
    itemId: str(i.item_id ?? i.itemId),
    quantity: num(i.quantity ?? i.amount) || 1,
  }));

  const requiredSkills: Record<string, number> = {};
  const rawSkills = raw.required_skills ?? raw.requiredSkills ?? raw.skills;
  if (rawSkills && typeof rawSkills === "object" && !Array.isArray(rawSkills)) {
    for (const [k, v] of Object.entries(rawSkills as Record<string, unknown>)) {
      requiredSkills[k] = num(v);
    }
  }

  const xpRewards: Record<string, number> = {};
  const rawXp = raw.xp_rewards ?? raw.xpRewards ?? raw.xp;
  if (rawXp && typeof rawXp === "object" && !Array.isArray(rawXp)) {
    for (const [k, v] of Object.entries(rawXp as Record<string, unknown>)) {
      xpRewards[k] = num(v);
    }
  }

  const rawOutputs = raw.outputs as Array<Record<string, unknown>> | undefined;
  const outputItem = rawOutputs?.[0]?.item_id ?? raw.output_item ?? raw.outputItem ?? raw.output ?? "";
  const outputQuantity = rawOutputs?.[0]?.quantity ?? raw.output_quantity ?? raw.outputQuantity ?? 1;

  return {
    id: str(raw.id ?? raw.recipe_id),
    name: str(raw.name),
    description: str(raw.description),
    outputItem: str(outputItem),
    outputQuantity: num(outputQuantity) || 1,
    ingredients,
    requiredSkills,
    xpRewards,
  };
}

export function normalizeCatalogItem(raw: Record<string, unknown>): CatalogItem {
  return {
    id: str(raw.id ?? raw.item_id),
    name: str(raw.name),
    category: str(raw.category ?? raw.type),
    description: str(raw.description),
    basePrice: num(raw.base_price ?? raw.basePrice ?? raw.price),
    stackSize: num(raw.stack_size ?? raw.stackSize ?? 100) || 100,
  };
}

export function normalizeShipClass(raw: Record<string, unknown>): ShipClass {
  return {
    id: str(raw.id),
    name: str(raw.name),
    category: str(raw.category),
    description: str(raw.description),
    basePrice: num(raw.price ?? raw.base_price ?? raw.basePrice),
    hull: num(raw.base_hull ?? raw.hull),
    shield: num(raw.base_shield ?? raw.shield),
    armor: num(raw.base_armor ?? raw.armor),
    speed: num(raw.base_speed ?? raw.speed),
    fuel: num(raw.base_fuel ?? raw.fuel),
    cargoCapacity: num(raw.cargo_capacity ?? raw.cargoCapacity),
    cpuCapacity: num(raw.cpu_capacity ?? raw.cpuCapacity),
    powerCapacity: num(raw.power_capacity ?? raw.powerCapacity),
  };
}
