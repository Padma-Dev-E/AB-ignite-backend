import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("edited returned idea resubmits to screening with a new audit event and no duplicate points", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "idea-returned-resubmit-")), "ideas.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { and, eq } = await import("drizzle-orm");
  const { db } = await import("../../db/connection");
  const { aiRuns, auditEvents, ideaEvents, ideaSubmissions, ideaVersions, ideas, pointsLedger, users } = await import("../../db/schema");
  const { submitIdea } = await import("./repository.js");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const [owner] = db.insert(users).values({ name: "Returned Idea Owner", email: "returned-resubmit@example.test", passwordHash: "test-only", role: "employee" }).returning().all();
  const [idea] = db.insert(ideas).values({ authorId: owner.id, title: "Returned improvement", summary: "A returned idea updated by its author.", category: "Operations", status: "returned", reference: "ABI-2026-00042" }).returning().all();
  const [originalVersion] = db.insert(ideaVersions).values({ ideaId: idea.id, authorId: owner.id, version: 1, kind: "idea", title: idea.title, summary: idea.summary, category: idea.category, contentHash: "original-hash" }).returning().all();
  const [editedVersion] = db.insert(ideaVersions).values({ ideaId: idea.id, authorId: owner.id, version: 2, kind: "idea", title: idea.title, summary: "A materially improved version of the returned idea.", category: idea.category, contentHash: "edited-hash" }).returning().all();
  const submittedAt = new Date(Date.now() - 60_000);
  db.insert(ideaSubmissions).values({
    ideaId: idea.id,
    answersJson: JSON.stringify({ beneficiaries: "Customers", currentProcess: "Manual", needed: "A safer digital process", risks: "Operational errors", successMeasure: "Reduced processing time" }),
    metricsJson: JSON.stringify({ turnaround: 3, volume: 3, value: 3 }),
    score: 3,
    minimumScore: 2,
    submittedAt,
  }).run();
  db.insert(ideaEvents).values([
    { ideaId: idea.id, ideaVersionId: originalVersion.id, actorType: "user", actorId: String(owner.id), eventType: "submitted", toStatus: "screening", metadataJson: JSON.stringify({ score: 3 }) },
    { ideaId: idea.id, ideaVersionId: editedVersion.id, actorType: "user", actorId: String(owner.id), eventType: "returned_edited", metadataJson: "{}" },
  ]).run();
  db.insert(aiRuns).values({
    ideaId: idea.id,
    ideaVersionId: editedVersion.id,
    jobKey: "idea.preflight",
    jobVersion: "1",
    promptVersion: "1",
    model: "test",
    status: "succeeded",
    idempotencyKey: `returned-resubmit-preflight:${idea.id}`,
    correlationId: `returned-resubmit-preflight:${idea.id}`,
    inputHash: editedVersion.contentHash,
    resultJson: JSON.stringify({ decision: "allow", safeToProcess: true }),
  }).run();

  const actor = { kind: "user" as const, id: String(owner.id) };
  const result = await submitIdea(actor, idea.id);
  assert.equal(result.submitted, true);
  assert.equal(result.idea.status, "screening");
  assert.equal(result.reference, "ABI-2026-00042");
  assert.equal(result.aiValidationScore, null);
  const refreshed = db.select().from(ideas).where(eq(ideas.id, idea.id)).get();
  assert.equal(refreshed?.status, "screening");
  const submission = db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, idea.id)).get();
  assert.ok(submission?.submittedAt && submission.submittedAt > submittedAt);
  assert.equal(submission?.aiValidationScore, null);
  const events = db.select().from(ideaEvents).where(and(eq(ideaEvents.ideaId, idea.id), eq(ideaEvents.eventType, "submitted"))).all();
  assert.equal(events.length, 2);
  assert.equal(events.at(-1)?.fromStatus, "returned");
  assert.equal(events.at(-1)?.toStatus, "screening");
  assert.equal(db.select().from(auditEvents).where(eq(auditEvents.targetId, String(idea.id))).all().filter((event) => event.action === "ideas.resubmitted").length, 1);
  assert.equal(db.select().from(pointsLedger).where(eq(pointsLedger.idempotencyKey, `idea:${idea.id}:submission:points`)).all().length, 1);

  const repeated = await submitIdea(actor, idea.id);
  assert.equal(repeated.submitted, true);
  assert.equal(db.select().from(ideaEvents).where(and(eq(ideaEvents.ideaId, idea.id), eq(ideaEvents.eventType, "submitted"))).all().length, 2);
});
