import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertWipeAuthorized, wipeDatabase } from "./wipe-core.js";

test("wiping clears application rows, resets sequences, and retains migration history", () => {
  const directory = mkdtempSync(join(tmpdir(), "ab-ignite-wipe-"));
  const databasePath = join(directory, "wipe.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL);
    CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
    CREATE TABLE child (id INTEGER PRIMARY KEY AUTOINCREMENT, parent_id INTEGER NOT NULL REFERENCES parent(id));
    CREATE TRIGGER parent_append_only BEFORE DELETE ON parent BEGIN SELECT RAISE(ABORT, 'parent is append-only'); END;
    INSERT INTO __drizzle_migrations (hash) VALUES ('migration-hash');
    INSERT INTO parent (label) VALUES ('private data');
    INSERT INTO child (parent_id) VALUES (1);
  `);
  sqlite.close();

  const result = wipeDatabase(databasePath);
  const verify = new Database(databasePath);
  assert.equal(result.clearedTables, 2);
  assert.equal(verify.prepare("SELECT count(*) AS count FROM parent").get().count, 0);
  assert.equal(verify.prepare("SELECT count(*) AS count FROM child").get().count, 0);
  assert.equal(verify.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get().count, 1);
  assert.equal(verify.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name = 'parent_append_only'").get().count, 1);
  assert.deepEqual(verify.pragma("foreign_key_check"), []);
  assert.equal(verify.prepare("SELECT count(*) AS count FROM sqlite_sequence").get().count, 0);
  verify.close();
});

test("wipe authorization requires confirmation and explicit production acknowledgement", () => {
  assert.throws(() => assertWipeAuthorized([], "development"), /--confirm/);
  assert.throws(() => assertWipeAuthorized(["--confirm"], "production"), /--allow-production/);
  assert.doesNotThrow(() => assertWipeAuthorized(["--confirm", "--allow-production"], "production"));
});

test("refuses a database without a Drizzle migration ledger", () => {
  const directory = mkdtempSync(join(tmpdir(), "ab-ignite-wipe-unmanaged-"));
  const databasePath = join(directory, "unmanaged.sqlite");
  const sqlite = new Database(databasePath);
  sqlite.exec("CREATE TABLE user_data (id INTEGER PRIMARY KEY, value TEXT)");
  sqlite.close();
  assert.throws(() => wipeDatabase(databasePath), /Drizzle migration ledger/);
  const verify = new Database(databasePath);
  assert.equal(verify.prepare("SELECT count(*) AS count FROM user_data").get().count, 0);
  verify.close();
});
