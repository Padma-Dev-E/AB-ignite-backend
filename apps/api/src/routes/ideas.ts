import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../../../src/db/connection.js";
import { aiRuns, ideaAiResults, ideaEvents, ideaSettings, ideaSubmissions, ideaVersions, ideas, notifications } from "../../../../src/db/schema.js";
import { getAiConfig } from "../../../../src/lib/ai/config-core.js";
import { AiIdempotencyError, AiPolicyError, AiProviderError, AiSchemaValidationError, AiTimeoutError } from "../../../../src/lib/ai/errors.js";
import { getAiJob } from "../../../../src/lib/ai/registry.js";
import "../../../../src/lib/ai/jobs/index.js";
import { appendAuditEvent } from "../../../../src/lib/audit/service.js";
import { canDevelopIdea } from "../../../../src/lib/ideas/development.js";
import {
  CommentListQuerySchema,
  IdeaCommentSchema,
  IdeaInputSchema,
  IdeaListQuerySchema,
  IdeaSubmissionDetailsSchema,
  IdeaUpdateSchema,
  IdeaEnrichmentOutputSchema,
  IdeaValidationOutputSchema,
} from "../../../../src/lib/ideas/schemas.js";
import {
  appendIdeaEvent,
  createAiRun,
  createIdeaComment,
  getAuthorizedIdeaSnapshot,
  getIdeaById,
  getIdeaMinimumScore,
  getIdeaSubmissionDetails,
  getIdeaVersionPreflight,
  listIdeaComments,
  listIdeas,
  recordHumanReview,
  saveIdeaSubmission,
  setIdeaMinimumScore,
  submitIdea,
  supportIdea,
  updateReturnedIdea,
  IdeaPriorityMinimumError,
} from "../../../../src/lib/ideas/repository.js";
import { resolvePriorityPolicy, scorePriority, type PriorityMetrics } from "../../../../src/lib/ideas/priority-policy.js";
import { runIdeaScreeningWorkflow, transitionIdeaStatus } from "../../../../src/lib/ideas/workflow.js";
import { sendEnvelope, sendError } from "../plugins/http.js";
import type { ApiActor } from "../types.js";

const submitSchema = z.strictObject({
  versionId: z.number().int().positive().optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  submitForHumanReview: z.boolean().optional(),
});

const developmentSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("update"), input: IdeaUpdateSchema }),
  z.strictObject({ action: z.literal("enrich") }),
  z.strictObject({ action: z.literal("validate") }),
]);

const reviewSchema = z.strictObject({
  decision: z.enum(["approved", "returned", "rejected", "deferred"]),
  reason: z.string().trim().min(5).max(2_000),
  conflictAcknowledged: z.boolean().default(false),
});

const settingsSchema = z.strictObject({ minimumScore: z.number().min(0).max(3) });

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function queryObject(request: FastifyRequest) {
  return Object.fromEntries(new URL(request.url, "http://localhost").searchParams.entries());
}

function loadIdeaPriorityPolicy() {
  const rows = db.select({ key: ideaSettings.key, value: ideaSettings.value })
    .from(ideaSettings).where(inArray(ideaSettings.key, ["priority_kpis", "priority_bands"])).all();
  return resolvePriorityPolicy(Object.fromEntries(rows.map(({ key, value }) => [key, value])));
}

function actorFor(actor: ApiActor) {
  return { kind: "user" as const, id: String(actor.userId) };
}

function screeningActor(actor: ApiActor) {
  return { kind: actor.role === "back_office" ? "admin" as const : "user" as const, id: String(actor.userId) };
}

function snapshotActor(actor: ApiActor) {
  return { kind: actor.role, id: String(actor.userId) } as const;
}

function sendValidationError(reply: FastifyReply, request: FastifyRequest) {
  return sendError(reply, request, "validation_error", "The request could not be validated.", 400);
}

function sendLowScoreError(reply: FastifyReply, request: FastifyRequest, error: IdeaPriorityMinimumError) {
  return reply.code(422).header("x-request-id", request.id).header("cache-control", "no-store").send({
    data: null,
    error: {
      code: error.code,
      message: error.message,
      details: { score: error.score, minimumScore: error.minimumScore, priorityBand: error.priorityBand, breakdown: error.breakdown },
    },
    requestId: request.id,
  });
}

function sendMappedError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof z.ZodError || error instanceof AiSchemaValidationError) return sendError(reply, request, "validation_error", "The request could not be validated.", 400);
  if (error instanceof AiPolicyError) return sendError(reply, request, "policy_blocked", "This request requires human review.", 422);
  if (error instanceof AiIdempotencyError) return sendError(reply, request, "conflict", "This request is already being processed.", 409);
  if (error instanceof AiProviderError || error instanceof AiTimeoutError) return sendError(reply, request, "provider_unavailable", "The AI service is temporarily unavailable.", 502);
  if (error instanceof Error && /not found or not authorized/i.test(error.message)) return sendError(reply, request, "not_found", "Idea not found.", 404);
  if (error instanceof Error && /cannot be changed|locked|invalid/i.test(error.message)) return sendError(reply, request, "conflict", error.message, 409);
  return undefined;
}

async function requireActor(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): Promise<ApiActor | null> {
  return app.requireActor(request, reply);
}

export async function registerIdeaRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/ideas/priority-policy", async (request, reply) => {
    if (!await requireActor(app, request, reply)) return;
    try {
      return sendEnvelope(reply, request, { ...loadIdeaPriorityPolicy(), minimumScore: await getIdeaMinimumScore() });
    } catch (error) {
      const mapped = sendMappedError(reply, request, error);
      if (mapped) return mapped;
      request.log.error({ err: error }, "Unable to load idea priority policy");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.get("/api/ideas/settings", async (request, reply) => {
    if (!await requireActor(app, request, reply)) return;
    try {
      return sendEnvelope(reply, request, { minimumScore: await getIdeaMinimumScore() });
    } catch (error) {
      request.log.error({ err: error }, "Unable to load idea settings");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.patch("/api/ideas/settings", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    if (actor.role !== "back_office") return sendError(reply, request, "forbidden", "Administrator access required.", 403);
    try {
      const { minimumScore } = settingsSchema.parse(request.body);
      await setIdeaMinimumScore({ kind: "admin", id: String(actor.userId) }, minimumScore);
      return sendEnvelope(reply, request, { minimumScore });
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      request.log.error({ err: error }, "Unable to update idea settings");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.get("/api/ideas", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    try {
      const query = IdeaListQuerySchema.parse(queryObject(request));
      return sendEnvelope(reply, request, await listIdeas(actorFor(actor), query));
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      request.log.error({ err: error }, "Unable to list ideas");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.post("/api/ideas", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const requestId = request.id;
    try {
      const input = IdeaInputSchema.parse(request.body);
      const { answers, metrics, buildsOnId, differentiation, ...ideaInput } = input;
      const { dataClassification: _dataClassification, ...ideaFields } = ideaInput;
      const allIdeas = await db.select().from(ideas)
        .where(and(ne(ideas.authorId, actor.userId), ne(ideas.status, "draft")))
        .orderBy(desc(ideas.createdAt)).limit(500).all();
      const words = (text: string) => new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((word) => word.length > 3));
      const similarity = (left: string, right: string) => {
        const a = words(left); const b = words(right);
        if (!a.size || !b.size) return 0;
        let overlap = 0; a.forEach((word) => { if (b.has(word)) overlap++; });
        return overlap / (a.size + b.size - overlap);
      };
      const candidates = allIdeas.map((idea) => ({
        idea,
        score: similarity(`${idea.title} ${idea.summary} ${idea.problem ?? ""} ${idea.solution ?? ""}`, `${input.title} ${input.summary} ${input.problem ?? ""} ${input.solution ?? ""}`),
      })).filter(({ score }) => score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 5);
      const selectedOriginal = buildsOnId
        ? candidates.find(({ idea }) => idea.id === buildsOnId)
        : (differentiation?.trim().length ?? 0) >= 20 ? candidates[0] : undefined;
      if (candidates.length && !selectedOriginal && (differentiation?.trim().length ?? 0) < 20) {
        return sendError(reply, request, "similar_idea", "A similar registered idea exists. Open the original or explain how this idea differs in at least 20 characters.", 409);
      }
      if (buildsOnId && !selectedOriginal) return sendError(reply, request, "validation_error", "The selected original is not a matching registered idea.", 400);
      const priority = metrics ? scorePriority(metrics as PriorityMetrics, loadIdeaPriorityPolicy()) : null;
      const minimumScore = await getIdeaMinimumScore();
      const reference = `IDEA-${Date.now()}-${randomBytes(3).toString("hex").toUpperCase()}`;
      const contentHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const { idea, version } = await db.transaction((tx) => {
        const [createdIdea] = tx.insert(ideas).values({
          authorId: actor.userId,
          ...ideaFields,
          status: "draft",
          buildsOnId: buildsOnId ?? null,
          ...(priority ? { priorityScore: priority.score, priorityBand: priority.band } : {}),
          reference,
        }).returning().all();
        if (!createdIdea) throw new Error("Idea was not created");
        const [createdVersion] = tx.insert(ideaVersions).values({ ...ideaInput, ideaId: createdIdea.id, authorId: actor.userId, version: 1, contentHash }).returning().all();
        if (!createdVersion) throw new Error("Idea version was not created");
        tx.insert(ideaEvents).values({ ideaId: createdIdea.id, ideaVersionId: createdVersion.id, actorType: actor.role === "back_office" ? "admin" : "user", actorId: actor.userId, eventType: "created", correlationId: requestId }).run();
        if (answers && metrics) tx.insert(ideaSubmissions).values({ ideaId: createdIdea.id, answersJson: JSON.stringify(answers), metricsJson: JSON.stringify(metrics), score: priority!.score, minimumScore, differentiation: differentiation ?? null }).run();
        if (selectedOriginal) tx.insert(notifications).values({ userId: selectedOriginal.idea.authorId, type: "idea_builds_on", title: "A colleague built on your idea", body: `${selectedOriginal.idea.reference} has been used as the basis for a related idea.`, link: `/ideas/${selectedOriginal.idea.id}` }).run();
        return { idea: createdIdea, version: createdVersion };
      });
      return sendEnvelope(reply, request, { idea, versionId: version.id }, 201);
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      const mapped = sendMappedError(reply, request, error);
      if (mapped) return mapped;
      request.log.error({ err: error }, "Unable to create idea");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.get("/api/ideas/:id", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const idea = await getIdeaById(ideaId);
      if (!idea || (idea.status === "draft" && idea.authorId !== actor.userId)) return sendError(reply, request, "not_found", "Idea not found.", 404);
      const comments = await listIdeaComments(ideaId, CommentListQuerySchema.parse(queryObject(request)));
      const submission = await getIdeaSubmissionDetails(ideaId);
      return sendEnvelope(reply, request, { idea, comments, submission });
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      request.log.error({ err: error }, "Unable to load idea");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.patch("/api/ideas/:id", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const current = await getIdeaById(ideaId);
      if (!current || (actor.role !== "back_office" && current.authorId !== actor.userId)) return sendError(reply, request, "not_found", "Idea not found.", 404);
      if (current.status !== "returned") return sendError(reply, request, "conflict", "Only returned ideas can be edited.", 409);
      const input = IdeaUpdateSchema.parse(request.body);
      return sendEnvelope(reply, request, await updateReturnedIdea(actorFor(actor), ideaId, input));
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      const mapped = sendMappedError(reply, request, error);
      if (mapped) return mapped;
      request.log.error({ err: error }, "Unable to update returned idea");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.put("/api/ideas/:id/submission", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const input = IdeaSubmissionDetailsSchema.parse(request.body);
      const submission = await saveIdeaSubmission(actorFor(actor), ideaId, input);
      return sendEnvelope(reply, request, { score: submission.score, minimumScore: submission.minimumScore, answers: input.answers, metrics: input.metrics });
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      const mapped = sendMappedError(reply, request, error);
      if (mapped) return mapped;
      request.log.error({ err: error }, "Unable to save idea submission");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.post("/api/ideas/:id/submit", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const input = submitSchema.parse(request.body);
      const domainActor = actorFor(actor);
      const snapshot = await getAuthorizedIdeaSnapshot(snapshotActor(actor), ideaId);
      if (!snapshot) return sendError(reply, request, "not_found", "Idea not found.", 404);
      const version = snapshot.versions.at(-1);
      if (!version) return sendError(reply, request, "validation_error", "Idea version not found.", 400);
      const latestPreflight = await getIdeaVersionPreflight(ideaId, version.id);
      if (!latestPreflight || latestPreflight.status !== "succeeded") {
        const idempotencyKey = `idea:${ideaId}:version:${version.id}:idea.preflight:v1`;
        await runIdeaScreeningWorkflow(ideaId, version.id, screeningActor(actor), idempotencyKey);
        const run = await getIdeaVersionPreflight(ideaId, version.id);
        return sendEnvelope(reply, request, { ideaId, versionId: version.id, runId: run?.id ?? null, status: run?.status ?? "queued", submitted: false }, 202);
      }
      let preflight: { decision?: string; safeToProcess?: boolean } = {};
      try { preflight = JSON.parse(latestPreflight.resultJson ?? "{}"); } catch { /* Invalid stored output fails closed. */ }
      if (preflight.decision !== "allow" || preflight.safeToProcess !== true) return sendError(reply, request, "validation_failed", "Idea validation failed; improve the idea and run validation again.", 422);
      const submission = await submitIdea(domainActor, ideaId, { submitForHumanReview: input.submitForHumanReview });
      return sendEnvelope(reply, request, { ...submission, submitted: true, minimumScore: await getIdeaMinimumScore(), confirmation: `Congratulations, ${submission.reference} has been submitted.` }, 201);
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      if (error instanceof IdeaPriorityMinimumError) return sendLowScoreError(reply, request, error);
      if (error instanceof Error && /below the minimum|must pass validation|validation must pass|answers and all three|current status|human review submission/i.test(error.message)) return sendError(reply, request, "submission_rejected", error.message, 422);
      const mapped = sendMappedError(reply, request, error);
      if (mapped) return mapped;
      request.log.error({ err: error }, "Unable to submit idea");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.get("/api/ideas/:id/development", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const snapshot = await getAuthorizedIdeaSnapshot({ kind: "user", id: String(actor.userId) }, ideaId);
      if (!snapshot) return sendError(reply, request, "not_found", "Idea not found.", 404);
      const runs = snapshot.runs.filter((run) => run.jobKey === "idea.enrich" || run.jobKey === "idea.validate").sort((a, b) => b.id - a.id);
      return sendEnvelope(reply, request, { runs: runs.map((run) => {
        const schema = run.jobKey === "idea.enrich" ? IdeaEnrichmentOutputSchema : IdeaValidationOutputSchema;
        let result = null;
        if (run.status === "succeeded" && run.resultJson) {
          try { const parsed = schema.safeParse(JSON.parse(run.resultJson)); if (parsed.success) result = parsed.data; } catch { /* Corrupt stored output is unavailable. */ }
        }
        return { id: run.id, jobKey: run.jobKey, status: run.status, ideaVersionId: run.ideaVersionId, result, createdAt: run.createdAt, completedAt: run.completedAt };
      }) });
    } catch (error) {
      request.log.error({ err: error }, "Unable to load idea development");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.post("/api/ideas/:id/development", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const snapshot = await getAuthorizedIdeaSnapshot({ kind: "user", id: String(actor.userId) }, ideaId);
      if (!snapshot) return sendError(reply, request, "not_found", "Idea not found.", 404);
      const hasPreflight = snapshot.runs.some((run) => run.jobKey === "idea.preflight");
      if (!canDevelopIdea(snapshot.idea, actor.userId, hasPreflight)) return sendError(reply, request, "not_found", "Idea not found.", 404);
      const input = developmentSchema.parse(request.body);
      const version = snapshot.versions.at(-1);
      if (!version) return sendError(reply, request, "conflict", "Idea version not found.", 409);
      if (input.action === "update") {
        const next = { kind: version.kind, title: version.title, summary: version.summary, problem: version.problem, solution: version.solution, benefits: version.benefits, risks: version.risks, category: version.category, dataClassification: version.dataClassification, ...input.input };
        const changed = Object.entries(input.input).some(([key, value]) => value !== version[key as keyof typeof version]);
        if (!changed) return sendEnvelope(reply, request, { idea: snapshot.idea, versionId: version.id });
        const contentHash = createHash("sha256").update(JSON.stringify(next)).digest("hex");
        const updated = await db.transaction((tx) => {
          const [latest] = tx.select().from(ideaVersions).where(eq(ideaVersions.ideaId, ideaId)).orderBy(desc(ideaVersions.version)).limit(1).all();
          const [preflight] = tx.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.ideaId, ideaId), eq(aiRuns.jobKey, "idea.preflight"))).limit(1).all();
          if (!latest || latest.id !== version.id || preflight) return null;
          const [idea] = tx.update(ideas).set({ ...input.input, updatedAt: new Date() }).where(and(eq(ideas.id, ideaId), eq(ideas.authorId, actor.userId), inArray(ideas.status, ["draft", "screening"]))).returning().all();
          if (!idea) return null;
          const [newVersion] = tx.insert(ideaVersions).values({ ...next, ideaId, authorId: actor.userId, version: version.version + 1, contentHash }).returning().all();
          return newVersion ? { idea, versionId: newVersion.id } : null;
        });
        if (!updated) return sendError(reply, request, "conflict", "The idea changed while you were editing. Reload and try again.", 409);
        await appendIdeaEvent({ ideaId, ideaVersionId: updated.versionId, actorType: "user", actorId: actor.userId, eventType: "development_updated", correlationId: request.id });
        appendAuditEvent({ actorUserId: actor.userId, action: "idea.development_updated", targetType: "idea", targetId: ideaId, metadata: { versionId: updated.versionId } });
        return sendEnvelope(reply, request, updated);
      }
      const job = getAiJob(input.action === "enrich" ? "idea.enrich" : "idea.validate", "1");
      const previous = snapshot.runs.filter((candidate) => candidate.ideaVersionId === version.id && candidate.jobKey === job.key).sort((a, b) => b.id - a.id);
      const latest = previous[0];
      if (latest && !["failed", "timed_out", "cancelled"].includes(latest.status)) return sendEnvelope(reply, request, { runId: latest.id, status: latest.status, versionId: version.id });
      if (previous.length >= 3) return sendError(reply, request, "rate_limited", "This draft has reached the AI retry limit. You can continue without AI suggestions.", 429);
      const run = await createAiRun({ ideaId, ideaVersionId: version.id, jobKey: job.key, jobVersion: job.version, promptVersion: job.version, model: job.model ?? getAiConfig().model, idempotencyKey: `idea:${ideaId}:version:${version.id}:${job.key}:v${job.version}:try:${previous.length + 1}`, correlationId: request.id, requestedBy: actor.userId, inputHash: version.contentHash });
      if (run.correlationId === request.id) {
        await appendIdeaEvent({ ideaId, ideaVersionId: version.id, actorType: "user", actorId: actor.userId, eventType: `${input.action}_queued`, correlationId: request.id, metadataJson: JSON.stringify({ runId: run.id }) });
        appendAuditEvent({ actorUserId: actor.userId, action: `idea.${input.action}_queued`, targetType: "idea", targetId: ideaId, metadata: { runId: run.id, versionId: version.id } });
      }
      return sendEnvelope(reply, request, { runId: run.id, status: run.status, versionId: version.id }, 202);
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      const mapped = sendMappedError(reply, request, error);
      if (mapped) return mapped;
      request.log.error({ err: error }, "Unable to update idea development");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.get("/api/ideas/:id/ai-status", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const snapshot = await getAuthorizedIdeaSnapshot(snapshotActor(actor), ideaId);
      if (!snapshot) return sendError(reply, request, "not_found", "Idea not found.", 404);
      return sendEnvelope(reply, request, {
        idea: snapshot.idea,
        runs: snapshot.runs.map(({ resultJson: _result, errorMessage: _error, ...run }) => run),
        events: snapshot.events,
        aiRunEvents: snapshot.aiRunEvents,
        reviews: snapshot.reviews,
      });
    } catch (error) {
      request.log.error({ err: error }, "Unable to load idea AI status");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.post("/api/ideas/:id/ai-retry", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    if (actor.role !== "back_office") return sendError(reply, request, "forbidden", "Reviewer access required.", 403);
    const ideaId = Number((request.params as { id: string }).id);
    try {
      const snapshot = await getAuthorizedIdeaSnapshot({ kind: "admin", id: String(actor.userId) }, ideaId);
      if (!snapshot) return sendError(reply, request, "not_found", "Idea not found.", 404);
      const [failed] = await db.select().from(aiRuns).where(eq(aiRuns.ideaId, ideaId)).orderBy(desc(aiRuns.createdAt)).limit(1).all();
      if (!failed || !["failed", "timed_out"].includes(failed.status)) return sendError(reply, request, "conflict", "There is no failed AI run to retry.", 409);
      const retry = await createAiRun({ ideaId: failed.ideaId, ideaVersionId: failed.ideaVersionId, jobKey: failed.jobKey, jobVersion: failed.jobVersion, promptVersion: failed.promptVersion, model: failed.model, idempotencyKey: `${failed.idempotencyKey}:retry:${Date.now()}`, correlationId: request.id, requestedBy: actor.userId, inputHash: failed.inputHash });
      await appendIdeaEvent({ ideaId, ideaVersionId: failed.ideaVersionId, actorType: "admin", actorId: actor.userId, eventType: "ai_retry_requested", correlationId: request.id, metadataJson: JSON.stringify({ previousRunId: failed.id, runId: retry.id }) });
      return sendEnvelope(reply, request, { runId: retry.id, status: retry.status }, 202);
    } catch (error) {
      request.log.error({ err: error }, "Unable to retry idea AI run");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.get("/api/ideas/:id/comments", async (request, reply) => {
    if (!await requireActor(app, request, reply)) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const idea = await getIdeaById(ideaId);
      if (!idea || idea.status === "draft") return sendError(reply, request, "not_found", "Idea not found.", 404);
      return sendEnvelope(reply, request, await listIdeaComments(ideaId, CommentListQuerySchema.parse(queryObject(request))));
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      request.log.error({ err: error }, "Unable to list idea comments");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.post("/api/ideas/:id/comments", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = parseId((request.params as { id: string }).id);
    if (!ideaId) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const idea = await getIdeaById(ideaId);
      if (!idea || idea.status === "draft") return sendError(reply, request, "not_found", "Idea not found.", 404);
      const input = IdeaCommentSchema.parse(request.body);
      return sendEnvelope(reply, request, await createIdeaComment(actorFor(actor), ideaId, input.body), 201);
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      request.log.error({ err: error }, "Unable to create idea comment");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.get("/api/ideas/:id/decision-pack", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = Number((request.params as { id: string }).id);
    try {
      const snapshot = await getAuthorizedIdeaSnapshot(snapshotActor(actor), ideaId);
      if (!snapshot) return sendError(reply, request, "not_found", "Idea not found.", 404);
      const [result] = await db.select().from(ideaAiResults).where(and(eq(ideaAiResults.ideaId, ideaId), eq(ideaAiResults.jobKey, "idea.decision_pack"))).orderBy(desc(ideaAiResults.createdAt)).limit(1).all();
      if (!result) return sendError(reply, request, "not_found", "Decision pack not found.", 404);
      return sendEnvelope(reply, request, { ...result, resultJson: JSON.parse(result.resultJson) });
    } catch (error) {
      request.log.error({ err: error }, "Unable to load idea decision pack");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.post("/api/ideas/:id/review", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    if (!["back_office", "business_owner"].includes(actor.role)) return sendError(reply, request, "forbidden", "Governance reviewer access required.", 403);
    const ideaId = Number((request.params as { id: string }).id);
    try {
      const input = reviewSchema.parse(request.body);
      const target = input.decision === "approved" ? (actor.role === "business_owner" ? "control_review" : "decision") : input.decision;
      const updated = await transitionIdeaStatus({ kind: actor.role, id: String(actor.userId) }, ideaId, target, input.reason);
      const review = await recordHumanReview({ ideaId, reviewerId: actor.userId, decision: input.decision, reason: input.reason, conflictAcknowledged: input.conflictAcknowledged });
      return sendEnvelope(reply, request, { idea: updated, review }, 201);
    } catch (error) {
      if (error instanceof z.ZodError) return sendValidationError(reply, request);
      request.log.error({ err: error }, "Unable to review idea");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });

  app.post("/api/ideas/:id/support", async (request, reply) => {
    const actor = await requireActor(app, request, reply);
    if (!actor) return;
    const ideaId = Number((request.params as { id: string }).id);
    if (!Number.isInteger(ideaId) || ideaId < 1) return sendError(reply, request, "validation_error", "Invalid idea ID.", 400);
    try {
      const idea = await getIdeaById(ideaId);
      if (!idea || idea.status === "draft") return sendError(reply, request, "not_found", "Idea not found.", 404);
      return sendEnvelope(reply, request, await supportIdea(actorFor(actor), ideaId));
    } catch (error) {
      request.log.error({ err: error }, "Unable to support idea");
      return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    }
  });
}
