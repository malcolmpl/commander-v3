# PostgreSQL Migration Design

**Date:** 2026-03-29
**Status:** Approved
**Branch:** `feature/postgres-setup` (worktree: `commander-v3-work`)

## Problem

Upstream commander-v3 migrated to PostgreSQL with multi-tenant support. Our fork attempted SQLite compatibility patches but introduced critical bugs:

1. `schema.ts` re-exports PG schema (`pgTable`) — all Drizzle queries generate PostgreSQL SQL against SQLite
2. `schema-sqlite.ts` missing `tenantId` columns — every `eq(table.tenantId, ...)` crashes
3. `schema-sqlite.ts` missing `users` table — server auth/stats queries fail
4. `startup.ts` calls persistence functions without `tenantId` parameter
5. `server.ts` uses PostgreSQL-specific raw SQL (`::numeric`, `DATE_TRUNC`)

Result: WebSocket crashes on first DB query → "Connection lost. Reconnecting..." in dashboard, no data visible.

## Decision

Revert SQLite patches, adopt PostgreSQL via Docker. Migrate existing data from `commander.db`.

## Architecture

### Docker Container

- **Container:** `commander-v3-db`
- **Image:** `postgres:16-alpine`
- **Port:** `5433:5432` (avoids conflict with existing `n8n-postgres-1` on 5432)
- **Volume:** `commander_pgdata` (named volume for persistence)
- **Database:** `commander`, user `commander`

### Files to Create

| File | Purpose |
|------|---------|
| `docker-compose.yml` | PG container with real password (.gitignored) |
| `docker-compose.example.yml` | Template without password (committed) |
| `scripts/migrate-sqlite-to-pg.ts` | Migration script: creates tables + transfers data |

### Files to Modify

| File | Change |
|------|--------|
| `config.toml` | Add `[database] url = "postgresql://commander:PASS@localhost:5433/commander"` |
| `drizzle.config.ts` | Update default URL to localhost:5433 |
| `.gitignore` | Add `docker-compose.yml` |

### Files NOT Modified

- All `src/` files — upstream PG code works as-is
- `schema-sqlite.ts` — remains in repo, unused
- `commander.db` — remains as backup

## Migration Script

**File:** `scripts/migrate-sqlite-to-pg.ts`

**Behavior:**
1. Opens `commander.db` via `bun:sqlite`
2. Connects to PostgreSQL via `postgres` (postgres.js)
3. Creates all tables using raw SQL matching `schema-pg.ts` definitions
4. For each table with data: SELECT from SQLite → batch INSERT into PG with `tenant_id = 'local'`

**Tables to migrate (with data):**

| Table | Rows | Notes |
|-------|------|-------|
| bot_sessions | 5 | Bot credentials (hashed passwords) |
| commander_memory | 6 | Strategic memory |
| market_history | 2516 | Price history |
| commander_log | 597 | Commander decisions |
| credit_history | 1300 | Credit charts |
| llm_decisions | 565 | AI brain comparisons |
| faction_transactions | 125 | Faction operations |
| cache | 27 | Static data cache |
| timed_cache | 30 | TTL cache |

**Skipped (empty):** bot_settings, bot_skills, goals, fleet_settings, decision_log, state_snapshots, episodes, financial_events, trade_log, activity_log, bandit_weights, bandit_episodes, outcome_embeddings, poi_cache, users.

**Column mapping:** All columns map 1:1. Only addition is `tenant_id = 'local'` on every row.

## Task Breakdown

| # | Task | Difficulty | Agent | Dependencies |
|---|------|-----------|-------|--------------|
| T1 | Docker Compose (yml + example + .gitignore) | Easy | Haiku | - |
| T2 | Update config.toml + drizzle.config.ts | Easy | Haiku | - |
| T3 | Migration script (SQLite → PG) | Medium | Sonnet | T1 (needs connection string) |
| T4 | Run migration + verify | - | Opus | T1, T2, T3 |

T1 and T2 run in parallel. T3 waits for T1 (connection string). T4 is manual verification.

## Startup Workflow

```bash
docker compose up -d                          # Start PostgreSQL
bun run scripts/migrate-sqlite-to-pg.ts       # Create tables + migrate data
bun run start                                 # Start commander (uses PG)
```

## Rollback

If PostgreSQL doesn't work out:
- `commander.db` is untouched — revert to SQLite by changing `config.toml` back
- Docker container can be removed: `docker compose down -v`
