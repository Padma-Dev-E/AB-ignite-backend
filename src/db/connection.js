import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema";
const databaseUrl = process.env.DATABASE_URL ?? "./data/ab-ignite.db";
const databasePath = resolve(process.cwd(), databaseUrl.replace(/^file:/, ""));
mkdirSync(dirname(databasePath), { recursive: true });
const globalForDb = globalThis;
const sqlite = globalForDb.sqlite ?? new Database(databasePath);
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");
export const db = globalForDb.db ?? drizzle(sqlite, { schema });
if (process.env.NODE_ENV !== "production") {
    globalForDb.sqlite = sqlite;
    globalForDb.db = db;
}
export { schema };
