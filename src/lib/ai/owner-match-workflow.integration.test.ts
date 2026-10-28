import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("queued owner matching assigns only a valid active candidate and records the match", async () => {
  const context = await setup("valid-match");
  const run = await context.queue();
  assert.equal(run.status, "queued");

  const { processNextAiRun } = await import("./worker");
  const outcome = await processNextAiRun("owner-match-test", {
    provider: { generateStructured: async () => ({ text: JSON.stringify({ candidateOwnerId: context.owner.id, confidence: 0.91, rationale: "The profile explicitly covers payment operations." }) }) },
  });

  const idea = context.db.select().from(context.tables.ideas).where(context.eq(context.tables.ideas.id, context.idea.id)).get();
  assert.equal(outcome.status, "succeeded");
  assert.equal(idea?.status, "business_review");
  assert.equal(idea?.assignedUserId, context.owner.id);
  assert.equal(context.db.select().from(context.tables.ideaEvents).all().some((event) => event.ideaId === idea?.id && event.eventType === "business_owner_assigned" && event.metadataJson?.includes('"source":"ai"')), true);
  assert.equal(context.db.select().from(context.tables.notifications).all().some((item) => item.userId === context.owner.id && item.type === "idea_routed"), true);
  const { getEvaluation } = await import("../admin/governance/service");
  const detail = await getEvaluation(context.idea.id, { userId: context.owner.id, sessionId: context.ownerSession.id });
  assert.equal(detail.ownerMatch?.source, "ai");
  assert.equal(detail.ownerMatch?.confidence, 0.91);
});

test("low-confidence and out-of-candidate AI results fall back to maintainer assignment", async () => {
  const context = await setup("low-confidence");
  await context.queue();
  const { processNextAiRun } = await import("./worker");
  const outcome = await processNextAiRun("owner-match-test", {
    provider: { generateStructured: async () => ({ text: JSON.stringify({ candidateOwnerId: context.owner.id + 1000, confidence: 0.99, rationale: "Unsupported candidate." }) }) },
  });
  const idea = context.db.select().from(context.tables.ideas).where(context.eq(context.tables.ideas.id, context.idea.id)).get();
  assert.equal(outcome.status, "succeeded");
  assert.equal(idea?.status, "owner_assignment");
  assert.equal(idea?.assignedUserId, null);
});

test("owner matching with no profiled candidate does not stay queued or running", async () => {
  const context = await setup("no-candidate");
  context.db.update(context.tables.users).set({ businessProfile: null }).where(context.eq(context.tables.users.id, context.owner.id)).run();
  const result = await context.queue();
  const idea = context.db.select().from(context.tables.ideas).where(context.eq(context.tables.ideas.id, context.idea.id)).get();
  assert.equal(result.status, "manual_assignment_required");
  assert.equal(idea?.status, "owner_assignment");
  assert.equal(context.db.select().from(context.tables.aiRuns).all().filter((run) => run.ideaId === idea?.id && run.jobKey === "idea.owner_match").length, 0);
});

test("exhausted stale owner-match leases move the idea to manual assignment", async () => {
  const context = await setup("stale-owner-match");
  const queued = await context.queue();
  const { claimAiRun, recoverStaleAiRuns } = await import("../ideas/repository");
  assert.ok(queued.runId);
  const running = await claimAiRun(queued.runId!, "stale-owner-match-worker", new Date(Date.now() - 60_000));
  assert.ok(running);
  const recovered = await recoverStaleAiRuns(new Date(), 30_000, 1);
  const idea = context.db.select().from(context.tables.ideas).where(context.eq(context.tables.ideas.id, context.idea.id)).get();
  assert.equal(recovered, 1);
  assert.equal(idea?.status, "owner_assignment");
  assert.equal(context.db.select().from(context.tables.aiRuns).where(context.eq(context.tables.aiRuns.id, queued.runId!)).get()?.status, "timed_out");
});

async function setup(label: string) {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), `owner-match-${label}-`)), "workflow.sqlite");
  process.env.NODE_ENV = "test";
  process.env.AI_OWNER_MATCH_MIN_CONFIDENCE = "0.7";

  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db } = await import("../../db/connection");
  const tables = await import("../../db/schema");
  const { eq } = await import("drizzle-orm");
  const { ensureAiPromptCatalogue } = await import("./prompts/catalog");
  const { queueOwnerMatchForIdea } = await import("./owner-match-workflow");
  migrate(db, { migrationsFolder: resolve("drizzle") });
  ensureAiPromptCatalogue();
  db.update(tables.users).set({ isActive: false }).where(eq(tables.users.role, "business_owner")).run();

  const suffix = `${label}-${Date.now()}-${Math.random()}`;
  const [author] = db.insert(tables.users).values({ name: "Owner match author", email: `${suffix}-author@example.test`, role: "employee", passwordHash: "test-only" }).returning().all();
  const [owner] = db.insert(tables.users).values({ name: "Payments owner", email: `${suffix}-owner@example.test`, role: "business_owner", department: "Operations", businessProfile: "Owns payment operations and fee servicing workflow improvements.", passwordHash: "test-only" }).returning().all();
  const [ownerSession] = db.insert(tables.refreshTokens).values({ userId: owner.id, tokenHash: `${suffix}-owner-session`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: owner.sessionVersion }).returning().all();
  const [idea] = db.insert(tables.ideas).values({ authorId: author.id, title: "Reduce repeat fee review", summary: "Help operations review fee requests consistently.", problem: "Staff compare multiple sources manually.", solution: "Provide a guided review path.", category: "Operations", status: "owner_matching", reference: `ABI-OWNER-MATCH-${suffix}` }).returning().all();
  const [version] = db.insert(tables.ideaVersions).values({ ideaId: idea.id, authorId: author.id, version: 1, kind: "idea", title: idea.title, summary: idea.summary, problem: idea.problem, solution: idea.solution, benefits: idea.benefits, risks: idea.risks, category: idea.category, dataClassification: "internal", contentHash: suffix }).returning().all();

  return {
    db, tables, eq, owner, ownerSession, idea, version,
    queue: () => queueOwnerMatchForIdea(idea.id, author.id, `owner-match-${suffix}`),
  };
}
