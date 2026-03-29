/**
 * Builds structured prompts from EvaluationInput for LLM brains.
 * Converts fleet state, goals, economy, and world context into
 * a concise text prompt with JSON output format instructions.
 */

import type { EvaluationInput, WorldContext, EconomySnapshot, FleetAdvisorResult } from "./types";
import type { FleetBotInfo, FleetStatus } from "../bot/types";
import type { Goal } from "../config/schema";
import type { RoutineName } from "../types/protocol";
import type { StrategicTrigger } from "./strategic-triggers";
import type { RetrievedMemory } from "./embedding-store";
import type { DangerMap } from "./danger-map";
import type { MarketRotation } from "./market-rotation";
import { scoreShipForRole } from "../core/ship-fitness";
import type { ShipClass } from "../types/game";

const VALID_ROUTINES: RoutineName[] = [
  "miner", "crafter", "trader", "quartermaster", "explorer",
  "return_home", "scout", "ship_upgrade", "refit",
  "harvester", "hunter", "salvager", "scavenger", "mission_runner",
];

/** Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Fuzzy-match a string against a set of valid values. Returns match if distance <= maxDist. */
function fuzzyMatch(input: string, validSet: Iterable<string>, maxDist = 2): string | null {
  const lower = input.toLowerCase().trim();
  let bestMatch: string | null = null;
  let bestDist = maxDist + 1;
  for (const candidate of validSet) {
    const dist = levenshtein(lower, candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      bestMatch = candidate;
    }
  }
  return bestDist <= maxDist ? bestMatch : null;
}

/** Build system prompt (stable, cacheable). If promptFile is set, loads from disk (fresh each eval). */
export function buildSystemPrompt(promptFile?: string): string {
  if (promptFile) {
    try {
      const { readFileSync } = require("fs");
      const text = readFileSync(promptFile, "utf-8") as string;
      if (text.trim().length > 0) return text;
    } catch {
      // File missing or unreadable — fall through to default
    }
  }

  return `You are a fleet commander AI for SpaceMolt, a space MMO. You manage bot assignments.

AVAILABLE ROUTINES:
- miner: Extract ore at asteroid belts, deposit to faction storage (core income)
- harvester: Flexible extraction — ice fields, gas clouds, ore belts. Needs specialized modules (ice_harvester, gas_harvester)
- crafter: Source materials from faction storage, craft items, deposit output (core supply chain)
- trader: Arbitrage trading — buys low at one station, sells high at another using market intel. Also sells faction goods. HIGH PRIORITY for income
- quartermaster: Stay docked at home base, manage equipment, sell goods, and upgrade faction facilities
- explorer: Chart new systems, scan for resources, submit intel to faction
- hunter: Combat patrol — roam hunting pirates/drifters, loot wrecks. Requires weapons. High fuel use, variable returns
- salvager: Tow wrecks to station, scrap/sell them. Needs tow/salvage modules
- scavenger: Peaceful roamer — visits POIs, loots abandoned wrecks/containers. LOW PRIORITY — burns fuel with poor returns, max 1
- mission_runner: Accept and complete NPC missions at stations. Good XP and credits. Docks frequently (refreshes market data)
- scout: One-shot: dock at target, scan market, check faction
- ship_upgrade: One-shot: buy a better ship when budget allows
- refit: One-shot: optimize module loadout for role (upgrade tiers, fill empty slots, repair worn modules)
- return_home: Navigate to home base and dock

FLEET CAPABILITIES:
- Module repair: All routines auto-repair worn modules when docking (durability < 90%)
- Consumables: Bots can use repair kits, fuel cells, and buff items
- Ship commissioning: Fleet can commission custom ships (cheaper than pre-built) and supply materials
- Faction intel: Bots submit system and trade intel to faction database for shared knowledge
- Faction market orders: Fleet can create faction-level buy/sell orders

CONSTRAINTS:
- Max 1 scout, 1 explorer, 1 quartermaster, 1 ship_upgrade, 1 hunter, 1 salvager, 1 scavenger, 2 refit at a time
- Bots with <20% fuel should be return_home or refuel-capable routines
- Bots with <30% hull should avoid combat/exploration
- Hunter requires weapon modules equipped — don't assign to unarmed bots
- Salvager requires tow/salvage modules — check equipment first
- Harvester requires ice_harvester or gas_harvester modules for non-ore targets
- Supply chain: miners→ore→faction→crafters→goods→faction→traders→sell
- PRIORITY: miners, crafters, traders are core income. Prefer traders over scavengers for idle bots
- Diversity: avoid assigning all bots to the same routine
- FUEL PHYSICS: fuel scales with ship mass, speed, distance, and cargo load. Slow heavy ships burn more. Prefer short trade routes for slow ships
- JUMP TIME: jump ticks = ceil(10/speed). Speed-2 ships take 5 ticks/jump; speed-6 take 2. Assign fast ships to multi-jump routes
- SPECIALIST ROLES: bots with role= are specialists — only assign them routines compatible with their role. Do NOT reassign specialists to other roles
- Assign refit when bots have worn modules (modWear dropping) or missing module slots
- mission_runner is great for XP gain and refreshes market data as a side effect
- SHIP VALUE: cargoCap shows cargo capacity in units. High-cargo ships (cargoCap>500) are valuable for trading/mining — do NOT waste them on exploration. Use fitness score to judge suitability (higher = better match)

LEARNING:
- RECENT OUTCOMES section shows credit delta per bot per routine — use this to learn which assignments are profitable
- ROUTINE PERFORMANCE section shows average cr/min per routine — prefer high-performing routines
- Avoid repeating assignments that consistently lose credits

OUTPUT FORMAT (strict JSON):
{
  "assignments": [
    {
      "botId": "bot_id_here",
      "routine": "miner",
      "reasoning": "Brief reason for this assignment"
    }
  ],
  "reasoning": "Overall fleet strategy explanation",
  "confidence": 0.85
}

Only assign bots with status "ready" (unassigned) or "running" (if a better assignment exists).
Do NOT reassign bots that are already optimally assigned.
Return empty assignments array if no changes needed.

CRITICAL: Respond with ONLY the JSON object. No explanation, no thinking, no markdown. Just raw JSON.`;
}

/** Additional context from new modules (danger map, market rotation, fleet advisor) */
export interface PromptEnrichment {
  dangerMap?: DangerMap;
  marketRotation?: MarketRotation;
  advisorResult?: FleetAdvisorResult | null;
  shipCatalog?: ShipClass[];
}

/** Build user prompt with current fleet state */
export function buildUserPrompt(input: EvaluationInput, extraContext?: string, enrichment?: PromptEnrichment): string {
  const sections: string[] = [];

  // Performance outcomes + persistent memory (injected by Commander)
  if (extraContext) {
    sections.push(extraContext);
  }

  // Goals
  if (input.goals.length > 0) {
    sections.push(formatGoals(input.goals));
  }

  // Fleet state
  sections.push(formatFleet(input.fleet.bots, enrichment?.shipCatalog));

  // Economy
  if (input.economy.deficits.length > 0 || input.economy.surpluses.length > 0) {
    sections.push(formatEconomy(input.economy));
  }

  // World context
  if (input.world) {
    sections.push(formatWorld(input.world));
  }

  // Danger map, market rotation, fleet advisor enrichment
  if (enrichment) {
    const enrichmentText = formatEnrichment(enrichment);
    if (enrichmentText) sections.push(enrichmentText);
  }

  sections.push(`Tick: ${input.tick}`);

  return sections.join("\n\n");
}

function formatGoals(goals: Goal[]): string {
  const lines = goals.map(g =>
    `  - ${g.type} (priority ${g.priority})`
  );
  return `ACTIVE GOALS:\n${lines.join("\n")}`;
}

function formatFleet(bots: FleetBotInfo[], shipCatalog?: ShipClass[]): string {
  if (bots.length === 0) return "FLEET: No bots available";

  const lines = bots.map(b => {
    const parts = [
      `${b.botId} [${b.status}]`,
      b.routine ? `routine=${b.routine}` : "unassigned",
      b.role ? `role=${b.role}` : null,
      `fuel=${b.fuelPct}%`,
      `cargo=${b.cargoPct}%`,
      `cargoCap=${b.cargoCapacity}`,
      `hull=${b.hullPct}%`,
      `ship=${b.shipClass}`,
      `spd=${b.speed}`,
      (() => {
        if (!shipCatalog || !b.routine) return null;
        const ship = shipCatalog.find(s => s.id === b.shipClass);
        if (!ship) return null;
        return `fitness=${b.routine}:${scoreShipForRole(ship, b.routine)}`;
      })(),
      `system=${b.systemId}`,
      b.docked ? "docked" : "undocked",
    ];
    // Module info — equipment and wear
    if (b.moduleIds.length > 0) {
      parts.push(`mods=[${b.moduleIds.join(",")}]`);
    }
    if (b.moduleWear < 95) {
      parts.push(`modWear=${Math.round(b.moduleWear)}%`);
    }
    if (b.skills && Object.keys(b.skills).length > 0) {
      const skills = Object.entries(b.skills)
        .map(([k, v]) => `${k}:${v}`)
        .join(",");
      parts.push(`skills={${skills}}`);
    }
    return `  ${parts.filter(Boolean).join(" | ")}`;
  });

  return `FLEET (${bots.length} bots):\n${lines.join("\n")}`;
}

function formatEconomy(eco: EconomySnapshot): string {
  const parts: string[] = ["ECONOMY:"];

  if (eco.deficits.length > 0) {
    parts.push("  Deficits:");
    for (const d of eco.deficits) {
      parts.push(`    - ${d.itemId}: need ${d.demandPerHour}/hr, have ${d.supplyPerHour}/hr (${d.priority})`);
    }
  }

  if (eco.surpluses.length > 0) {
    parts.push("  Surpluses:");
    for (const s of eco.surpluses) {
      parts.push(`    - ${s.itemId}: +${s.excessPerHour}/hr at ${s.stationId}`);
    }
  }

  if (eco.netProfit !== 0) {
    parts.push(`  Net profit: ${eco.netProfit}cr/hr`);
  }

  return parts.join("\n");
}

function formatWorld(world: WorldContext): string {
  const parts: string[] = ["WORLD:"];

  parts.push(`  Galaxy loaded: ${world.galaxyLoaded}`);
  parts.push(`  Market data: ${world.hasAnyMarketData ? "yes" : "none"}`);
  parts.push(`  Data freshness: ${Math.round(world.dataFreshnessRatio * 100)}%`);

  if (world.tradeRouteCount > 0) {
    parts.push(`  Trade routes: ${world.tradeRouteCount} (best profit: ${world.bestTradeProfit}/tick)`);
  }

  if (world.demandInsightCount > 0) {
    parts.push(`  High-priority demand insights: ${world.demandInsightCount}`);
  }

  return parts.join("\n");
}

// ── Strategic Prompt (focused, for trigger-based LLM calls) ──

/** Build a focused system prompt for strategic-only LLM consultations */
export function buildStrategicSystemPrompt(): string {
  return `You are a fleet strategy advisor for SpaceMolt, a space MMO.
You are consulted ONLY when something strategically significant happens (not every tick).
The fleet's routine assignments are handled by a deterministic scoring engine.

Your job: analyze the strategic trigger and recommend CHANGES to the fleet's approach.

AVAILABLE ROUTINES: miner, harvester, crafter, trader, quartermaster, explorer, hunter, salvager, scavenger, mission_runner, scout, ship_upgrade, refit, return_home

You may recommend:
1. Reassigning specific bots to different routines (if the scoring engine is making poor choices)
2. Strategic observations (e.g., "iron trading is declining, shift to crafting")
3. No changes needed (if the scoring engine is handling it well)

OUTPUT FORMAT (strict JSON):
{
  "assignments": [
    { "botId": "bot_id", "routine": "routine_name", "reasoning": "why" }
  ],
  "strategic_advice": "One sentence about fleet-level strategy",
  "confidence": 0.85
}

Return empty assignments if no changes needed. ONLY raw JSON, no explanation.`;
}

/**
 * Build a focused user prompt for a strategic trigger.
 * Much smaller than the full eval prompt — only includes:
 * 1. The trigger (why was the LLM called?)
 * 2. Retrieved memories (relevant past outcomes)
 * 3. Fleet summary (compact, not full state dump)
 * 4. Economy summary
 */
export function buildStrategicUserPrompt(
  trigger: StrategicTrigger,
  memories: RetrievedMemory[],
  fleet: FleetStatus,
  economy: EconomySnapshot,
  goals: Array<{ type: string; priority: number }>,
  enrichment?: PromptEnrichment,
): string {
  const sections: string[] = [];

  // 1. Trigger
  sections.push(`STRATEGIC TRIGGER [${trigger.type}] (priority ${trigger.priority}):\n${trigger.reason}`);

  // 2. Retrieved memories
  if (memories.length > 0) {
    const memLines = memories.map(m => {
      const profit = m.profitImpact != null
        ? ` (${m.profitImpact > 0 ? "+" : ""}${Math.round(m.profitImpact)}cr)`
        : "";
      return `  - ${m.text}${profit}`;
    });
    sections.push(`RELEVANT PAST OUTCOMES:\n${memLines.join("\n")}`);
  }

  // 3. Goals
  if (goals.length > 0) {
    sections.push(`GOALS: ${goals.map(g => `${g.type}(p=${g.priority})`).join(", ")}`);
  }

  // 4. Compact fleet summary
  const botSummaries = fleet.bots
    .filter(b => b.status === "ready" || b.status === "running")
    .map(b => {
      const parts = [b.botId, b.routine ?? "idle", `${b.shipClass}`, `fuel=${b.fuelPct}%`];
      if (b.role) parts.push(`role=${b.role}`);
      return parts.join(" ");
    });
  sections.push(`FLEET (${fleet.bots.length} bots, ${fleet.totalCredits.toLocaleString()}cr):\n${botSummaries.map(s => `  ${s}`).join("\n")}`);

  // 5. Economy (deficits only — surpluses are less actionable)
  if (economy.deficits.length > 0) {
    const defs = economy.deficits.slice(0, 5).map(d =>
      `${d.itemId}: need ${d.demandPerHour}/hr, have ${d.supplyPerHour}/hr [${d.priority}]`
    );
    sections.push(`DEFICITS:\n${defs.map(d => `  - ${d}`).join("\n")}`);
  }

  // 6. Enrichment (danger map, market coverage, advisor bottlenecks)
  if (enrichment) {
    const enrichmentText = formatEnrichment(enrichment);
    if (enrichmentText) sections.push(enrichmentText);
  }

  return sections.join("\n\n");
}


/** Format enrichment context (danger map, market rotation, fleet advisor) for LLM prompt */
function formatEnrichment(enrichment: PromptEnrichment): string | null {
  const parts: string[] = [];

  // Dangerous systems
  if (enrichment.dangerMap) {
    const dangerous = enrichment.dangerMap.getAllDangerous();
    if (dangerous.length > 0) {
      parts.push("DANGEROUS SYSTEMS:");
      for (const d of dangerous.slice(0, 10)) {
        parts.push(`  - ${d.systemId}: danger=${(d.score * 100).toFixed(0)}% (${d.attacks} attacks)`);
      }
      parts.push("  → Avoid routing traders through these systems. Consider hunter patrol.");
    }
  }

  // Market coverage
  if (enrichment.marketRotation) {
    const total = enrichment.marketRotation.getTotalStations();
    if (total > 0) {
      const coverage = enrichment.marketRotation.getCoverage();
      const stale = enrichment.marketRotation.getStaleCount();
      parts.push(`MARKET COVERAGE: ${Math.round(coverage * 100)}% fresh (${stale}/${total} stations stale)`);
      const targets = enrichment.marketRotation.getTopTargets(3);
      if (targets.length > 0) {
        parts.push("  Top scan targets: " + targets.map(t => `${t.stationId} (${Math.round(t.ageMs / 60_000)}min old)`).join(", "));
      }
    }
  }

  // Fleet advisor summary
  if (enrichment.advisorResult) {
    const adv = enrichment.advisorResult;
    if (adv.bottlenecks.length > 0) {
      parts.push("FLEET ADVISOR BOTTLENECKS:");
      for (const b of adv.bottlenecks) {
        parts.push(`  - ${b}`);
      }
      if (adv.estimatedProfitIncreasePct > 0) {
        parts.push(`  → Addressing these could increase profit by ~${adv.estimatedProfitIncreasePct}%`);
      }
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

function extractJson(raw: string): Record<string, unknown> {
  const text = raw.trim();

  // Strategy 1: Markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* try next */ }
  }

  // Strategy 2: Raw JSON (entire response is JSON)
  if (text.startsWith("{")) {
    try { return JSON.parse(text); } catch { /* try next */ }
  }

  // Strategy 3: Find the JSON object containing "assignments" key
  // Scan for `{"assignments"` which is our expected output format
  const assignIdx = text.indexOf('"assignments"');
  if (assignIdx >= 0) {
    // Walk backwards to find the opening brace
    let braceStart = text.lastIndexOf("{", assignIdx);
    if (braceStart >= 0) {
      // Find matching closing brace by counting depth
      let depth = 0;
      for (let i = braceStart; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(braceStart, i + 1)); } catch { break; }
        }
      }
    }
  }

  // Strategy 4: First { to last } (greedy)
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* give up */ }
  }

  throw new Error(`Could not extract JSON from LLM response (${text.length} chars, starts: "${text.slice(0, 60)}...")`);
}

/** Parse LLM JSON response into assignments */
export function parseLlmResponse(
  raw: string,
  validBotIds: Set<string>,
): {
  assignments: Array<{ botId: string; routine: RoutineName; reasoning: string }>;
  reasoning: string;
  confidence: number;
} {
  // Extract JSON from response — model may wrap in code fences, prepend thinking, etc.
  const parsed = extractJson(raw);

  const assignments: Array<{ botId: string; routine: RoutineName; reasoning: string }> = [];

  if (Array.isArray(parsed.assignments)) {
    for (const a of parsed.assignments) {
      if (typeof a.botId !== "string" || typeof a.routine !== "string") continue;

      // Exact match first, then fuzzy match for bot IDs
      let resolvedBotId: string | null = validBotIds.has(a.botId) ? a.botId : null;
      if (!resolvedBotId) {
        resolvedBotId = fuzzyMatch(a.botId, validBotIds, 2);
      }

      // Exact match first, then fuzzy match for routine names
      let resolvedRoutine: RoutineName | null = VALID_ROUTINES.includes(a.routine as RoutineName)
        ? (a.routine as RoutineName)
        : null;
      if (!resolvedRoutine) {
        const match = fuzzyMatch(a.routine, VALID_ROUTINES, 2);
        if (match) resolvedRoutine = match as RoutineName;
      }

      if (resolvedBotId && resolvedRoutine) {
        assignments.push({
          botId: resolvedBotId,
          routine: resolvedRoutine,
          reasoning: typeof a.reasoning === "string" ? a.reasoning : "",
        });
      }
    }
  }

  return {
    assignments,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
  };
}
