import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const MIGRATION_TABLE = "__drizzle_migrations";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function assertWipeAuthorized(args: string[], nodeEnv = process.env.NODE_ENV): void {
  const unknown = args.filter((arg) => !["--confirm", "--allow-production"].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown db:wipe option: ${unknown.join(", ")}`);
  if (!args.includes("--confirm")) throw new Error("Database wipe cancelled. Pass --confirm to delete application data.");
  if (nodeEnv === "production" && !args.includes("--allow-production")) {
    throw new Error("Production-mode wipe requires both --confirm and --allow-production.");
  }
}

export function resolveDatabasePath(databaseUrl: string, cwd = process.cwd()): string {
  const value = databaseUrl.trim();
  if (!value || value === ":memory:") throw new Error("db:wipe requires a file-backed DATABASE_URL.");
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !value.startsWith("file://")) {
    throw new Error("db:wipe supports only file-backed SQLite DATABASE_URL values.");
  }
  return resolve(cwd, value.replace(/^file:/, ""));
}

export function wipeDatabase(databasePath: string): { clearedTables: number } {
  const path = resolve(databasePath);
  if (!existsSync(path)) throw new Error(`Database file does not exist: ${path}`);

  const sqlite = new Database(path);
  sqlite.pragma("busy_timeout = 5000");
  try {
    const migrationLedger = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(MIGRATION_TABLE);
    if (!migrationLedger) throw new Error(`Refusing to wipe an unmanaged database without the ${MIGRATION_TABLE} Drizzle migration ledger.`);

    const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> ? ORDER BY name").all(MIGRATION_TABLE) as Array<{ name: string }>;
    const guardedDeleteTriggers = (sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>)
      .filter(({ sql }) => /\b(?:BEFORE|AFTER|INSTEAD\s+OF)\s+DELETE\b/i.test(sql) && /\bRAISE\s*\(\s*ABORT\b/i.test(sql));
    sqlite.pragma("foreign_keys = OFF");
    const clearRows = sqlite.transaction(() => {
      for (const { name } of guardedDeleteTriggers) sqlite.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
      for (const { name } of tables) sqlite.exec(`DELETE FROM ${quoteIdentifier(name)}`);
      const hasSequence = sqlite.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").get();
      if (hasSequence) sqlite.exec("DELETE FROM sqlite_sequence");
      for (const { sql } of guardedDeleteTriggers) sqlite.exec(sql);
      const violations = sqlite.pragma("foreign_key_check") as unknown[];
      if (violations.length) throw new Error(`Wipe left ${violations.length} foreign-key violation(s); transaction rolled back.`);
    });
    clearRows.immediate();
    return { clearedTables: tables.length };
  } finally {
    sqlite.pragma("foreign_keys = ON");
    sqlite.close();
  }
}
