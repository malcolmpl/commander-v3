# Fleet Profit Maximizer v1.1 — Bugfix & Polish Spec

**Context:** First live test of the Fleet Profit Maximizer (17-task plan) revealed 6 issues ranging from critical (LLM ignoring role constraints) to observability gaps (no diagnostic logs). This spec addresses all of them in a single pass.

---

## Fix 1: Strict Role Validation Post-LLM

**Problem:** LLM assignments (`commander.ts:684-693`) bypass `getAllowedRoutines(role)` — a quartermaster got assigned explorer. Scoring brain enforces roles (`scoring-brain.ts:222-226`) but LLM overrides with `score: 100` and no validation.

**Fix:** After LLM override merge (line 693) and before routine caps (line 706), filter assignments where `routine ∉ getAllowedRoutines(bot.role)`. Rejected assignments log a warning and fall back to scoring brain's original pick.

```
Location: src/commander/commander.ts, between lines 693 and 706
Logic:
  for each LLM assignment:
    bot = fleet.bots.find(b => b.botId === assignment.botId)
    if bot.role AND assignment.routine NOT in getAllowedRoutines(bot.role):
      log warning: "[Commander] LLM role violation: {botId} role={role} cannot do {routine}, reverting to scoring brain"
      restore original scoring brain assignment for this botId
```

One-shot routines (`return_home`, `refit`, `ship_upgrade`) remain allowed for all roles — `getAllowedRoutines` already includes them.

---

## Fix 2: Fleet Composition Summary Uses Stale Data

**Problem:** `buildThoughts()` (`commander.ts:1318-1329`) counts `bot.routine` from `fleet.bots` — the **current** running routines, not the newly decided assignments. Called at line 704 before assignments are even executed.

**Fix:** Replace `fleet.bots` routine counting with a merged view: start from current bot routines, then overlay `output.assignments` (which at that point includes both scoring brain and LLM decisions).

```
Location: src/commander/commander.ts, lines 1318-1329
Logic:
  // Build effective routine map: current state + pending assignments
  const effectiveRoutines = new Map<string, string>();
  for (const bot of fleet.bots) {
    if (bot.routine) effectiveRoutines.set(bot.botId, bot.routine);
  }
  for (const a of output.assignments) {
    effectiveRoutines.set(a.botId, a.routine);
  }
  // Count from effectiveRoutines.values()
```

`buildThoughts` already receives `output` as parameter — no signature change needed.

---

## Fix 3: Fleet Advisor Force Compute on Request

**Problem:** `message-router.ts:576-582` calls `commander.getAdvisorResult()` which returns `null` until the 15-min timer fires. Dashboard shows "Waiting for advisor data..." permanently if user requests before first compute.

**Fix (two parts):**

**A) Message router — force compute on request:**
```
Location: src/server/message-router.ts, lines 576-582
Change: Instead of getAdvisorResult(), call a new method forceComputeAdvisor()
  that runs compute() immediately regardless of timer, updates lastAdvisorResult,
  and returns the result. If compute() throws or deps are unavailable, return
  lastAdvisorResult as fallback.
```

**B) Commander — add forceComputeAdvisor() method:**
```
Location: src/commander/commander.ts, near getAdvisorResult() (line 395)
New method:
  forceComputeAdvisor(fleet: FleetStatus, economy: EconomySnapshot, world: WorldContext): FleetAdvisorResult
    - Calls this.fleetAdvisor.compute(...) with current state
    - Updates this.lastAdvisorResult and this.lastAdvisorCompute
    - Returns result
```

**C) Also send `null` response so frontend knows no data exists yet:**
```
Location: src/server/message-router.ts
If result is still null after force compute, send:
  { type: "fleet_advisor_update", advisor: null }
Frontend already handles null state with "Waiting..." message.
```

---

## Fix 4: Ship Stats in LLM Prompt

**Problem:** LLM sees `cargo=85%` (percentage) and `ship=accretion` (name) but not absolute cargo capacity, speed comparison, or fitness score. It can't judge which ship is valuable for which role.

**Fix:** Add three fields to `formatFleet()` in `prompt-builder.ts`:

```
Location: src/commander/prompt-builder.ts, formatFleet() lines 183-216
Add after cargo=%:
  - cargoCap={bot.cargoCapacity}    — absolute cargo capacity in units

Add after ship= line:
  - fitness={routine}:{score}       — ship fitness for CURRENT routine (from scoreShipForRole)
```

Example output:
```
Astralis_001 [running] | routine=explorer | role=quartermaster | fuel=90% | cargo=5% | cargoCap=2000 | hull=95% | ship=accretion | fitness=explorer:22 | spd=3 | ...
```

Also add a one-liner to the system prompt constraints section:
```
- SHIP VALUE: cargoCap shows cargo capacity in units. High-cargo ships (cargoCap>500) are valuable
  for trading/mining — do NOT waste them on exploration. Use fitness score to judge suitability.
```

**Data availability check:** `bot.cargoCapacity` exists in `FleetBotInfo` (bot/types.ts:76). Ship fitness requires `scoreShipForRole(shipClass, routine)` from `src/core/ship-fitness.ts` — prompt builder needs access to ship catalog (pass via enrichment context, same pattern as danger map).

---

## Fix 5: DangerMap Persistence to Redis

**Problem:** `DangerMap.serialize()`/`deserialize()` exist but are never called. Every restart loses attack history — bots "forget" dangerous systems.

**Fix:** Use existing RedisCache pattern (`cache-redis.ts`) with a single key per tenant.

```
Key: t:{tenantId}:dangermap
TTL: 7200 (2 hours — covers 4 half-lives of 30min decay, after which data is negligible anyway)
```

**Save trigger:** After each `recordAttack()` call in commander, debounce persist to once per eval cycle (not per attack).

```
Location: src/commander/commander.ts
In _doEvaluateAndAssign(), after all danger events processed:
  if (this.dangerMapDirty) {
    await this.redis?.setJson(dangerMapKey, this.dangerMap.serialize(), 7200);
    this.dangerMapDirty = false;
  }
```

**Load trigger:** In Commander constructor or `start()`, before first eval:
```
  const saved = await this.redis?.getJson(dangerMapKey);
  if (saved) {
    this.dangerMap = DangerMap.deserialize(saved, config);
    console.log("[DangerMap] Restored from Redis");
  }
```

No schema changes — Redis only, JSON string value.

---

## Fix 6: Diagnostic Logs

**Problem:** DangerMap, MarketRotation, FleetAdvisor, ROIAnalyzer produce zero console output. Can't verify they work on live instance.

**Fix:** Add targeted logs at key decision points. All prefixed with module tag for grep-ability.

| Module | Log point | Example |
|--------|-----------|---------|
| **DangerMap** | `recordAttack()` | `[DangerMap] Attack in {systemId}, score now {score}` |
| **DangerMap** | On restore from Redis | `[DangerMap] Restored {N} system(s) from Redis` |
| **MarketRotation** | `assignBot()` | `[MarketRotation] Assigned {botId} → {stationId} (age={ageMin}min, priority={p})` |
| **MarketRotation** | Coverage change >10% | `[MarketRotation] Coverage: {pct}% ({fresh}/{total} fresh)` |
| **FleetAdvisor** | After `compute()` | `[FleetAdvisor] {bottlenecks.length} bottleneck(s), suggest {suggested} bots (+{pct}% profit)` |
| **ROIAnalyzer** | Top path selected | `[ROI] Best path: {type} — {profitPerTick} cr/tick (confidence={conf})` |

Log frequency: max once per eval cycle per module (no spam in tight loops).

---

## Fix 7: Review & Reference Docs Update

After all fixes are implemented and tests pass:

1. **Code review** — run `superpowers:requesting-code-review` against all changed files
2. **Update reference docs:**
   - `docs/references/architecture.md` — note DangerMap Redis persistence
   - `docs/references/ai-brains.md` — note role validation enforcement, ship stats in prompt
   - `docs/references/api-and-server.md` — note `forceComputeAdvisor` behavior change
   - `docs/references/fleet-profit-maximizer.md` — add "Known Issues Fixed" section

---

## Files Changed

| File | Fixes |
|------|-------|
| `src/commander/commander.ts` | #1 (role validation), #2 (composition), #3 (forceComputeAdvisor), #5 (Redis save/load) |
| `src/commander/prompt-builder.ts` | #4 (ship stats + guidance) |
| `src/server/message-router.ts` | #3 (force compute handler) |
| `src/commander/danger-map.ts` | #6 (log in recordAttack) |
| `src/commander/market-rotation.ts` | #6 (log in assignBot, coverage) |
| `src/commander/fleet-advisor.ts` | #6 (log after compute) |
| `src/commander/roi-analyzer.ts` | #6 (log top path) |
| `docs/references/*.md` | #7 (reference updates) |

## Test Strategy

- Fix 1: Unit test — mock LLM returning role-violating assignment, verify it's rejected
- Fix 2: Unit test — verify composition counts include pending assignments
- Fix 3: Integration test — call forceComputeAdvisor, verify non-null return
- Fix 4: Snapshot test — verify formatFleet output includes cargoCap and fitness
- Fix 5: Unit test — serialize → Redis set → Redis get → deserialize roundtrip
- Fix 6: No tests (log-only changes)
- Fix 7: Manual review
