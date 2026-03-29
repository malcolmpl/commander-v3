# Fix All TypeScript Errors — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all `tsc --noEmit` errors by switching DB type to PG-only and fixing missing awaits, missing args, and other issues.

**Architecture:** Change `DB` union type (`PgDatabase | SQLiteDatabase`) to PG-only. This resolves ~50 insert/select/execute errors. Fix missing `await` on async cache methods (runtime bugs). Fix missing `tenantId` args and other one-off issues.

**Tech Stack:** TypeScript, Drizzle ORM, PostgreSQL

---

### Task 1: DB type → PG-only

**Files:**
- Modify: `src/data/db.ts:22` — change DB type
- Modify: `src/data/db.ts:30` — narrow raw type

- [ ] **Step 1: Change DB type to PG-only**

In `src/data/db.ts`, line 22, change:
```typescript
export type DB = ReturnType<typeof drizzlePg> | ReturnType<typeof drizzleSqlite>;
```
to:
```typescript
export type DB = ReturnType<typeof drizzlePg>;
```

- [ ] **Step 2: Narrow DatabaseConnection.raw type**

In `src/data/db.ts`, line 30, change:
```typescript
raw: postgres.Sql | Database;
```
to:
```typescript
raw: postgres.Sql;
```

- [ ] **Step 3: Run tsc and count remaining errors**

Run: `bunx tsc --noEmit 2>&1 | wc -l`
Expected: Error count drops from ~80+ to ~30 (DB union errors eliminated)

- [ ] **Step 4: Commit**

```bash
git add src/data/db.ts
git commit -m "fix(types): narrow DB type to PG-only (SQLite legacy removed)"
```

---

### Task 2: Fix missing `await` on async cache methods

**Files:**
- Modify: `src/bot/bot-manager.ts:366,373,431`
- Modify: `src/commander/commander.ts:452,465,484`

These are **runtime bugs** — Promises used without await, so `.length`, `.filter()`, `for..of` operate on Promise objects instead of arrays.

- [ ] **Step 1: Fix bot-manager.ts**

At line ~366, add `await`:
```typescript
const persistedPois = await this.services.cache.loadPersistedPois();
```

At line ~373, add `await`:
```typescript
const persistedSystems = await this.services.cache.loadPersistedSystemDetails();
```

At line ~431, add `await`:
```typescript
const facilityOnly = await this.services.cache.getFacilityOnlyRecipes();
```

Note: The containing method must already be `async`. If not, make it async.

- [ ] **Step 2: Fix commander.ts**

At line ~452, add `await`:
```typescript
const persistedSystems = await this.deps.cache.loadPersistedSystemDetails();
```

At line ~465, add `await`:
```typescript
const persistedPois = await this.deps.cache.loadPersistedPois();
```

At line ~484, add `await`:
```typescript
const facilityOnly = await this.deps.cache.getFacilityOnlyRecipes();
```

- [ ] **Step 3: Fix chat-intelligence.ts (if needed)**

Check line ~501 — `this.memoryStore?.getTop(5)`. If `getTop` is async, add `await`. If sync, add type annotation to suppress implicit-any on parameter `m`.

- [ ] **Step 4: Run tsc, verify these errors are gone**

Run: `bunx tsc --noEmit 2>&1 | grep -c "bot-manager\|commander\.ts\|chat-intelligence"`
Expected: 0

- [ ] **Step 5: Commit**

```bash
git add src/bot/bot-manager.ts src/commander/commander.ts src/commander/chat-intelligence.ts
git commit -m "fix: add missing await on async cache methods (runtime bug)"
```

---

### Task 3: Fix startup.ts errors

**Files:**
- Modify: `src/startup.ts:344,355,362,602`

- [ ] **Step 1: Add missing tenantId arguments**

At line ~344, change:
```typescript
const savedGoals = await loadGoals(db);
```
to:
```typescript
const savedGoals = await loadGoals(db, tenantId);
```

At line ~355, change:
```typescript
const settings = await loadBotSettings(db, creds.username);
```
to:
```typescript
const settings = await loadBotSettings(db, tenantId, creds.username);
```

At line ~362, change:
```typescript
const cachedSkills = await loadBotSkills(db, creds.username);
```
to:
```typescript
const cachedSkills = await loadBotSkills(db, tenantId, creds.username);
```

- [ ] **Step 2: Remove duplicate openai property**

At line ~602, there are two `openai:` entries in the `brainMap` object. Remove the second one (without `promptFile`), keep only:
```typescript
openai: () => createOpenAIBrain({
  baseUrl: config.ai.openai_base_url,
  model: config.ai.openai_model,
  timeoutMs: config.ai.max_latency_ms,
  maxTokens: config.ai.max_tokens,
  promptFile,
}),
```

- [ ] **Step 3: Run tsc, verify startup.ts is clean**

Run: `bunx tsc --noEmit 2>&1 | grep -c "startup.ts"`
Expected: 0

- [ ] **Step 4: Commit**

```bash
git add src/startup.ts
git commit -m "fix: add missing tenantId args and remove duplicate openai entry in startup"
```

---

### Task 4: Fix remaining implicit-any and minor errors

**Files:**
- Modify: `src/data/training-logger.ts` — implicit `any` on parameters
- Modify: `src/commander/chat-intelligence.ts` — implicit `any` on filter callbacks

- [ ] **Step 1: Run tsc and list remaining errors**

Run: `bunx tsc --noEmit 2>&1`
Catalog each remaining error with file + line.

- [ ] **Step 2: Fix implicit-any errors**

Add explicit type annotations to parameters flagged by TS. For example:
- `(r: any)` or the proper row type in training-logger.ts
- `(m: MemoryFact)` in chat-intelligence.ts filter callbacks

- [ ] **Step 3: Fix any other remaining errors found in step 1**

Address each one individually.

- [ ] **Step 4: Run tsc — zero errors**

Run: `bunx tsc --noEmit 2>&1`
Expected: No output (clean build)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(types): resolve remaining implicit-any and minor TS errors"
```

---

### Task 5: Verify runtime

- [ ] **Step 1: Run tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Final tsc check**

Run: `bunx tsc --noEmit`
Expected: 0 errors
