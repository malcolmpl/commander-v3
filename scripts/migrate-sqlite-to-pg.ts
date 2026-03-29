/**
 * One-shot migration: SQLite (commander.db) → PostgreSQL.
 * Reads all data from SQLite tables, inserts into PG with tenant_id = 'local'.
 *
 * Prerequisites:
 *   1. PostgreSQL running (docker compose up -d)
 *   2. Tables created (bunx drizzle-kit push)
 *
 * Usage: bun run scripts/migrate-sqlite-to-pg.ts [--db-url <pg_url>] [--sqlite <path>]
 */

import { Database } from "bun:sqlite";
import postgres from "postgres";
import { parseArgs } from "util";

const args = parseArgs({
  options: {
    "db-url": { type: "string", default: "" },
    sqlite: { type: "string", default: "commander.db" },
    "tenant-id": { type: "string", default: "local" },
  },
});

// Resolve PG URL from args, env, or config.toml
async function resolvePgUrl(): Promise<string> {
  if (args.values["db-url"]) return args.values["db-url"]!;
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  // Try config.toml
  try {
    const toml = await import("toml");
    const text = await Bun.file("config.toml").text();
    const config = toml.parse(text);
    if (config.database?.url?.startsWith("postgresql://")) return config.database.url;
  } catch {}
  console.error("No PostgreSQL URL found. Use --db-url, DATABASE_URL env, or config.toml [database] url");
  process.exit(1);
}

const pgUrl = await resolvePgUrl();
const sqlitePath = args.values.sqlite!;
const tenantId = args.values["tenant-id"]!;

console.log(`[Migration] SQLite: ${sqlitePath}`);
console.log(`[Migration] PostgreSQL: ${pgUrl.replace(/:[^@]+@/, ":***@")}`);
console.log(`[Migration] Tenant ID: ${tenantId}`);

// Open connections
const sqlite = new Database(sqlitePath, { readonly: true });
const pg = postgres(pgUrl, { max: 1 });

// Helper: get row count from SQLite
function sqliteCount(table: string): number {
  return (sqlite.query(`SELECT COUNT(*) as cnt FROM ${table}`).get() as any).cnt;
}

// Helper: get all rows from SQLite
function sqliteAll(table: string): Record<string, unknown>[] {
  return sqlite.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
}

// Migration definitions
interface MigrationDef {
  table: string;
  /** Columns to skip when inserting (e.g. auto-increment id, old tenant_id) */
  skipColumns: string[];
}

const migrations: MigrationDef[] = [
  { table: "bot_sessions", skipColumns: ["tenant_id"] },
  { table: "commander_memory", skipColumns: ["tenant_id"] },
  { table: "market_history", skipColumns: ["id", "tenant_id"] },
  { table: "commander_log", skipColumns: ["id", "tenant_id"] },
  { table: "credit_history", skipColumns: ["id", "tenant_id"] },
  { table: "llm_decisions", skipColumns: ["id", "tenant_id"] },
  { table: "faction_transactions", skipColumns: ["id", "tenant_id"] },
  { table: "cache", skipColumns: ["tenant_id"] },
  { table: "timed_cache", skipColumns: ["tenant_id"] },
];

let totalMigrated = 0;

for (const def of migrations) {
  let count: number;
  try {
    count = sqliteCount(def.table);
  } catch {
    console.log(`[Migration] ${def.table}: not found in SQLite — skipping`);
    continue;
  }
  if (count === 0) {
    console.log(`[Migration] ${def.table}: 0 rows — skipping`);
    continue;
  }

  console.log(`[Migration] ${def.table}: ${count} rows — migrating...`);
  const rows = sqliteAll(def.table);

  // Determine columns from first row, excluding skipColumns
  const skipSet = new Set(def.skipColumns);
  const allColumns = Object.keys(rows[0]).filter((c) => !skipSet.has(c));
  const pgColumns = ["tenant_id", ...allColumns];

  // Batch insert (100 rows at a time)
  const BATCH_SIZE = 100;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map((row) => {
      const vals: unknown[] = [tenantId];
      for (const col of allColumns) {
        vals.push(row[col] ?? null);
      }
      return vals;
    });

    // Build parameterized INSERT
    const placeholders = values
      .map(
        (_, rowIdx) =>
          `(${pgColumns.map((_, colIdx) => `$${rowIdx * pgColumns.length + colIdx + 1}`).join(", ")})`
      )
      .join(", ");
    const flatValues = values.flat();
    const colNames = pgColumns.map((c) => `"${c}"`).join(", ");

    await pg.unsafe(
      `INSERT INTO "${def.table}" (${colNames}) VALUES ${placeholders} ON CONFLICT DO NOTHING`,
      flatValues as any[]
    );
    inserted += batch.length;
  }

  console.log(`[Migration] ${def.table}: ${inserted} rows inserted`);
  totalMigrated += inserted;
}

// Reset sequences for tables with SERIAL PKs
const serialTables = [
  "market_history",
  "commander_log",
  "credit_history",
  "llm_decisions",
  "faction_transactions",
];
for (const table of serialTables) {
  try {
    await pg.unsafe(
      `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    );
  } catch {
    // Table might be empty or sequence might not exist
  }
}

console.log(`\n[Migration] Done! Total rows migrated: ${totalMigrated}`);

// Verify
console.log("\n[Verification]");
for (const def of migrations) {
  const result = await pg.unsafe(`SELECT COUNT(*) as cnt FROM "${def.table}"`);
  console.log(`  ${def.table}: ${result[0].cnt} rows in PG`);
}

sqlite.close();
await pg.end();
