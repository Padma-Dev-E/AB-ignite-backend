import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("APIGEE response flows through extraction, schema validation, persistence, and terminal failure", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "apigee-worker-flow-")), "flow.sqlite");
  process.env.APIGEE_URL = "https://apigee.example.test/generate";
  process.env.APIGEE_CLIENT_ID = "integration-test-client";
  process.env.AI_DEBUG_PAYLOADS = "false";
  process.env.NODE_ENV = "test";

  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db } = await import("../../db/connection");
  const { aiRuns, aiRunEvents, ideaAiResults, ideaEvents, ideaVersions, ideas, users } = await import("../../db/schema");
  const { eq } = await import("drizzle-orm");
  const { ensureAiPromptCatalogue, getActiveAiPromptVersion } = await import("./prompts/catalog");
  const { createApigeeProvider } = await import("./apigee-provider-core");
  const { processNextAiRun } = await import("./worker");
  const { createAiRun } = await import("../ideas/repository");
  migrate(db, { migrationsFolder: resolve("drizzle") });
  ensureAiPromptCatalogue();

  const [author] = db.insert(users).values({ name: "AI flow test", email: "ai-flow-test@example.test", passwordHash: "test-only", role: "employee" }).returning().all();
  const [idea] = db.insert(ideas).values({
    authorId: author.id,
    title: "Reduce manual fee reversals",
    summary: "Give operations a controlled workflow to review eligible fee reversals.",
    problem: "Staff compare transaction details across separate tools.",
    solution: "Provide a guided review with eligibility checks and an audit record.",
    benefits: "Reduce manual handling time.",
    risks: "Incorrect eligibility rules could reverse an ineligible fee.",
    category: "Operations",
    status: "draft",
    reference: "AI-FLOW-TEST-001",
  }).returning().all();
  const [version] = db.insert(ideaVersions).values({
    ideaId: idea.id,
    authorId: author.id,
    version: 1,
    kind: "idea",
    title: idea.title,
    summary: idea.summary,
    problem: idea.problem,
    solution: idea.solution,
    benefits: idea.benefits,
    risks: idea.risks,
    category: idea.category,
    dataClassification: "internal",
    contentHash: "apigee-worker-flow-test",
  }).returning().all();

  const output = {
    suggestedTitle: "Controlled Fee Reversal Review",
    conciseSummary: "A guided workflow helps operations review eligible fee reversals.",
    problemStatement: "Staff compare transaction details across separate tools.",
    solutionStatement: "Provide a guided review with eligibility checks and an audit record.",
    valueStatement: "Reduce manual handling time while preserving traceability.",
    riskStatement: "Incorrect eligibility rules could reverse an ineligible fee.",
    tags: ["fee reversals", "operations"],
    taxonomy: ["controlled servicing workflow"],
    affectedTeams: ["Operations"],
    assumptions: [],
  };
  const escapedModelText = JSON.stringify(output).replace(/"/g, "\\\"");
  let apigeeResponse: unknown = [{
    candidates: [{ content: { role: "model", parts: [{ text: escapedModelText }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 123, candidatesTokenCount: 77 },
  }];
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(apigeeResponse), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const promptVersion = getActiveAiPromptVersion("idea.enrich");
    assert.ok(promptVersion);
    const queued = await createAiRun({
      ideaId: idea.id,
      ideaVersionId: version.id,
      jobKey: "idea.enrich",
      jobVersion: "1",
      promptVersion: String(promptVersion),
      model: "gemini-test",
      idempotencyKey: "apigee-worker-flow-test",
      correlationId: "apigee-worker-flow-test",
      requestedBy: author.id,
      inputHash: "apigee-worker-flow-test",
      inputJson: JSON.stringify({
        kind: "idea",
        title: idea.title,
        summary: idea.summary,
        problem: idea.problem,
        solution: idea.solution,
        benefits: idea.benefits,
        risks: idea.risks,
        category: idea.category,
        dataClassification: "internal",
        evidence: [],
        relatedIdeas: [],
      }),
    });

    const outcome = await processNextAiRun("apigee-flow-test-worker", { provider: createApigeeProvider((await import("./config-core")).getAiConfig()) });
    assert.deepEqual(outcome, { status: "succeeded", runId: queued.id });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.url, process.env.APIGEE_URL);
    assert.equal(requests[0]?.init.method, "POST");
    assert.equal(new Headers(requests[0]?.init.headers).get("Client_id"), process.env.APIGEE_CLIENT_ID);
    const sentBody = JSON.parse(String(requests[0]?.init.body));
    assert.equal(sentBody.contents.role, "user");
    assert.match(sentBody.contents.parts[0].text, /response_schema/);

    const [persisted] = db.select().from(aiRuns).where(eq(aiRuns.id, queued.id)).all();
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.attemptCount, 1);
    assert.equal(persisted.errorCode, null);
    assert.deepEqual(JSON.parse(persisted.resultJson ?? "null"), output);
    assert.deepEqual(JSON.parse(persisted.usageJson ?? "null"), { inputTokens: 123, outputTokens: 77 });
    assert.equal(db.select().from(ideaAiResults).where(eq(ideaAiResults.runId, queued.id)).all().length, 1);
    assert.deepEqual(db.select().from(aiRunEvents).where(eq(aiRunEvents.runId, queued.id)).all().map((event) => event.eventType), ["queued", "running", "succeeded"]);
    assert.ok(db.select().from(ideaEvents).where(eq(ideaEvents.ideaId, idea.id)).all().some((event) => event.eventType === "ai_completed"));

    // Malformed model output is terminal: the worker records failure instead
    // of re-queuing the run and repeatedly calling APIGEE.
    apigeeResponse = [{ candidates: [{ content: { role: "model", parts: [{ text: "The model returned no structured answer." }] }, finishReason: "STOP" }] }];
    const failedQueued = await createAiRun({
      ideaId: idea.id,
      ideaVersionId: version.id,
      jobKey: "idea.enrich",
      jobVersion: "1",
      promptVersion: String(promptVersion),
      model: "gemini-test",
      idempotencyKey: "apigee-worker-flow-invalid-output",
      correlationId: "apigee-worker-flow-invalid-output",
      requestedBy: author.id,
      inputHash: "apigee-worker-flow-invalid-output",
      inputJson: JSON.stringify({
        kind: "idea",
        title: idea.title,
        summary: idea.summary,
        problem: idea.problem,
        solution: idea.solution,
        benefits: idea.benefits,
        risks: idea.risks,
        category: idea.category,
        dataClassification: "internal",
        evidence: [],
        relatedIdeas: [],
      }),
    });
    const failedOutcome = await processNextAiRun("apigee-flow-test-worker", { provider: createApigeeProvider((await import("./config-core")).getAiConfig()) });
    assert.deepEqual(failedOutcome, { status: "failed", runId: failedQueued.id });
    assert.equal(requests.length, 2, "invalid model output must make one provider call, not loop");
    const [failedRun] = db.select().from(aiRuns).where(eq(aiRuns.id, failedQueued.id)).all();
    assert.equal(failedRun.status, "failed");
    assert.equal(failedRun.errorCode, "model_output_not_json");
    assert.equal(failedRun.attemptCount, 1);
    assert.deepEqual(db.select().from(aiRunEvents).where(eq(aiRunEvents.runId, failedQueued.id)).all().map((event) => event.eventType), ["queued", "running", "failed"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
