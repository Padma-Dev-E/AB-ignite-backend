import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("self-support is a conflict instead of an unexpected server error", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "idea-support-")), "ideas.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db } = await import("../../db/connection");
  const { ideas, users } = await import("../../db/schema");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const [author] = db.insert(users).values({ name: "Idea author", email: "idea-author@example.test", passwordHash: "test-only" }).returning().all();
  const [idea] = db.insert(ideas).values({ authorId: author.id, title: "Support test", summary: "Test support rules", category: "Operations", status: "screening", reference: "ABI-TEST-00001" }).returning().all();
  const { IdeaSupportConflictError, supportIdea } = await import("./repository.js");

  await assert.rejects(
    supportIdea({ kind: "user", id: String(author.id) }, idea.id),
    (error: unknown) => error instanceof IdeaSupportConflictError && error.message === "You cannot support your own idea",
  );
});
