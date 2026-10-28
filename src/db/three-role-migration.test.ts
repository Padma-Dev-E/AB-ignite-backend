import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Database from "better-sqlite3";

test("three-role migration maps legacy accounts, drops profiles and revokes old sessions", async () => {
  const migration = await readFile(new URL("../../drizzle/0019_three_account_roles.sql", import.meta.url), "utf8");
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user', profile TEXT NOT NULL DEFAULT 'employee',
        department TEXT NOT NULL DEFAULT 'Other', jobTitle TEXT, passwordHash TEXT NOT NULL,
        mustChangePassword INTEGER NOT NULL DEFAULT 0, isActive INTEGER NOT NULL DEFAULT 1,
        failedLoginAttempts INTEGER NOT NULL DEFAULT 0, lockedUntil INTEGER, lastFailedLoginAt INTEGER,
        lastLoginAt INTEGER, lastSeenAt INTEGER, sessionVersion INTEGER NOT NULL DEFAULT 0,
        deactivatedAt INTEGER, points INTEGER NOT NULL DEFAULT 0, rank INTEGER,
        createdAt INTEGER NOT NULL DEFAULT 1, updatedAt INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE refresh_tokens (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, sessionVersion INTEGER NOT NULL DEFAULT 0, revokedAt INTEGER, revocationReason TEXT);
      CREATE TABLE idea_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO users (id,name,email,role,profile,passwordHash) VALUES
        (1,'admin','1@example.test','admin','admin','hash'), (2,'employee','2@example.test','user','employee','hash'),
        (3,'reviewer','3@example.test','user','reviewer','hash'), (4,'owner','4@example.test','user','business_owner','hash'),
        (5,'control','5@example.test','user','control','hash'), (6,'management','6@example.test','user','management','hash');
      INSERT INTO refresh_tokens (id,userId) VALUES (1,1),(2,2),(3,3),(4,4),(5,5),(6,6);
      INSERT INTO idea_settings (key,value) VALUES ('profiles','["employee","reviewer","control","business_owner"]');
    `);
    sqlite.exec(migration);
    assert.deepEqual(sqlite.prepare("SELECT id, role FROM users ORDER BY id").all(), [
      { id: 1, role: "back_office" }, { id: 2, role: "employee" },
      { id: 3, role: "back_office" }, { id: 4, role: "business_owner" },
      { id: 5, role: "back_office" }, { id: 6, role: "back_office" },
    ]);
    assert.equal(sqlite.prepare("PRAGMA table_info(users)").all().some((column) => (column as { name: string }).name === "profile"), false);
    assert.equal((sqlite.prepare("SELECT count(*) AS count FROM users").get() as { count: number } | undefined)?.count, 6);
    assert.equal((sqlite.prepare("SELECT count(*) AS count FROM refresh_tokens WHERE revokedAt IS NOT NULL AND revocationReason='role_model_changed'").get() as { count: number } | undefined)?.count, 6);
    assert.equal((sqlite.prepare("SELECT value FROM idea_settings WHERE key='roles'").get() as { value: string } | undefined)?.value, '["back_office","business_owner","employee"]');
  } finally {
    sqlite.close();
  }
});

test("maintainer migration preserves ideas and assignments while mapping back-office accounts to admin", async () => {
  const migration = await readFile(new URL("../../drizzle/0027_maintainer_owner_match.sql", import.meta.url), "utf8");
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, role TEXT NOT NULL, sessionVersion INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE refresh_tokens (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, revokedAt INTEGER, revocationReason TEXT);
      CREATE TABLE ideas (id INTEGER PRIMARY KEY, status TEXT NOT NULL, assignedUserId INTEGER);
      CREATE TABLE idea_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO users (id,role) VALUES (1,'back_office'),(2,'employee'),(3,'business_owner');
      INSERT INTO refresh_tokens (id,userId) VALUES (11,1),(12,2),(13,3);
      INSERT INTO ideas (id,status,assignedUserId) VALUES (21,'screening',NULL),(22,'business_review',3);
      INSERT INTO idea_settings (key,value) VALUES ('roles','["back_office","business_owner","employee"]');
    `);
    sqlite.exec(migration);
    assert.deepEqual(sqlite.prepare("SELECT id, role, sessionVersion FROM users ORDER BY id").all(), [
      { id: 1, role: "admin", sessionVersion: 1 },
      { id: 2, role: "employee", sessionVersion: 0 },
      { id: 3, role: "business_owner", sessionVersion: 0 },
    ]);
    assert.deepEqual(sqlite.prepare("SELECT id, status, assignedUserId FROM ideas ORDER BY id").all(), [
      { id: 21, status: "screening", assignedUserId: null },
      { id: 22, status: "business_review", assignedUserId: 3 },
    ]);
    assert.equal(sqlite.prepare("SELECT revokedAt IS NOT NULL AS revoked, revocationReason FROM refresh_tokens WHERE id=11").get()?.revoked, 1);
    assert.equal(sqlite.prepare("SELECT revokedAt FROM refresh_tokens WHERE id=12").get()?.revokedAt, null);
    assert.deepEqual(sqlite.prepare("PRAGMA table_info(users)").all().some((column) => (column as { name: string }).name === "businessProfile"), true);
    assert.equal(sqlite.prepare("SELECT value FROM idea_settings WHERE key='roles'").get()?.value, '["admin","business_owner","employee","maintainer"]');
  } finally {
    sqlite.close();
  }
});
