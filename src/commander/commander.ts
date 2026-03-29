/**
 * Commander - the fleet brain orchestrator.
 * Periodically evaluates the fleet and issues assignments via BotManager.
 * Bridges the CommanderBrain, EconomyEngine, and BotManager.
 */

import type { Goal, StockTarget } from "../config/schema";
import type { CommanderDecision, FleetAssignment } from "../types/protocol";
import type { TrainingLogger } from "../data/training-logger";
import type { Galaxy } from "../core/galaxy";
import type { Market } from "../core/market";
import type { Crafting } from "../core/crafting";
import type { ApiClient } from "../core/api-client";
import type { GameCache } from "../data/game-cache";
import type { FleetStatus } from "../bot/types";
import type { ShipClass } from "../types/game";
import type { CommanderBrain, EvaluationOutput, Assignment, WorldContext, PendingUpgrade, BrainHealth } from "./types";
import { EconomyEngine } from "./economy-engine";
import { ScoringBrain, type ScoringConfig } from "./scoring-brain";
import { findBestUpgrade, calculateROI, scoreShipForRole, checkSkillRequirements, describeUpgrade, LEGACY_SHIPS } from "../core/ship-fitness";
import { StuckDetector } from "./stuck-detector";
import { PerformanceTracker } from "./performance-tracker";
import { ChatIntelligence } from "./chat-intelligence";
import type { MemoryStore } from "../data/memory-store";
import type { StuckBot } from "../types/protocol";
import { type BotRole, type RolePoolConfig, DEFAULT_POOL_CONFIG, parseBotRole, routineToRole } from "./roles";
import { EmbeddingStore, type OutcomeCategory } from "./embedding-store";
import { extractContext } from "./bandit-brain";
import { computeReward, emptySignals } from "./reward-function";
import { StrategicTriggerEngine, type StrategicTrigger } from "./strategic-triggers";
import { buildStrategicSystemPrompt, buildStrategicUserPrompt, parseLlmResponse } from "./prompt-builder";

export interface CommanderConfig {
  /** Evaluation interval in seconds */
  evaluationIntervalSec: number;
  /** Whether urgency overrides can bypass cooldowns */
  urgencyOverride: boolean;
}

export interface CommanderDeps {
  /** Function to get current fleet status */
  getFleetStatus: () => FleetStatus;
  /** Function to assign a routine to a bot */
  assignRoutine: (botId: string, routine: string, params: Record<string, unknown>) => Promise<void>;
  /** Training logger for recording decisions */
  logger: TrainingLogger;
  /** World data services for informed decision-making */
  galaxy: Galaxy;
  market: Market;
  cache: GameCache;
  crafting: Crafting;
  /** Function to get an authenticated API client (for faction storage polling) */
  getApi?: () => ApiClient | null;
  /** Fleet home base ID */
  homeBase?: string;
  /** Fleet home system ID */
  homeSystem?: string;
  /** Default storage mode */
  defaultStorageMode?: "sell" | "deposit" | "faction_deposit";
  /** Minimum credits per bot — bots below this should return home to withdraw */
  minBotCredits?: number;
  /** Live fleet config getter — used to sync homeBase/homeSystem after discovery */
  getFleetConfig?: () => { homeBase?: string; homeSystem?: string; factionStorageStation?: string; defaultStorageMode?: string; minBotCredits?: number };
  /** Persistent memory store (optional) */
  memoryStore?: MemoryStore;
  /** Callback to set a bot's role (for pool sizing auto-assignment) */
  setBotRole?: (botId: string, role: string | null) => void;
  /** Callback to recover bots stuck in error state */
  recoverErrorBots?: () => Promise<void>;
  /** Check if a bot is under manual control (excluded from commander eval) */
  isBotManual?: (botId: string) => boolean;
  /** Embedding-based memory store for strategic decisions (optional) */
  embeddingStore?: EmbeddingStore;
  /** Ollama config for strategic LLM consultations (used when brain="scoring") */
  ollamaConfig?: { baseUrl: string; model: string };
}

export class Commander {
  private brain: CommanderBrain;
  private economy: EconomyEngine;
  private goals: Goal[] = [];
  private evaluationTimer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private decisionHistory: CommanderDecision[] = [];
  private maxHistorySize = 100;
  private lastShipCheck = 0;
  private lastFactionPoll = 0;
  private cachedTradeRoutes: { routes: import("../core/market").TradeRoute[]; at: number } | null = null;
  /** Ship classes that failed to be found at any shipyard — blacklisted with cooldown */
  private shipBlacklist = new Map<string, number>(); // classId → blacklisted until timestamp
  /** Bots that recently failed a ship upgrade — cooldown before re-queueing any upgrade */
  private botUpgradeCooldown = new Map<string, number>(); // botId → cooldown until timestamp
  /** Stuck bot detector (inspired by CHAPERON) */
  private stuckDetector = new StuckDetector();
  /** Latest stuck bot list for dashboard */
  private lastStuckBots: StuckBot[] = [];
  /** Tracks per-bot performance outcomes for LLM feedback */
  private performanceTracker = new PerformanceTracker();
  /** Chat intelligence — reads and learns from global/faction chat */
  private _chatIntelligence: ChatIntelligence | null = null;
  /** Prevents overlapping evaluations when tiered brain is slow */
  private _evaluating = false;
  /** Role pool sizing config */
  private _poolConfig: RolePoolConfig[] = DEFAULT_POOL_CONFIG;
  /** Bandit reward tracking: per-bot snapshot at last eval (for computing deltas) */
  private _botSnapshots = new Map<string, { credits: number; routine: string | null; role: string | null; startTick: number }>();
  /** Strategic trigger engine — decides when to call LLM */
  private triggerEngine = new StrategicTriggerEngine();
  /** Last strategic trigger (for dashboard) */
  private lastTrigger: StrategicTrigger | null = null;

  constructor(
    private config: CommanderConfig,
    private deps: CommanderDeps,
    brain?: CommanderBrain,
    scoringConfig?: Partial<ScoringConfig>
  ) {
    const scoringBrain = new ScoringBrain(scoringConfig);
    scoringBrain.homeBase = deps.homeBase ?? "";
    scoringBrain.homeSystem = deps.homeSystem ?? "";
    scoringBrain.defaultStorageMode = deps.defaultStorageMode ?? "sell";
    scoringBrain.crafting = deps.crafting;
    scoringBrain.galaxy = deps.galaxy;
    scoringBrain.market = deps.market;
    scoringBrain.cache = deps.cache ?? null;
    scoringBrain.minBotCredits = deps.minBotCredits ?? 0;
    this.brain = brain ?? scoringBrain;
    this.economy = new EconomyEngine();
  }

  /** Get current commander config */
  getConfig(): Readonly<CommanderConfig> {
    return this.config;
  }

  /** Update commander config and restart eval timer if interval changed */
  updateConfig(updates: Partial<CommanderConfig>): void {
    const oldInterval = this.config.evaluationIntervalSec;
    Object.assign(this.config, updates);
    // Restart timer if interval changed and commander is running
    if (updates.evaluationIntervalSec && updates.evaluationIntervalSec !== oldInterval && this.evaluationTimer) {
      this.stop();
      this.start();
    }
  }

  // ── Goal Management ──

  /** Set active goals (replaces all) */
  setGoals(goals: Goal[]): void {
    this.goals = [...goals].sort((a, b) => b.priority - a.priority);
  }

  /** Add a single goal */
  addGoal(goal: Goal): void {
    this.goals.push(goal);
    this.goals.sort((a, b) => b.priority - a.priority);
  }

  /** Update goal at index */
  updateGoal(index: number, goal: Goal): void {
    if (index >= 0 && index < this.goals.length) {
      this.goals[index] = goal;
      this.goals.sort((a, b) => b.priority - a.priority);
    }
  }

  /** Seed faction inventory into economy engine (for startup) */
  seedFactionInventory(items: Map<string, number>): void {
    this.economy.updateFactionInventory(items);
  }

  /** Remove goal by index */
  removeGoal(index: number): void {
    this.goals.splice(index, 1);
  }

  /** Get current goals */
  getGoals(): Goal[] {
    return [...this.goals];
  }

  // ── Inventory Targets ──

  /** Set stock targets for economy engine */
  setStockTargets(targets: StockTarget[]): void {
    this.economy.setStockTargets(targets);
  }

  // ── Economy ──

  /** Get the economy engine for direct manipulation */
  getEconomy(): EconomyEngine {
    return this.economy;
  }

  // ── Evaluation Loop ──

  /** Start periodic evaluation */
  start(): void {
    if (this.evaluationTimer) return;

    this.evaluationTimer = setInterval(() => {
      if (this._evaluating) {
        console.log("[Commander] Skipping eval — previous cycle still running");
        return;
      }
      this.evaluateAndAssign().catch((err) => {
        console.error("[Commander] Evaluation error:", err);
      });
    }, this.config.evaluationIntervalSec * 1000);

    console.log(`[Commander] Started (eval every ${this.config.evaluationIntervalSec}s)`);
  }

  /** Stop periodic evaluation */
  stop(): void {
    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    console.log("[Commander] Stopped");
  }

  /** Force a single evaluation (can be triggered from dashboard) */
  async forceEvaluation(): Promise<CommanderDecision> {
    return this.evaluateAndAssign();
  }

  /** Get the brain for direct config updates */
  getBrain(): CommanderBrain {
    return this.brain;
  }

  /** Replace the brain (e.g., switching from scoring to LLM) */
  setBrain(brain: CommanderBrain): void {
    this.brain = brain;
  }

  /** Find the ScoringBrain inside any brain (direct, tiered, or shadow) */
  getScoringBrain(): ScoringBrain | null {
    if (this.brain instanceof ScoringBrain) return this.brain;
    // TieredBrain: check tiers and shadowBrain
    if ("tiers" in this.brain) {
      const tiered = this.brain as any;
      for (const tier of tiered.tiers ?? []) {
        if (tier instanceof ScoringBrain) return tier;
      }
      if (tiered.shadowBrain instanceof ScoringBrain) return tiered.shadowBrain;
    }
    // Fallback: duck-type check
    if ("pendingUpgrades" in this.brain) return this.brain as unknown as ScoringBrain;
    return null;
  }

  /** Set ship catalog for upgrade evaluation (call after loading from cache/API) */
  setShipCatalog(catalog: ShipClass[]): void {
    const sb = this.getScoringBrain();
    if (sb) {
      sb.shipCatalog = catalog;
      console.log(`[Commander] Ship catalog loaded: ${catalog.length} ship classes`);
    }
  }

  /** Get per-tier brain health (for dashboard) */
  getBrainHealths(): BrainHealth[] {
    // If tiered brain, get per-tier health
    if ("getTierHealths" in this.brain) {
      return (this.brain as any).getTierHealths();
    }
    // Single brain — return its health if available
    const h = this.brain.getHealth?.();
    return h ? [h] : [];
  }

  /** Get AI settings for dashboard */
  getAiSettings(): { ollamaModel: string; ollamaBaseUrl: string } | null {
    if ("getTierByPrefix" in this.brain) {
      const ollama = (this.brain as any).getTierByPrefix("ollama");
      if (ollama && "getModel" in ollama) {
        return { ollamaModel: ollama.getModel(), ollamaBaseUrl: ollama.getBaseUrl() };
      }
    }
    if ("getModel" in this.brain) {
      return { ollamaModel: (this.brain as any).getModel(), ollamaBaseUrl: (this.brain as any).getBaseUrl() };
    }
    return null;
  }

  /** Update AI settings at runtime */
  updateAiSettings(settings: { ollamaModel?: string; ollamaBaseUrl?: string; timeoutMs?: number }): void {
    let ollama: any = null;
    if ("getTierByPrefix" in this.brain) {
      ollama = (this.brain as any).getTierByPrefix("ollama");
    } else if ("setModel" in this.brain) {
      ollama = this.brain;
    }
    if (!ollama) return;
    if (settings.ollamaModel) ollama.setModel(settings.ollamaModel);
    if (settings.ollamaBaseUrl) ollama.setBaseUrl(settings.ollamaBaseUrl);
    if (settings.timeoutMs) ollama.setTimeoutMs(settings.timeoutMs);
  }

  /** Get recent decision history */
  getDecisionHistory(): CommanderDecision[] {
    return [...this.decisionHistory];
  }

  /** Get the latest decision */
  getLastDecision(): CommanderDecision | null {
    return this.decisionHistory.length > 0
      ? this.decisionHistory[this.decisionHistory.length - 1]
      : null;
  }

  /** Get current stuck bots */
  getStuckBots(): StuckBot[] {
    return this.lastStuckBots;
  }

  /** Get memory store (if configured) */
  getMemoryStore(): MemoryStore | undefined {
    return this.deps.memoryStore;
  }

  /** Set chat intelligence instance (shared with broadcast loop) */
  setChatIntelligence(ci: ChatIntelligence): void {
    this._chatIntelligence = ci;
  }

  /** Get chat intelligence (for broadcast loop sharing) */
  getChatIntelligence(): ChatIntelligence | null {
    return this._chatIntelligence;
  }

  /** Set role pool config (from config.toml or dashboard) */
  setPoolConfig(config: RolePoolConfig[]): void {
    this._poolConfig = config;
  }

  /** Get current pool config */
  getPoolConfig(): RolePoolConfig[] {
    return [...this._poolConfig];
  }

  /**
   * Evaluate pool sizing — assigns roles to unassigned bots to fill minimums.
   * Called during each evaluation cycle. Only assigns roles to bots with role=null.
   * Returns list of role assignments made (for logging).
   */
  private evaluatePoolSizing(fleet: FleetStatus): Array<{ botId: string; role: BotRole }> {
    const assignments: Array<{ botId: string; role: BotRole }> = [];

    // Count current bots per role
    const roleCounts = new Map<BotRole, number>();
    const unassignedBots: string[] = [];

    for (const bot of fleet.bots) {
      if (bot.status !== "ready" && bot.status !== "running") continue;
      const role = parseBotRole(bot.role);
      if (role) {
        roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
      } else {
        unassignedBots.push(bot.botId);
      }
    }

    if (unassignedBots.length === 0) return assignments;

    // Fill minimums first, sorted by priority (order in pool config)
    for (const pool of this._poolConfig) {
      if (unassignedBots.length === 0) break;
      const current = roleCounts.get(pool.role) ?? 0;
      const needed = Math.max(0, pool.min - current);
      for (let i = 0; i < needed && unassignedBots.length > 0; i++) {
        const botId = unassignedBots.shift()!;
        assignments.push({ botId, role: pool.role });
        roleCounts.set(pool.role, (roleCounts.get(pool.role) ?? 0) + 1);
      }
    }

    // Fill remaining unassigned bots into roles that haven't hit max, prioritizing supply chain
    const SUPPLY_CHAIN_ORDER: BotRole[] = ["ore_miner", "trader", "crafter", "mission_runner", "explorer"];
    for (const role of SUPPLY_CHAIN_ORDER) {
      if (unassignedBots.length === 0) break;
      const pool = this._poolConfig.find(p => p.role === role);
      if (!pool) continue;
      const current = roleCounts.get(pool.role) ?? 0;
      const room = Math.max(0, pool.max - current);
      for (let i = 0; i < room && unassignedBots.length > 0; i++) {
        const botId = unassignedBots.shift()!;
        assignments.push({ botId, role: pool.role });
        roleCounts.set(pool.role, (roleCounts.get(pool.role) ?? 0) + 1);
      }
    }

    // Anything still unassigned gets ore_miner (safe default)
    for (const botId of unassignedBots) {
      assignments.push({ botId, role: "ore_miner" });
    }

    return assignments;
  }

  // ── Core Evaluation ──

  private async evaluateAndAssign(): Promise<CommanderDecision> {
    this._evaluating = true;
    const startMs = performance.now();
    try {
      const result = await this._doEvaluateAndAssign();
      const durationMs = performance.now() - startMs;
      if (durationMs > 15_000) {
        console.warn(`[Commander] Slow eval cycle: ${durationMs.toFixed(0)}ms`);
      } else {
        console.log(`[Commander] Eval cycle: ${durationMs.toFixed(0)}ms`);
      }
      return result;
    } finally {
      this._evaluating = false;
    }
  }

  private async _doEvaluateAndAssign(): Promise<CommanderDecision> {
    this.tick = Math.floor(Date.now() / 1000);

    // Step 0: Sync homeBase/homeSystem from live fleet config (discovery may have updated it)
    this.syncFleetConfig();

    // Step 0.5: Recover bots stuck in error state (re-login and reset to ready)
    if (this.deps.recoverErrorBots) {
      try { await this.deps.recoverErrorBots(); } catch { /* non-critical */ }
    }

    // Step 0.7: Ensure galaxy map is loaded (cold-start: bots log in but galaxy may be empty)
    // Uses cached galaxy data from SQLite — only fetches from API on cache miss or version change
    if (this.deps.galaxy.systemCount < 50) {
      const api = this.deps.getApi?.();
      if (api && this.deps.cache) {
        try {
          const systems = await this.deps.cache.getMap(api);
          for (const sys of systems) this.deps.galaxy.updateSystem(sys);
          console.log(`[Commander] Galaxy bootstrap: loaded ${systems.length} systems`);
        } catch { /* will retry next cycle */ }
      }
    }

    // Step 0.7b: Hydrate POI data (runs every first eval — POI index may be empty even with 500+ systems)
    if (this.deps.cache && this.deps.galaxy.poiCount === 0) {
      // Hydrate with persisted system details (full POI data from previous sessions)
      try {
        const persistedSystems = await this.deps.cache.loadPersistedSystemDetails();
        if (persistedSystems.length > 0) {
          let poiBefore = this.deps.galaxy.poiCount;
          for (const sys of persistedSystems) {
            if (sys.id && sys.pois.length > 0) this.deps.galaxy.updateSystem(sys);
          }
          const gained = this.deps.galaxy.poiCount - poiBefore;
          if (gained > 0) console.log(`[Commander] Hydrated ${gained} POIs from ${persistedSystems.length} persisted system details`);
        }
      } catch { /* non-critical */ }

      // Hydrate persisted POI discoveries
      try {
        const persistedPois = await this.deps.cache.loadPersistedPois();
        if (persistedPois.length > 0) {
          const enriched = this.deps.galaxy.hydrateFromPersistedPois(persistedPois);
          if (enriched > 0) console.log(`[Commander] Hydrated ${enriched} POIs from ${persistedPois.length} persisted discoveries`);
        }
      } catch { /* non-critical */ }
    }

    // Step 0.8: Ensure recipe + item catalogs are loaded (cold-start: crafters need recipes)
    if (this.deps.crafting.recipeCount === 0) {
      const api = this.deps.getApi?.();
      if (api && this.deps.cache) {
        try {
          const [recipes, items] = await Promise.all([
            this.deps.cache.getRecipes(api),
            this.deps.cache.getItemCatalog(api),
          ]);
          this.deps.crafting.load(recipes);
          this.deps.crafting.loadItems(items);
          const facilityOnly = await this.deps.cache.getFacilityOnlyRecipes();
          if (facilityOnly.length > 0) {
            this.deps.crafting.setFacilityOnlyRecipes(facilityOnly);
          }
          console.log(`[Commander] Recipe catalog auto-loaded: ${recipes.length} recipes, ${items.length} items${facilityOnly.length > 0 ? `, ${facilityOnly.length} facility-only excluded` : ""}`);
        } catch { /* will retry next cycle */ }
      }
    }

    // Step 1: Get fleet state (exclude bots under manual control)
    const rawFleet = this.deps.getFleetStatus();
    const manualBots = rawFleet.bots.filter(b => this.deps.isBotManual?.(b.botId));
    if (manualBots.length > 0) {
      console.log(`[Commander] Skipping ${manualBots.length} manual-control bot(s): ${manualBots.map(b => b.username).join(", ")}`);
    }
    const fleet: import("../bot/types").FleetStatus = {
      ...rawFleet,
      bots: rawFleet.bots.filter(b => !this.deps.isBotManual?.(b.botId)),
      activeBots: rawFleet.activeBots - manualBots.length,
    };

    // Step 1.2: Pool sizing — auto-assign roles to unassigned bots
    if (this.deps.setBotRole) {
      const roleAssignments = this.evaluatePoolSizing(fleet);
      for (const { botId, role } of roleAssignments) {
        this.deps.setBotRole(botId, role);
        // Update fleet snapshot so brain sees the new role
        const botInfo = fleet.bots.find(b => b.botId === botId);
        if (botInfo) botInfo.role = role;
        console.log(`[Commander] Auto-assigned role: ${botId} → ${role}`);
      }
    }

    // Step 1.5: Poll faction storage (non-blocking, best-effort)
    await this.pollFactionStorage();

    // Step 1.6a: Clean up failed ship upgrades (every eval — catches rapid failures immediately)
    this.cleanupShipUpgrades(fleet);
    // Step 1.6b: Discover new ship upgrades (every 5 minutes)
    await this.checkShipUpgrades(fleet);

    // Step 1.7: Sync facility material needs into economy engine
    const facilityNeeds = this.deps.cache.getFacilityMaterialNeeds();
    this.economy.setFacilityMaterialNeeds(facilityNeeds);

    // Step 2: Analyze economy
    const economySnapshot = this.economy.analyze(fleet);

    // Step 3: Build world context from real data
    const world = this.buildWorldContext(fleet);

    // Step 3.5: Track performance outcomes (for LLM feedback)
    this.performanceTracker.update(fleet);

    // Step 3.7: Stuck detection (inspired by CHAPERON)
    this.lastStuckBots = this.stuckDetector.update(fleet);
    if (this.lastStuckBots.length > 0) {
      for (const stuck of this.lastStuckBots) {
        this.brain.clearCooldown(stuck.botId);
      }
    }

    // Step 3.8: Pre-evaluation emergency overrides — clear cooldowns BEFORE brain runs
    this.applyEmergencyOverrides(fleet);

    // Step 4: Run scoring brain (ALWAYS — fast, deterministic, <50ms)
    const performanceContext = this.performanceTracker.buildContextBlock();
    const memoryContext = this.deps.memoryStore?.buildContextBlock() ?? "";
    const chatContext = this._chatIntelligence?.buildContextBlock() ?? "";
    const extraContext = [performanceContext, memoryContext, chatContext].filter(Boolean).join("\n\n");

    const evalInput = {
      fleet,
      goals: this.goals,
      economy: economySnapshot,
      world,
      tick: this.tick,
      extraContext: extraContext || undefined,
    };

    // Scoring brain is always the primary decision maker
    const scoringBrain = this.getScoringBrain();
    let output: EvaluationOutput;

    if (scoringBrain) {
      output = await scoringBrain.evaluate(evalInput);
    } else {
      // Fallback: use whatever brain is configured (shouldn't happen normally)
      output = await this.brain.evaluate(evalInput);
    }

    // Step 4.5: Check strategic triggers — should we consult the LLM?
    const trigger = this.triggerEngine.evaluate(fleet, economySnapshot, world, this.goals);
    if (trigger) {
      this.lastTrigger = trigger;
      console.log(`[Commander] Strategic trigger: ${trigger.type} — ${trigger.reason}`);

      // Merge strategic advice from LLM (non-blocking on failure)
      try {
        const strategicOutput = await this.consultLlm(trigger, fleet, economySnapshot);
        if (strategicOutput && strategicOutput.assignments.length > 0) {
          // LLM overrides only the bots it specifically mentions
          const overrideMap = new Map(strategicOutput.assignments.map(a => [a.botId, a]));
          for (const [botId, override] of overrideMap) {
            const idx = output.assignments.findIndex(a => a.botId === botId);
            if (idx >= 0) {
              output.assignments[idx] = override;
            } else {
              output.assignments.push(override);
            }
          }
          output.reasoning += ` | Strategic: ${strategicOutput.reasoning}`;
          console.log(`[Commander] LLM overrode ${overrideMap.size} assignment(s): ${strategicOutput.reasoning}`);
        }
      } catch (err) {
        // LLM failure is non-critical — scoring brain result stands
        console.log(`[Commander] Strategic LLM consultation failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Step 5: Build conversational thoughts
    const thoughts = this.buildThoughts(fleet, world, output);

    // Step 5a: Enforce routine caps (prevents LLM overrides from violating constraints)
    const ROUTINE_CAPS: Partial<Record<string, number>> = {
      scout: 1, explorer: fleet.bots.length >= 6 ? 2 : 1,
      quartermaster: 1, hunter: 1, salvager: 1, scavenger: 1,
      ship_upgrade: 1, refit: 2, ship_dealer: 1,
    };
    const routineCounts = new Map<string, number>();
    const assignedBotIds = new Set(output.assignments.map(a => a.botId));
    for (const bot of fleet.bots) {
      if (bot.routine && bot.status === "running" && !assignedBotIds.has(bot.botId)) {
        routineCounts.set(bot.routine, (routineCounts.get(bot.routine) ?? 0) + 1);
      }
    }
    const cappedAssignments = output.assignments.filter(a => {
      const cap = ROUTINE_CAPS[a.routine];
      if (cap === undefined) return true;
      const current = routineCounts.get(a.routine) ?? 0;
      if (current >= cap) return false;
      routineCounts.set(a.routine, current + 1);
      return true;
    });

    // Step 5b: Execute assignments — skip bots already running the same routine
    const executedAssignments: FleetAssignment[] = [];
    const botStatusMap = new Map(fleet.bots.map((b) => [b.botId, b]));
    // One-shot routines must not be interrupted mid-execution
    const PROTECTED_ROUTINES = new Set(["ship_upgrade", "refit", "return_home", "scout"]);

    for (const assignment of cappedAssignments) {
      const botInfo = botStatusMap.get(assignment.botId);
      // Skip bots not yet ready (still logging in or idle)
      if (botInfo && botInfo.status !== "ready" && botInfo.status !== "running") {
        continue;
      }
      // Skip re-assigning a bot that's already running this exact routine
      if (botInfo && botInfo.routine === assignment.routine && botInfo.status === "running") {
        continue; // Already doing this — don't interrupt
      }
      // Don't interrupt one-shot routines (ship_upgrade, refit, return_home)
      if (botInfo && botInfo.status === "running" && botInfo.routine && PROTECTED_ROUTINES.has(botInfo.routine)) {
        continue;
      }

      try {
        await this.deps.assignRoutine(
          assignment.botId,
          assignment.routine,
          assignment.params
        );

        executedAssignments.push({
          botId: assignment.botId,
          routine: assignment.routine,
          params: assignment.params,
          reasoning: assignment.reasoning,
          score: assignment.score,
          previousRoutine: assignment.previousRoutine,
        });
      } catch (err) {
        console.warn(
          `[Commander] Failed to assign ${assignment.routine} to ${assignment.botId}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    // Step 5c: Feed bandit with reward from completed routine cycles
    if (world) {
      economySnapshot.dataFreshnessRatio = world.dataFreshnessRatio;
    }
    this.feedBanditRewards(fleet, economySnapshot);

    // Step 6: Build decision record
    const decision: CommanderDecision = {
      tick: this.tick,
      goal: this.goals.length > 0 ? this.goals[0].type : "none",
      assignments: executedAssignments,
      reasoning: output.reasoning,
      thoughts,
      timestamp: new Date().toISOString(),
      brainName: output.brainName,
      latencyMs: output.latencyMs,
      confidence: output.confidence,
      tokenUsage: output.tokenUsage,
      fallbackUsed: output.brainName === "ScoringBrain" && (this.brain.getHealth?.()?.name ?? "ScoringBrain") !== "ScoringBrain",
    };

    // Step 7: Log and record
    this.recordDecision(decision, fleet, economySnapshot);

    // Step 7.5: Log outcomes to embedding store (for memory-augmented future decisions)
    if (this.deps.embeddingStore && executedAssignments.length > 0) {
      this.logOutcomesToEmbeddings(executedAssignments, fleet, economySnapshot);
    }

    // Step 8: Record strategic memories (persistent knowledge)
    this.recordMemories(fleet, world, decision);

    return decision;
  }

  /** Sync homeBase/homeSystem from live fleet config into brain (discovery updates fleet config async) */
  private syncFleetConfig(): void {
    const live = this.deps.getFleetConfig?.();
    if (!live) return;

    const homeBase = live.factionStorageStation || live.homeBase || "";
    const homeSystem = live.homeSystem || "";

    // Update deps cache
    if (homeBase && !this.deps.homeBase) this.deps.homeBase = homeBase;
    if (homeSystem && !this.deps.homeSystem) this.deps.homeSystem = homeSystem;

    // Update scoring brain (may be wrapped in TieredBrain)
    const updateBrain = (brain: CommanderBrain) => {
      if ("homeBase" in brain) {
        const sb = brain as ScoringBrain;
        if (homeBase && sb.homeBase !== homeBase) {
          sb.homeBase = homeBase;
          console.log(`[Commander] Synced homeBase → ${homeBase}`);
        }
        if (homeSystem && sb.homeSystem !== homeSystem) {
          sb.homeSystem = homeSystem;
        }
        if (live.defaultStorageMode) {
          sb.defaultStorageMode = live.defaultStorageMode as "sell" | "deposit" | "faction_deposit";
        }
        if (live.minBotCredits !== undefined) {
          sb.minBotCredits = live.minBotCredits;
        }
      }
      // If tiered brain, also update sub-brains
      if ("tiers" in brain) {
        for (const tier of (brain as any).tiers) {
          updateBrain(tier);
        }
      }
      // Also check shadowBrain
      if ("shadowBrain" in brain && (brain as any).shadowBrain) {
        updateBrain((brain as any).shadowBrain);
      }
    };

    updateBrain(this.brain);
  }

  /** Poll faction storage inventory (best-effort, non-blocking, max every 3 minutes) */
  private async pollFactionStorage(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFactionPoll < 180_000) return; // Only poll every 3 minutes

    const api = this.deps.getApi?.();
    if (!api) return;

    // Only poll if using faction storage
    const mode = this.deps.defaultStorageMode;
    if (mode !== "faction_deposit") return;

    this.lastFactionPoll = now;
    try {
      const items = await api.viewFactionStorage();
      const inventory = new Map<string, number>();
      for (const item of items) {
        if (item.quantity > 0) {
          inventory.set(item.itemId, (inventory.get(item.itemId) ?? 0) + item.quantity);
        }
      }
      this.economy.updateFactionInventory(inventory);
      const oreCount = [...inventory.entries()].filter(([id]) => id.includes("ore")).reduce((s, [, q]) => s + q, 0);
      console.log(`[Commander] Faction storage polled: ${inventory.size} item types, ${oreCount} ore units`);
    } catch (err) {
      console.log(`[Commander] Faction storage poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Clean up stale/failed ship upgrades — runs every eval (not gated by timer) */
  private cleanupShipUpgrades(fleet: FleetStatus): void {
    const brain = this.getScoringBrain();
    if (!brain) return;
    const now = Date.now();

    // Expire old blacklist entries (30 minute cooldown)
    for (const [classId, until] of this.shipBlacklist) {
      if (now > until) this.shipBlacklist.delete(classId);
    }
    // Expire old per-bot upgrade cooldowns
    for (const [botId, until] of this.botUpgradeCooldown) {
      if (now > until) this.botUpgradeCooldown.delete(botId);
    }

    // Clear stale pending upgrades for bots that already completed or failed upgrading
    for (const [botId, pending] of brain.pendingUpgrades) {
      const bot = fleet.bots.find((b) => b.botId === botId);
      if (!bot) {
        brain.pendingUpgrades.delete(botId);
        continue;
      }
      // If bot already has the target ship, remove the pending upgrade
      if (bot.shipClass === pending.targetShipClass) {
        brain.pendingUpgrades.delete(botId);
        continue;
      }
      // If bot is no longer on ship_upgrade and has a pending upgrade, it failed
      // (Don't wait for rapidRoutines — they expire in 2min, check would miss them)
      if (bot.routine !== "ship_upgrade" && bot.lastRoutine === "ship_upgrade" && !pending.alreadyOwned) {
        if (!this.shipBlacklist.has(pending.targetShipClass)) {
          this.shipBlacklist.set(pending.targetShipClass, now + 1_800_000); // Blacklist ship for 30 min
          console.log(`[Commander] Blacklisted ${pending.targetShipClass} — not available at any visited shipyard (30min cooldown)`);
        }
        // Per-bot cooldown: don't try ANY upgrade for this bot for 30 min
        this.botUpgradeCooldown.set(botId, now + 1_800_000);
        brain.pendingUpgrades.delete(botId);
      }
    }
  }

  /** Periodically discover new ship upgrades (every 5 minutes) */
  private async checkShipUpgrades(fleet: FleetStatus): Promise<void> {
    const now = Date.now();
    if (now - this.lastShipCheck < 300_000) return; // Only check every 5 minutes
    this.lastShipCheck = now;

    // Only works with ScoringBrain (has pendingUpgrades + shipCatalog)
    const brain = this.getScoringBrain();
    if (!brain) return;

    // Auto-load ship catalog if not yet loaded
    if (!brain.shipCatalog || brain.shipCatalog.length === 0) {
      const api = this.deps.getApi?.();
      if (api) {
        try {
          const catalog = await this.deps.cache.getShipCatalog(api);
          if (catalog.length > 0) {
            brain.shipCatalog = catalog;
            console.log(`[Commander] Ship catalog auto-loaded: ${catalog.length} ship classes`);
          }
        } catch (err) {
          console.log(`[Commander] Ship catalog load failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!brain.shipCatalog || brain.shipCatalog.length === 0) return;
    }

    const catalog = brain.shipCatalog;
    const minReserve = Math.max(5000, this.deps.minBotCredits ?? 0);

    for (const bot of fleet.bots) {
      if (bot.status !== "ready" && bot.status !== "running") continue;
      if (bot.routine === "ship_upgrade") continue; // Already upgrading
      if (brain.pendingUpgrades.has(bot.botId)) continue; // Already queued
      if (this.botUpgradeCooldown.has(bot.botId)) continue; // Recently failed — on cooldown

      const role = bot.role ?? bot.routine ?? "default";
      const currentClass = catalog.find((s) => s.id === bot.shipClass)
        ?? LEGACY_SHIPS.find((s) => s.id === bot.shipClass);
      if (!currentClass) continue;

      // Priority 1: Check if bot already owns a better ship (free switch, no purchase)
      if (bot.ownedShips.length > 1) {
        let bestOwnedScore = scoreShipForRole(currentClass, role);
        let bestOwned: { id: string; classId: string } | null = null;
        let bestOwnedClass: typeof currentClass | null = null;

        for (const owned of bot.ownedShips) {
          if (owned.classId === bot.shipClass) continue; // Skip current ship
          const ownedShipClass = catalog.find((s) => s.id === owned.classId)
            ?? LEGACY_SHIPS.find((s) => s.id === owned.classId);
          if (!ownedShipClass) continue;

          // Skill gate: skip ships the bot can't fly
          const skillCheck = checkSkillRequirements(ownedShipClass, bot.skills);
          if (!skillCheck.met) continue;

          const score = scoreShipForRole(ownedShipClass, role);
          if (score > bestOwnedScore + 3) { // Must be noticeably better
            bestOwnedScore = score;
            bestOwned = owned;
            bestOwnedClass = ownedShipClass;
          }
        }

        if (bestOwned && bestOwnedClass) {
          const roi = calculateROI(currentClass, bestOwnedClass, role);
          brain.pendingUpgrades.set(bot.botId, {
            targetShipClass: bestOwned.classId,
            targetPrice: 0,
            role,
            roi: roi + 100, // High priority — it's free
            alreadyOwned: true,
            ownedShipId: bestOwned.id,
          });
          const stats = describeUpgrade(currentClass, bestOwnedClass);
          console.log(`[Commander] Ship switch queued (already owned): ${bot.botId} ${bot.shipClass} → ${bestOwned.classId} (role=${role}, FREE) [${stats}]`);
          continue;
        }
      }

      // Priority 2: Find an upgrade to buy from shipyard (skip blacklisted classes)
      const budget = bot.credits - minReserve;
      if (budget <= 0) continue;

      const availableCatalog = catalog.filter((s) => !this.shipBlacklist.has(s.id));
      const upgrade = findBestUpgrade(currentClass.id, role, availableCatalog, budget, bot.skills);
      if (!upgrade) continue;

      // Double-check skill requirements before queuing
      const skillCheck = checkSkillRequirements(upgrade, bot.skills);
      if (!skillCheck.met) {
        const missingStr = skillCheck.missing.map(m => `${m.skill} ${m.current}/${m.required}`).join(", ");
        console.log(`[Commander] Ship upgrade skipped: ${bot.botId} → ${upgrade.id} (missing skills: ${missingStr})`);
        continue;
      }

      const roi = calculateROI(currentClass, upgrade, role);
      const currentScore = scoreShipForRole(currentClass, role);
      const upgradeScore = scoreShipForRole(upgrade, role);
      const stats = describeUpgrade(currentClass, upgrade);

      // Find which station sells this ship (from cached shipyard scans)
      const shipyard = this.deps.cache.findShipyardForClass(upgrade.id);

      // Only queue buy-mode upgrades when a known shipyard stocks the ship
      // Without this, bots waste time traveling to home station only to find "not available"
      if (!shipyard) {
        continue;
      }

      brain.pendingUpgrades.set(bot.botId, {
        targetShipClass: upgrade.id,
        targetPrice: upgrade.basePrice,
        role,
        roi,
        buyStation: shipyard.stationId,
      });

      console.log(`[Commander] Ship upgrade queued: ${bot.botId} ${currentClass.id} → ${upgrade.id} (role=${role}, price=${upgrade.basePrice}cr, score ${currentScore}→${upgradeScore}, ROI=${roi.toFixed(2)}, station=${shipyard.stationId}) [${stats}]`);
    }
  }

  /** Clear cooldowns for bots in emergency states (low fuel, low hull) so brain can reassign them */
  private applyEmergencyOverrides(fleet: FleetStatus): void {
    const lowFuel = fleet.bots.filter((b) => b.fuelPct < 25 && (b.status === "running" || b.status === "ready"));
    for (const b of lowFuel) {
      this.brain.clearCooldown(b.botId);
    }
    const lowHull = fleet.bots.filter((b) => b.hullPct < 30 && (b.status === "running" || b.status === "ready"));
    for (const b of lowHull) {
      this.brain.clearCooldown(b.botId);
    }
  }

  /** Build world context from galaxy/cache/market for brain evaluation */
  private buildWorldContext(fleet: FleetStatus): WorldContext {
    const { galaxy, cache, market } = this.deps;

    // Per-system POI data for each bot's location
    const systemPois = new Map<string, WorldContext["systemPois"] extends Map<string, infer V> ? V : never>();
    const seenSystems = new Set<string>();

    for (const bot of fleet.bots) {
      if (!bot.systemId || seenSystems.has(bot.systemId)) continue;
      seenSystems.add(bot.systemId);

      const system = galaxy.getSystem(bot.systemId);
      if (!system) continue;

      // Check for resource POIs with remaining resources
      // A POI with no resources array means we haven't scanned it yet (optimistic: assume available)
      // A POI with resources all at remaining=0 means it's depleted
      const hasResourcesLeft = (p: { resources: Array<{ remaining: number }> }) =>
        p.resources.length === 0 || p.resources.some((r) => r.remaining > 0);

      const hasBelts = system.pois.some((p) =>
        (p.type === "asteroid_belt" || p.type === "asteroid") && hasResourcesLeft(p)
      );
      const hasIceFields = system.pois.some((p) =>
        p.type === "ice_field" && hasResourcesLeft(p)
      );
      const hasGasClouds = system.pois.some((p) =>
        (p.type === "gas_cloud" || p.type === "nebula") && hasResourcesLeft(p)
      );
      const stations = system.pois.filter((p) => p.hasBase && p.baseId);
      const hasStation = stations.length > 0;
      const stationIds = stations.map((p) => p.baseId!);

      systemPois.set(bot.systemId, {
        hasBelts,
        hasIceFields,
        hasGasClouds,
        hasStation,
        stationIds,
        poiTypes: system.pois.map((p) => p.type),
      });
    }

    // Market freshness
    const freshStationIds = cache.getFreshStationIds();
    const hasAnyMarketData = cache.hasAnyMarketData();

    // Stale stations: stations bots are near that have old/no market data
    const staleStationIds: string[] = [];
    for (const [, info] of systemPois) {
      for (const sid of info.stationIds) {
        const freshness = cache.getMarketFreshness(sid);
        if (!freshness.fresh) staleStationIds.push(sid);
      }
    }

    // Trade routes from ALL cached market data (cached 3 min, invalidated by market changes)
    const allCachedStationIds = cache.getAllMarketFreshness().map((f) => f.stationId);
    const now = Date.now();
    if (!this.cachedTradeRoutes || now - this.cachedTradeRoutes.at > 180_000 || cache.marketDirty) {
      // Use median fleet cargo capacity for route ranking
      const capacities = fleet.bots.map((b) => b.cargoCapacity).filter((c) => c > 0).sort((a, b) => a - b);
      const medianCargo = capacities.length > 0 ? capacities[Math.floor(capacities.length / 2)] : 100;
      const routes = allCachedStationIds.length >= 2
        ? market.findArbitrage(allCachedStationIds, fleet.bots[0]?.systemId ?? "", medianCargo).slice(0, 10)
        : [];
      this.cachedTradeRoutes = { routes, at: now };
      cache.marketDirty = false;
    }
    const tradeRoutes = this.cachedTradeRoutes.routes;

    // Data freshness ratio: what fraction of known stations have fresh data
    const allKnownStationIds = new Set<string>();
    for (const [, info] of systemPois) {
      for (const sid of info.stationIds) allKnownStationIds.add(sid);
    }
    const totalKnown = allKnownStationIds.size;
    const dataFreshnessRatio = totalKnown > 0 ? freshStationIds.length / totalKnown : 0;

    // Market insights from analyze_market calls
    const marketInsights = cache.getAllCachedInsights();
    const demandInsightCount = marketInsights.filter((i) => i.category === "demand" && i.priority >= 5).length;

    return {
      systemPois,
      freshStationIds,
      staleStationIds,
      hasAnyMarketData,
      tradeRouteCount: tradeRoutes.length,
      bestTradeProfit: tradeRoutes.length > 0 ? tradeRoutes[0].tripProfitPerTick : 0,
      galaxyLoaded: galaxy.systemCount > 0,
      tradeRoutes,
      cachedStationIds: allCachedStationIds,
      dataFreshnessRatio,
      marketInsights,
      demandInsightCount,
    };
  }

  /** Generate conversational thoughts narrating the commander's reasoning */
  private buildThoughts(
    fleet: FleetStatus,
    world: WorldContext,
    output: EvaluationOutput
  ): string[] {
    const thoughts: string[] = [];

    // Fleet observation
    const readyCount = fleet.bots.filter((b) => b.status === "ready" || b.status === "running").length;
    const idleCount = fleet.bots.filter((b) => b.status === "ready" && !b.routine).length;
    if (readyCount === 0) {
      thoughts.push("No bots online. Waiting for fleet to come online.");
      return thoughts;
    }
    thoughts.push(`Fleet check: ${readyCount} bot(s) operational, ${fleet.totalCredits.toLocaleString()} credits in treasury.`);

    // Goals
    if (this.goals.length > 0) {
      const primary = this.goals[0];
      const label = primary.type.replace(/_/g, " ");
      thoughts.push(`Current objective: ${label} (priority ${primary.priority}).`);
    } else {
      thoughts.push("No objectives set — running balanced fleet strategy.");
    }

    // World awareness
    if (!world.galaxyLoaded) {
      thoughts.push("Galaxy map not yet loaded — exploration should be prioritized.");
    } else if (!world.hasAnyMarketData) {
      thoughts.push("No market intelligence gathered yet. Bots that dock at stations will scan prices automatically.");
    } else if (world.staleStationIds.length > 0) {
      thoughts.push(`${world.staleStationIds.length} station(s) have stale market data — could use a refresh.`);
    }

    if (world.tradeRouteCount > 0) {
      thoughts.push(`Found ${world.tradeRouteCount} profitable trade route(s). Best yields ${world.bestTradeProfit.toFixed(1)} cr/tick.`);
    }

    // Data freshness awareness
    if (world.hasAnyMarketData && world.dataFreshnessRatio < 0.5) {
      const pct = Math.round(world.dataFreshnessRatio * 100);
      thoughts.push(`Market data quality: ${pct}% fresh. Stale data reduces trader effectiveness — prioritizing bots that dock and refresh prices.`);
    }

    // Faction storage awareness
    const factionInv = this.economy.getFactionInventory();
    if (factionInv.size > 0) {
      const totalItems = [...factionInv.values()].reduce((s, q) => s + q, 0);
      const oreCount = [...factionInv.entries()]
        .filter(([id]) => id.includes("ore"))
        .reduce((s, [, q]) => s + q, 0);
      if (oreCount > 0) {
        thoughts.push(`Faction storage: ${totalItems} items (${oreCount} ore units available for crafting).`);
      } else {
        thoughts.push(`Faction storage: ${totalItems} items.`);
      }
    } else if (this.deps.defaultStorageMode === "faction_deposit") {
      thoughts.push("Faction storage empty — miners should deposit raw materials for crafters.");
    }

    // Stuck bot awareness
    if (this.lastStuckBots.length > 0) {
      const names = this.lastStuckBots.map((s) => s.username).join(", ");
      thoughts.push(`Stuck bots detected: ${names}. Cooldowns cleared for immediate reassignment.`);
    }

    // Bot health concerns (cooldowns already cleared in applyEmergencyOverrides before eval)
    const lowFuel = fleet.bots.filter((b) => b.fuelPct < 25 && (b.status === "running" || b.status === "ready"));
    if (lowFuel.length > 0) {
      thoughts.push(`${lowFuel.length} bot(s) running low on fuel — emergency overrides applied.`);
    }
    const lowHull = fleet.bots.filter((b) => b.hullPct < 30 && (b.status === "running" || b.status === "ready"));
    if (lowHull.length > 0) {
      thoughts.push(`${lowHull.length} bot(s) with damaged hull — emergency overrides applied.`);
    }

    // Assignment decisions
    if (output.assignments.length > 0) {
      for (const a of output.assignments) {
        if (a.previousRoutine) {
          thoughts.push(`Reassigning ${a.botId}: ${a.previousRoutine} -> ${a.routine} (score ${a.score.toFixed(0)}). ${a.reasoning}`);
        } else {
          thoughts.push(`Assigning ${a.botId} to ${a.routine} (score ${a.score.toFixed(0)}).`);
        }
      }
    } else if (idleCount > 0) {
      thoughts.push(`${idleCount} bot(s) idle but no suitable assignments found yet.`);
    } else {
      thoughts.push("All bots performing well in current roles. No changes needed.");
    }

    // Chat intelligence awareness
    if (this._chatIntelligence) {
      const intel = this._chatIntelligence.getRecentIntel();
      const tradeOffers = intel.filter(i => i.type === "trade_offer");
      const warnings = intel.filter(i => i.type === "warning");
      if (tradeOffers.length > 0) {
        const offers = tradeOffers.slice(-3).map(t =>
          `${t.source} ${t.direction} ${t.item}${t.price ? ` @ ${t.price}cr` : ""}`
        ).join(", ");
        thoughts.push(`Chat intel: ${tradeOffers.length} trade offer(s) spotted — ${offers}.`);
      }
      if (warnings.length > 0) {
        thoughts.push(`Chat warning: ${warnings[warnings.length - 1].content.slice(0, 80)}`);
      }
    }

    // Performance tracking
    const routineStats = this.performanceTracker.getRoutineStats();
    if (routineStats.size > 0) {
      const topRoutines = [...routineStats.entries()]
        .sort((a, b) => b[1].avgCreditsPerMin - a[1].avgCreditsPerMin)
        .slice(0, 3);
      const perf = topRoutines
        .map(([r, s]) => `${r}: ${s.avgCreditsPerMin >= 0 ? "+" : ""}${Math.round(s.avgCreditsPerMin)}cr/min`)
        .join(", ");
      thoughts.push(`Routine performance: ${perf}.`);
    }

    // Routine distribution
    const routineCounts = new Map<string, number>();
    for (const bot of fleet.bots) {
      if (bot.routine) routineCounts.set(bot.routine, (routineCounts.get(bot.routine) ?? 0) + 1);
    }
    if (routineCounts.size > 0) {
      const dist = [...routineCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([r, c]) => `${c} ${r}${c > 1 ? "s" : ""}`)
        .join(", ");
      thoughts.push(`Fleet composition: ${dist}.`);
    }

    return thoughts;
  }

  /** Record strategic facts into persistent memory */
  private recordMemories(
    fleet: FleetStatus,
    world: WorldContext,
    decision: CommanderDecision
  ): void {
    const mem = this.deps.memoryStore;
    if (!mem) return;

    try {
      // Record fleet composition snapshot
      const routineCounts = new Map<string, number>();
      for (const bot of fleet.bots) {
        if (bot.routine) routineCounts.set(bot.routine, (routineCounts.get(bot.routine) ?? 0) + 1);
      }
      if (routineCounts.size > 0) {
        const dist = [...routineCounts.entries()].map(([r, c]) => `${c}x${r}`).join(", ");
        mem.set("fleet_composition", dist, 3);
      }

      // Record best trade route profit
      if (world.tradeRouteCount > 0) {
        mem.set("best_trade_profit", `${world.bestTradeProfit.toFixed(1)} cr/tick across ${world.tradeRouteCount} routes`, 5);
      }

      // Record fleet size and treasury
      mem.set("fleet_stats", `${fleet.activeBots} active bots, ${fleet.totalCredits.toLocaleString()} credits`, 4);

      // Record routine performance stats
      const perfStats = this.performanceTracker.getRoutineStats();
      if (perfStats.size > 0) {
        const perf = [...perfStats.entries()]
          .sort((a, b) => b[1].avgCreditsPerMin - a[1].avgCreditsPerMin)
          .map(([r, s]) => `${r}: ${Math.round(s.avgCreditsPerMin)}cr/min (${s.count} samples)`)
          .join("; ");
        mem.set("routine_performance", perf, 6);
      }

      // Record stuck bot patterns
      if (this.lastStuckBots.length > 0) {
        const stuckInfo = this.lastStuckBots.map((s) =>
          `${s.username} stuck in ${s.routine ?? "unknown"} for ${Math.round(s.stuckSinceMs / 60000)}min`
        ).join("; ");
        mem.set("stuck_bot_report", stuckInfo, 7);
      }
    } catch {
      // Memory store failure shouldn't break the Commander
    }
  }

  /** Get the last strategic trigger (for dashboard) */
  getLastTrigger(): StrategicTrigger | null {
    return this.lastTrigger;
  }

  /** Get strategic trigger engine state (for dashboard) */
  getTriggerState(): { lastLlmCallAgo: number; creditTrend: number; periodicIntervalMs: number } {
    return this.triggerEngine.getState();
  }

  /**
   * Consult the LLM brain for strategic advice.
   * Uses the focused strategic prompt (not the full fleet dump).
   * Retrieves relevant memories from embedding store for context.
   */
  private async consultLlm(
    trigger: StrategicTrigger,
    fleet: FleetStatus,
    economy: import("./types").EconomySnapshot,
  ): Promise<EvaluationOutput | null> {
    // Find the LLM brain (first non-scoring tier in tiered brain)
    let llmBrain: CommanderBrain | null = null;
    if ("tiers" in this.brain) {
      const tiers = (this.brain as any).tiers as CommanderBrain[];
      for (const tier of tiers) {
        if (!(tier instanceof ScoringBrain)) {
          const health = tier.getHealth?.();
          if (health?.available !== false) {
            llmBrain = tier;
            break;
          }
        }
      }
    } else if (!(this.brain instanceof ScoringBrain)) {
      llmBrain = this.brain;
    }

    // Resolve Ollama connection: from LLM brain instance, deps config, or defaults
    let baseUrl: string;
    let model: string;

    if (llmBrain) {
      const brainAny = llmBrain as any;
      baseUrl = brainAny.getBaseUrl?.() ?? brainAny.baseUrl ?? "http://localhost:11434";
      model = brainAny.getModel?.() ?? brainAny.model ?? "qwen3:8b";
    } else if (this.deps.ollamaConfig) {
      baseUrl = this.deps.ollamaConfig.baseUrl;
      model = this.deps.ollamaConfig.model;
    } else {
      console.log(`[Commander] Strategic: no LLM brain or Ollama config available`);
      return null;
    }

    console.log(`[Commander] Strategic: consulting ${model} for ${trigger.type}...`);

    // Retrieve relevant memories from embedding store
    const embeddingStore = this.deps.embeddingStore;
    let memories: import("./embedding-store").RetrievedMemory[] = [];
    if (embeddingStore) {
      const query = `${trigger.type}: ${trigger.reason}`;
      memories = await embeddingStore.retrieve(query, { limit: 5 });
    }

    // Build the focused strategic prompt
    const userPrompt = buildStrategicUserPrompt(
      trigger, memories, fleet, economy, this.goals,
    );

    // Call Ollama directly with strategic prompt
    const startTime = Date.now();
    const validBotIds = new Set(fleet.bots.map(b => b.botId));
    const systemPrompt = buildStrategicSystemPrompt();

    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          max_tokens: 512,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        console.log(`[Commander] Strategic LLM HTTP ${response.status}`);
        return null;
      }

      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const responseText = data.choices?.[0]?.message?.content ?? "";
      if (!responseText) {
        console.log(`[Commander] Strategic LLM returned empty response`);
        return null;
      }

      const parsed = parseLlmResponse(responseText, validBotIds);
      const latencyMs = Date.now() - startTime;

      const assignments: Assignment[] = parsed.assignments.map(a => {
        const bot = fleet.bots.find(b => b.botId === a.botId);
        return {
          botId: a.botId,
          routine: a.routine,
          params: {},
          score: 100,
          reasoning: `[Strategic/${trigger.type}] ${a.reasoning}`,
          previousRoutine: bot?.routine ?? null,
        };
      });

      this.triggerEngine.recordLlmCall();
      console.log(`[Commander] Strategic LLM (${model}) responded in ${latencyMs}ms: ${assignments.length} override(s), confidence=${parsed.confidence}`);

      return {
        assignments,
        reasoning: parsed.reasoning || `Strategic response to ${trigger.type}`,
        brainName: `strategic/${llmBrain ? (llmBrain as any).name : model}`,
        latencyMs,
        confidence: parsed.confidence,
      };
    } catch (err) {
      console.log(`[Commander] Strategic LLM call failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Log routine outcomes to the embedding store for future retrieval.
   * Non-blocking: fires and forgets.
   */
  private logOutcomesToEmbeddings(
    assignments: FleetAssignment[],
    fleet: FleetStatus,
    economy: import("./types").EconomySnapshot,
  ): void {
    const store = this.deps.embeddingStore;
    if (!store) return;

    // Log each assignment as a potential outcome
    for (const a of assignments) {
      const bot = fleet.bots.find(b => b.botId === a.botId);
      if (!bot) continue;

      let category: OutcomeCategory = "strategic";
      if (a.routine === "trader") category = "trade_outcome";
      else if (a.routine === "miner" || a.routine === "harvester") category = "mine_outcome";
      else if (a.routine === "crafter") category = "craft_outcome";

      const text = `${bot.username} assigned ${a.routine} at ${bot.systemId} (ship=${bot.shipClass}, fuel=${bot.fuelPct}%, cargo=${bot.cargoPct}%)${a.previousRoutine ? ` from ${a.previousRoutine}` : ""}`;

      store.store({
        text,
        category,
        metadata: {
          botId: a.botId,
          routine: a.routine,
          previousRoutine: a.previousRoutine,
          system: bot.systemId,
          shipClass: bot.shipClass,
          credits: bot.credits,
          score: a.score,
        },
        profitImpact: undefined, // Will be updated by performance tracker in future
      }).catch(() => {}); // Fire and forget
    }

    // Log economy state as market intel (periodically, not every tick)
    if (economy.deficits.length > 0 && Math.random() < 0.1) {
      const deficitText = economy.deficits.slice(0, 3)
        .map(d => `${d.itemId}: need ${d.demandPerHour}/hr, have ${d.supplyPerHour}/hr`)
        .join("; ");

      store.store({
        text: `Supply deficits: ${deficitText} (net profit: ${economy.netProfit}cr/hr)`,
        category: "market_intel",
        metadata: {
          deficits: economy.deficits.map(d => d.itemId),
          netProfit: economy.netProfit,
        },
      }).catch(() => {}); // Fire and forget
    }
  }

  /**
   * Feed bandit brain with rewards from completed routine cycles.
   * Compares bot state now vs snapshot from last eval to compute credit delta.
   * Only feeds when a bot has changed routine (indicating cycle completion).
   */
  private async feedBanditRewards(fleet: FleetStatus, economy: import("./types").EconomySnapshot): Promise<void> {
    const scoringBrain = this.getScoringBrain();
    const bandit = scoringBrain?.banditBrain;
    if (!bandit) return;

    for (const bot of fleet.bots) {
      const prev = this._botSnapshots.get(bot.botId);

      if (prev && prev.routine && prev.routine !== bot.routine) {
        // Routine changed — the previous routine completed a cycle
        const durationSec = Math.max(this.tick - prev.startTick, 30);
        const creditDelta = (bot.credits ?? 0) - (prev.credits ?? 0);

        // Build simple reward signals from credit delta
        // Full signal extraction would require event tracking — credit delta is the main signal
        const signals = emptySignals();
        signals.creditDelta = creditDelta;

        // Compute composite reward
        const { reward, breakdown } = computeReward(signals, durationSec, this.goals);

        // Build context from previous state (what the bot looked like at decision time)
        const context = extractContext(bot, economy, this.goals, fleet.bots.length, this.deps.homeSystem);

        const role = prev.role ?? "generalist";
        await bandit.recordOutcome(role, prev.routine as any, context, reward, {
          botId: bot.botId,
          durationSec,
          goalType: this.goals[0]?.type,
          rewardBreakdown: breakdown,
        });
      }

      // Update snapshot for next cycle
      this._botSnapshots.set(bot.botId, {
        credits: bot.credits ?? 0,
        routine: bot.routine,
        role: bot.role,
        startTick: this.tick,
      });
    }
  }

  private recordDecision(
    decision: CommanderDecision,
    fleet: FleetStatus,
    economy: { deficits: unknown[]; surpluses: unknown[]; netProfit: number }
  ): void {
    // Add to history
    this.decisionHistory.push(decision);
    if (this.decisionHistory.length > this.maxHistorySize) {
      this.decisionHistory.shift();
    }

    // Log to training data
    try {
      this.deps.logger.logCommanderDecision({
        tick: decision.tick,
        goal: decision.goal,
        fleetState: {
          totalBots: fleet.bots.length,
          activeBots: fleet.activeBots,
          totalCredits: fleet.totalCredits,
          botSummaries: fleet.bots.map((b) => ({
            id: b.botId,
            status: b.status,
            routine: b.routine,
            lastRoutine: b.lastRoutine,
            system: b.systemId,
            fuelPct: b.fuelPct,
            cargoPct: b.cargoPct,
            credits: b.credits,
          })),
        },
        assignments: decision.assignments.map((a) => ({
          botId: a.botId,
          routine: a.routine,
          score: a.score,
          previous: a.previousRoutine,
          reasoning: a.reasoning,
          params: a.params,
        })),
        reasoning: decision.reasoning,
        economyState: {
          deficits: economy.deficits.length,
          surpluses: economy.surpluses.length,
          netProfit: economy.netProfit,
        },
      });
    } catch {
      // Training logger failure shouldn't break the Commander
    }
  }
}
