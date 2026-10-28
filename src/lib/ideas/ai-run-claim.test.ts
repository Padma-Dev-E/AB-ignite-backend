import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("claiming a retry clears the previous attempt error from current run state", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "ai-run-claim-")), "ideas.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db } = await import("../../db/connection");
  const { aiRuns, ideas, ideaVersions, users } = await import("../../db/schema");
  const { claimNextAiRun } = await import("./repository");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const [user] = db.insert(users).values({ name: "AI run test", email: "ai-run-test@example.test", passwordHash: "test-only", role: "employee" }).returning().all();
  const [idea] = db.insert(ideas).values({ authorId: user.id, title: "Retry state", summary: "An isolated idea used to verify retry state transitions.", category: "Operations", status: "draft", reference: "AI-CLAIM-TEST" }).returning().all();
  const [version] = db.insert(ideaVersions).values({ ideaId: idea.id, authorId: user.id, version: 1, kind: "idea", title: idea.title, summary: idea.summary, category: idea.category, contentHash: "retry-test-hash" }).returning().all();
  db.insert(aiRuns).values({ ideaId: idea.id, ideaVersionId: version.id, jobKey: "idea.preflight", jobVersion: "1", promptVersion: "1", model: "test", status: "queued", idempotencyKey: "ai-run-claim-test", correlationId: "ai-run-claim-test", inputHash: "retry-test-hash", errorCode: "timeout", errorMessage: "AI worker lease expired; retry scheduled" }).run();

  const claimed = await claimNextAiRun("retry-worker");
  assert.equal(claimed?.status, "running");
  assert.equal(claimed?.errorCode, null);
  assert.equal(claimed?.errorMessage, null);
});
