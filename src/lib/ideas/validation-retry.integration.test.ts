import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("two below-threshold scores on the current version enable audited human-review submission", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "idea-validation-retry-")), "ideas.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../db/connection");
  const { aiRuns, auditEvents, ideaEvents, ideaSubmissions, ideaVersions, ideas, users } = await import("../../db/schema");
  const { submitIdea } = await import("./repository");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const [owner] = db.insert(users).values({ name: "Validation Retry", email: "validation-retry@example.test", passwordHash: "test-only", role: "employee" }).returning().all();
  const [idea] = db.insert(ideas).values({ authorId: owner.id, title: "Validation retry", summary: "An isolated validation retry idea.", category: "Operations", status: "draft", reference: "TEMP-VALIDATION-RETRY" }).returning().all();
  const [version] = db.insert(ideaVersions).values({ ideaId: idea.id, authorId: owner.id, version: 1, kind: "idea", title: idea.title, summary: idea.summary, category: idea.category, contentHash: "validation-retry-hash" }).returning().all();
  db.insert(ideaSubmissions).values({
    ideaId: idea.id,
    answersJson: JSON.stringify({ beneficiaries: "Customers", currentProcess: "Manual", needed: "Automation", risks: "Errors", successMeasure: "Time saved" }),
    metricsJson: JSON.stringify({ turnaround: 3, volume: 3, value: 3 }),
    score: 3,
    minimumScore: 2,
  }).run();
  db.insert(aiRuns).values({ ideaId: idea.id, ideaVersionId: version.id, jobKey: "idea.validate", jobVersion: "1", promptVersion: "1", model: "test", status: "succeeded", idempotencyKey: "validation-retry-first", correlationId: "validation-retry-first", inputHash: version.contentHash, resultJson: JSON.stringify({ decision: "needs_human_review", overallScore: 7 }) }).run();
  await assert.rejects(submitIdea({ kind: "user", id: String(owner.id) }, idea.id, { submitForHumanReview: true }), /validation must pass/i);

  db.insert(aiRuns).values([
    { ideaId: idea.id, ideaVersionId: version.id, jobKey: "idea.validate", jobVersion: "1", promptVersion: "1", model: "test", status: "succeeded", idempotencyKey: "validation-retry-second", correlationId: "validation-retry-second", inputHash: version.contentHash, resultJson: JSON.stringify({ decision: "needs_human_review", overallScore: 6.5 }) },
    { ideaId: idea.id, ideaVersionId: version.id, jobKey: "idea.preflight", jobVersion: "1", promptVersion: "1", model: "test", status: "succeeded", idempotencyKey: "validation-retry-preflight", correlationId: "validation-retry-preflight", inputHash: version.contentHash, resultJson: JSON.stringify({ decision: "allow", safeToProcess: true }) },
  ]).run();

  const actor = { kind: "user" as const, id: String(owner.id) };
  await assert.rejects(submitIdea(actor, idea.id), /choose submit for human review/i);

  const result = await submitIdea(actor, idea.id, { submitForHumanReview: true });
  assert.equal(result.submitted, true);
  assert.equal(result.aiValidationScore, 6.5);
  assert.equal(result.aiValidationAttempts, 2);
  assert.equal(result.submittedWithLowAiScore, true);
  assert.equal(result.idea.status, "screening");

  const submission = db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, idea.id)).get();
  assert.equal(submission?.aiValidationScore, 6.5);
  assert.equal(submission?.aiValidationAttempts, 2);
  assert.equal(submission?.validationPassed, false);
  assert.equal(submission?.submittedWithLowAiScore, true);
  assert.ok(submission?.submittedAt);

  const event = db.select().from(ideaEvents).where(eq(ideaEvents.ideaId, idea.id)).all().find((row) => row.eventType === "submitted");
  assert.equal(event?.ideaVersionId, version.id);
  assert.equal(event?.toStatus, "screening");
  assert.deepEqual(JSON.parse(event?.metadataJson ?? "{}"), {
    score: 3,
    band: "Priority",
    minimum: 2,
    breakdown: [
      { key: "turnaround", question: "How much turnaround time improves?", hint: "Estimate the time saved.", score: 3, weight: 0.3, contribution: 0.9 },
      { key: "volume", question: "How many cases or customers are affected?", hint: "Estimate the volume affected.", score: 3, weight: 0.3, contribution: 0.9 },
      { key: "value", question: "What savings or revenue are expected?", hint: "Estimate the financial impact.", score: 3, weight: 0.4, contribution: 1.2 },
    ],
    aiValidationScore: 6.5,
    aiValidationAttempts: 2,
    submittedWithLowAiScore: true,
    validationVersionId: version.id,
    failedValidationResults: 2,
  });

  const audit = db.select().from(auditEvents).where(eq(auditEvents.targetId, String(idea.id))).all().find((row) => row.action === "ideas.submitted");
  assert.deepEqual(JSON.parse(audit?.metadataJson ?? "{}"), {
    status: "submitted",
    result: 3,
    aiValidationScore: 6.5,
    aiValidationAttempts: 2,
    submittedWithLowAiScore: true,
    validationVersionId: version.id,
    failedValidationResults: 2,
  });
});
