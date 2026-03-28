/**
 * Fleet persistence — Drizzle-based save/load for bot settings,
 * fleet settings, and goals. Replaces raw SQL from v2 index.ts.
 */

import { eq } from "drizzle-orm";
import type { DB } from "../data/db";
import { botSettings, botSkills, fleetSettings, goals } from "../data/schema";
import type { Goal } from "../config/schema";

// ── Bot Settings ──

export interface BotSettingsData {
  fuelEmergencyThreshold: number;
  autoRepair: boolean;
  maxCargoFillPct: number;
  storageMode: "sell" | "deposit" | "faction_deposit";
  factionStorage: boolean;
  role: string | null;
  manualControl: boolean;
}

export function saveBotSettings(db: DB, username: string, settings: BotSettingsData): void {
  db.insert(botSettings)
    .values({
      username,
      fuelEmergencyThreshold: settings.fuelEmergencyThreshold,
      autoRepair: settings.autoRepair ? 1 : 0,
      maxCargoFillPct: settings.maxCargoFillPct,
      storageMode: settings.storageMode,
      factionStorage: settings.factionStorage ? 1 : 0,
      role: settings.role ?? null,
      manualControl: settings.manualControl ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: botSettings.username,
      set: {
        fuelEmergencyThreshold: settings.fuelEmergencyThreshold,
        autoRepair: settings.autoRepair ? 1 : 0,
        maxCargoFillPct: settings.maxCargoFillPct,
        storageMode: settings.storageMode,
        factionStorage: settings.factionStorage ? 1 : 0,
        role: settings.role ?? null,
        manualControl: settings.manualControl ? 1 : 0,
      },
    })
    .run();
}

export function loadBotSettings(db: DB, username: string): BotSettingsData | null {
  const row = db.select().from(botSettings).where(eq(botSettings.username, username)).get();
  if (!row) return null;

  return {
    fuelEmergencyThreshold: row.fuelEmergencyThreshold,
    autoRepair: row.autoRepair === 1,
    maxCargoFillPct: row.maxCargoFillPct,
    storageMode: row.storageMode as BotSettingsData["storageMode"],
    factionStorage: row.factionStorage === 1,
    role: row.role ?? null,
    manualControl: row.manualControl === 1,
  };
}

// ── Bot Skills ──

export type BotSkillsData = Record<string, { level: number; xp: number; xpNext: number }>;

export function saveBotSkills(db: DB, username: string, skills: BotSkillsData): void {
  db.insert(botSkills)
    .values({
      username,
      skills: JSON.stringify(skills),
    })
    .onConflictDoUpdate({
      target: botSkills.username,
      set: {
        skills: JSON.stringify(skills),
        updatedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
      },
    })
    .run();
}

export function loadBotSkills(db: DB, username: string): BotSkillsData | null {
  const row = db.select().from(botSkills).where(eq(botSkills.username, username)).get();
  if (!row) return null;
  try {
    return JSON.parse(row.skills) as BotSkillsData;
  } catch {
    return null;
  }
}

// ── Fleet Settings ──

export interface FleetSettingsData {
  factionTaxPercent: number;
  minBotCredits: number;
  maxBotCredits: number;
  homeSystem?: string;
  homeBase?: string;
  defaultStorageMode?: string;
  evaluationInterval?: number;
  reassignmentCooldown?: number;
  reassignmentThreshold?: number;
}

export function saveFleetSettings(db: DB, settings: FleetSettingsData): void {
  for (const [key, value] of Object.entries(settings)) {
    db.insert(fleetSettings)
      .values({ key, value: String(value) })
      .onConflictDoUpdate({
        target: fleetSettings.key,
        set: { value: String(value) },
      })
      .run();
  }
}

export function loadFleetSettings(db: DB): FleetSettingsData | null {
  const rows = db.select().from(fleetSettings).all();
  if (rows.length === 0) return null;

  const map = new Map(rows.map(r => [r.key, r.value]));
  return {
    factionTaxPercent: Number(map.get("factionTaxPercent") ?? 0),
    minBotCredits: Number(map.get("minBotCredits") ?? 0),
    maxBotCredits: Number(map.get("maxBotCredits") ?? 0),
    homeSystem: map.get("homeSystem") ?? undefined,
    homeBase: map.get("homeBase") ?? undefined,
    defaultStorageMode: map.get("defaultStorageMode") ?? undefined,
    evaluationInterval: map.has("evaluationInterval") ? Number(map.get("evaluationInterval")) : undefined,
    reassignmentCooldown: map.has("reassignmentCooldown") ? Number(map.get("reassignmentCooldown")) : undefined,
    reassignmentThreshold: map.has("reassignmentThreshold") ? Number(map.get("reassignmentThreshold")) : undefined,
  };
}

// ── Goals ──

export function saveGoals(db: DB, goalList: Goal[]): void {
  // Delete all, re-insert (transactional)
  db.delete(goals).run();
  for (const g of goalList) {
    db.insert(goals)
      .values({
        type: g.type,
        priority: g.priority,
        params: JSON.stringify(g.params ?? {}),
        constraints: g.constraints ? JSON.stringify(g.constraints) : null,
      })
      .run();
  }
}

export function loadGoals(db: DB): Goal[] {
  const rows = db.select().from(goals).all();
  return rows
    .map(r => ({
      type: r.type as Goal["type"],
      priority: r.priority,
      params: JSON.parse(r.params) as Record<string, unknown>,
      constraints: r.constraints ? JSON.parse(r.constraints) : undefined,
    }))
    .sort((a, b) => b.priority - a.priority);
}
