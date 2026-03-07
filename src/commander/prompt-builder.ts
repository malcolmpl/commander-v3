/**
 * Builds structured prompts from EvaluationInput for LLM brains.
 * Converts fleet state, goals, economy, and world context into
 * a concise text prompt with JSON output format instructions.
 */

import type { EvaluationInput, WorldContext, EconomySnapshot } from "./types";
import type { FleetBotInfo } from "../bot/types";
import type { Goal } from "../config/schema";
import type { RoutineName } from "../types/protocol";

const VALID_ROUTINES: RoutineName[] = [
  "miner", "crafter", "trader", "quartermaster", "explorer",
  "return_home", "scout", "ship_upgrade", "refit",
  "harvester", "hunter", "salvager", "scavenger", "mission_runner",
];

/** Build system prompt (stable, cacheable) */
export function buildSystemPrompt(): string {
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
- Assign refit when bots have worn modules (modWear dropping) or missing module slots
- mission_runner is great for XP gain and refreshes market data as a side effect

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

/** Build user prompt with current fleet state */
export function buildUserPrompt(input: EvaluationInput, extraContext?: string): string {
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
  sections.push(formatFleet(input.fleet.bots));

  // Economy
  if (input.economy.deficits.length > 0 || input.economy.surpluses.length > 0) {
    sections.push(formatEconomy(input.economy));
  }

  // World context
  if (input.world) {
    sections.push(formatWorld(input.world));
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

function formatFleet(bots: FleetBotInfo[]): string {
  if (bots.length === 0) return "FLEET: No bots available";

  const lines = bots.map(b => {
    const parts = [
      `${b.botId} [${b.status}]`,
      b.routine ? `routine=${b.routine}` : "unassigned",
      `fuel=${b.fuelPct}%`,
      `cargo=${b.cargoPct}%`,
      `hull=${b.hullPct}%`,
      `ship=${b.shipClass}`,
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
    return `  ${parts.join(" | ")}`;
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

/** Try to extract a JSON object from text that may contain thinking/narrative */
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
      if (
        typeof a.botId === "string" &&
        validBotIds.has(a.botId) &&
        typeof a.routine === "string" &&
        VALID_ROUTINES.includes(a.routine as RoutineName)
      ) {
        assignments.push({
          botId: a.botId,
          routine: a.routine as RoutineName,
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
