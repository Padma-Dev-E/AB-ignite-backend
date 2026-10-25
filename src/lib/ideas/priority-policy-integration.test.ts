import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("saved AD-07 policy controls submission score, band, gate, audit and idempotent response", async () => {
  // Every run gets its own migrated database. No existing application data is touched.
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "idea-backend-")), "ideas.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../db/connection");
  const { aiRuns, ideaEvents, ideaSettings, ideaSubmissions, ideaVersions, ideas, pointsLedger, users } = await import("../../db/schema");
  const { defaultPriorityPolicy } = await import("./priority-policy");
  const { getIdeaVersionPreflight, IdeaPriorityMinimumError, saveIdeaSubmission, submitIdea } = await import("./repository");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const [owner] = db.insert(users).values({ name: "Priority Test", email: "priority-test@example.test", passwordHash: "test-only", role: "employee" }).returning().all();
  const [idea] = db.insert(ideas).values({ authorId: owner.id, title: "Policy integration", summary: "An isolated idea for priority policy integration.", category: "Operations", status: "draft", reference: "TEMP-PRIORITY-1" }).returning().all();
  const [version] = db.insert(ideaVersions).values({ ideaId: idea.id, authorId: owner.id, version: 1, kind: "idea", title: idea.title, summary: idea.summary, category: idea.category, contentHash: "test-hash" }).returning().all();
  const firstKpis = defaultPriorityPolicy.kpis.map((item) => ({ ...item, weight: item.key === "turnaround" ? 0.6 : 0.2, question: `${item.key} configured question`, hint: `${item.key} configured hint` }));
  const firstBands = [{ name: "Watch", minimum: 0 }, { name: "Quality", minimum: 1 }, { name: "Priority", minimum: 2 }];
  db.insert(ideaSettings).values([
    { key: "priority_kpis", value: JSON.stringify(firstKpis) },
    { key: "priority_bands", value: JSON.stringify(firstBands) },
    { key: "minimum_priority_score", value: "2.2" },
  ]).run();

  const actor = { kind: "user" as const, id: String(owner.id) };
  const saved = await saveIdeaSubmission(actor, idea.id, {
    answers: { beneficiaries: "Customers", currentProcess: "Manual", needed: "Automation", risks: "Errors", successMeasure: "Time saved" },
    metrics: { turnaround: 3, volume: 2, value: 1, turnaroundExplanation: "Three units" },
  });
  assert.equal(saved.score, 2.4);

  for (const [jobKey, resultJson] of [["idea.validate", '{"decision":"accept","overallScore":7}'], ["idea.preflight", '{"decision":"allow","safeToProcess":true}']] as const) {
    db.insert(aiRuns).values({ ideaId: idea.id, ideaVersionId: version.id, jobKey, jobVersion: "1", promptVersion: "1", model: "test", status: "succeeded", idempotencyKey: `priority:${jobKey}`, correlationId: `priority:${jobKey}`, inputHash: "test", resultJson }).run();
  }
  const passedPreflight = await getIdeaVersionPreflight(idea.id, version.id);
  assert.equal(passedPreflight?.status, "succeeded");

  await assert.rejects(submitIdea(actor, idea.id), /validation must pass/i);
  db.update(aiRuns).set({ resultJson: '{"decision":"needs_human_review","overallScore":70}' }).where(eq(aiRuns.jobKey, "idea.validate")).run();
  await assert.rejects(submitIdea(actor, idea.id), /validation must pass/i);
  db.update(aiRuns).set({ resultJson: '{"decision":"needs_human_review","overallScore":71}' }).where(eq(aiRuns.jobKey, "idea.validate")).run();
  db.update(aiRuns).set({ resultJson: '{"decision":"block","safeToProcess":false}' }).where(eq(aiRuns.jobKey, "idea.preflight")).run();
  await assert.rejects(submitIdea(actor, idea.id), /Idea must pass validation/i);
  db.update(aiRuns).set({ resultJson: '{"decision":"allow","safeToProcess":true}' }).where(eq(aiRuns.jobKey, "idea.preflight")).run();

  const finalKpis = defaultPriorityPolicy.kpis.map((item) => ({ ...item, weight: item.key === "value" ? 0.6 : 0.2, question: `${item.key} final question`, hint: `${item.key} final hint` }));
  db.update(ideaSettings).set({ value: JSON.stringify(finalKpis) }).where(eq(ideaSettings.key, "priority_kpis")).run();
  db.update(ideaSettings).set({ value: JSON.stringify([{ name: "Watch", minimum: 0 }, { name: "Quality", minimum: 1 }, { name: "Priority", minimum: 1.5 }]) }).where(eq(ideaSettings.key, "priority_bands")).run();
  await assert.rejects(submitIdea(actor, idea.id), (error: unknown) => {
    assert.ok(error instanceof IdeaPriorityMinimumError);
    assert.equal(error.code, "submission_rejected");
    assert.equal(error.score, 1.6);
    assert.equal(error.minimumScore, 2.2);
    assert.equal(error.priorityBand, "Priority");
    assert.deepEqual(error.breakdown, [
      { key: "turnaround", question: "turnaround final question", hint: "turnaround final hint", score: 3, weight: 0.2, contribution: 0.6 },
      { key: "volume", question: "volume final question", hint: "volume final hint", score: 2, weight: 0.2, contribution: 0.4 },
      { key: "value", question: "value final question", hint: "value final hint", score: 1, weight: 0.6, contribution: 0.6 },
    ]);
    return true;
  });
  assert.equal(db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, idea.id)).get()?.submittedAt, null);

  db.update(ideaSettings).set({ value: "1" }).where(eq(ideaSettings.key, "minimum_priority_score")).run();
  const submitted = await submitIdea(actor, idea.id);
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.pointsAwarded, 50);
  assert.equal(submitted.score, 1.6);
  assert.equal(submitted.priorityBand, "Priority");
  assert.deepEqual(submitted.breakdown.map((item) => item.weight), [0.2, 0.2, 0.6]);
  assert.equal(submitted.breakdown[0].question, "turnaround final question");
  assert.match(submitted.reference, /^ABI-\d{4}-\d{5}$/);
  assert.equal(db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, idea.id)).get()?.score, 1.6);
  const submittedEvent = db.select().from(ideaEvents).where(eq(ideaEvents.ideaId, idea.id)).all().find((event) => event.eventType === "submitted");
  assert.deepEqual(JSON.parse(submittedEvent?.metadataJson ?? "{}").breakdown.map((item: { weight: number }) => item.weight), [0.2, 0.2, 0.6]);

  db.update(ideaSettings).set({ value: JSON.stringify(firstKpis) }).where(eq(ideaSettings.key, "priority_kpis")).run();
  const repeated = await submitIdea(actor, idea.id);
  assert.equal(repeated.submitted, true);
  assert.equal(repeated.pointsAwarded, 50);
  assert.equal(repeated.score, 1.6);
  assert.equal(repeated.priorityBand, "Priority");
  assert.deepEqual(repeated.breakdown, submitted.breakdown);
  assert.equal(db.select().from(ideaEvents).where(eq(ideaEvents.ideaId, idea.id)).all().filter((event) => event.eventType === "submitted").length, 1);
  const submissionPoints = db.select().from(pointsLedger).where(eq(pointsLedger.idempotencyKey, `idea:${idea.id}:submission:points`)).all();
  assert.equal(submissionPoints.length, 1);
  assert.equal(submissionPoints[0].amount, 50);

  const [editedVersion] = db.insert(ideaVersions).values({ ideaId: idea.id, authorId: owner.id, version: 2, kind: "idea", title: idea.title, summary: `${idea.summary} Updated after validation.`, category: idea.category, contentHash: "edited-test-hash" }).returning().all();
  assert.equal(await getIdeaVersionPreflight(idea.id, editedVersion.id), null);
  assert.equal((await getIdeaVersionPreflight(idea.id, version.id))?.id, passedPreflight?.id);
  db.insert(aiRuns).values({ ideaId: idea.id, ideaVersionId: editedVersion.id, jobKey: "idea.validate", jobVersion: "1", promptVersion: "1", model: "test", status: "succeeded", idempotencyKey: `edited-version-validation:${idea.id}`, correlationId: `edited-version-validation:${idea.id}`, inputHash: "edited-test-hash", resultJson: '{"decision":"accept","overallScore":8}' }).run();
  db.update(ideaSubmissions).set({ submittedAt: null }).where(eq(ideaSubmissions.ideaId, idea.id)).run();
  db.update(ideas).set({ status: "draft" }).where(eq(ideas.id, idea.id)).run();
  await assert.rejects(submitIdea(actor, idea.id), /must pass validation before it can be submitted/i);
  const { runIdeaScreeningWorkflow } = await import("./workflow");
  await runIdeaScreeningWorkflow(idea.id, editedVersion.id, actor, `edited-version-preflight:${idea.id}:${editedVersion.id}`);
  const refreshedPreflight = await getIdeaVersionPreflight(idea.id, editedVersion.id);
  assert.equal(refreshedPreflight?.status, "queued");
});
