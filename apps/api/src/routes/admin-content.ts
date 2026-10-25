import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthorizationError, assertCapability, loadAuthorizationContext } from "../../../../src/lib/auth/authorization.js";
import { CAPABILITIES, type Capability } from "../../../../src/lib/auth/permissions.js";
import { AdminConflictError, AdminInputError, AdminNotFoundError, csvForRecords, parsePage, positiveId } from "../../../../src/lib/admin/query.js";
import { adminContentTotals, listAdminChallengePage, listAdminQuizPage, listAdminAnnouncementPage, listAdminCampaignPage, listAdminRewardPage, parseAdminOffsetPage, listIdeaExportRows } from "../../../../src/lib/admin/service.js";
import { createAdminArticle, listAdminArticles, updateAdminArticle, getAdminQuizQuestions, updateAdminQuestion } from "../../../../src/lib/admin/learning/service.js";
import { addQuestion, challengeCreateSchema, challengeUpdateSchema, createChallenge, createQuiz, createQuizVersion, publishQuizVersion, quizCreateSchema, questionCreateSchema, updateChallenge } from "../../../../src/lib/admin/learning/authoring.js";
import { createAnnouncement, setAnnouncementPinned, setCampaignActive } from "../../../../src/lib/admin/engagement/service.js";
import { createReward, getAdminCatalogue, updateReward } from "../../../../src/lib/rewards/service.js";
import { createAdminBadgeRule, listAdminBadgeRules, updateAdminBadgeRule } from "../../../../src/lib/rewards/badge-admin.js";
import { adminSettingsPatchSchema } from "../../../../src/lib/admin/settings/request-schema.js";
import { getAdminSettings, updateAdminSettings } from "../../../../src/lib/admin/settings/service.js";
import { requirePrivilegedReason } from "../../../../src/lib/auth/authorization-core.js";
import { RewardsError } from "../../../../src/lib/rewards/errors.js";
import { BENEFITS_EXPORT_HEADERS } from "../../../../src/lib/admin/export.js";
import { db } from "../../../../src/db/connection.js";
import { badges } from "../../../../src/db/schema.js";
import { sql } from "drizzle-orm";
import type { ApiActor } from "../types.js";
import { sendEnvelope, sendError } from "../plugins/http.js";

const articleSchema = z.strictObject({
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(2000),
  body: z.string().trim().min(1).max(30000),
  category: z.string().trim().min(1).max(100),
  topic: z.string().trim().max(120).nullable().optional(),
  publisher: z.string().trim().min(1).max(200),
  difficulty: z.string().trim().min(1).max(60),
  readingMinutes: z.number().int().min(1).max(600),
  publishedLabel: z.string().trim().max(100).nullable().optional(),
  url: z.string().trim().max(2048).nullable().optional(),
  published: z.boolean(),
  contentType: z.enum(["internal", "external"]),
  categoryCode: z.string().trim().min(1).max(80),
});
const questionUpdateSchema = z.strictObject({
  questionId: z.number().int().positive(),
  reason: z.unknown(),
  prompt: z.string().trim().min(1).max(3000),
  topic: z.string().trim().min(1).max(120),
  sortOrder: z.number().int().min(0).max(1000),
  points: z.number().int().min(0).max(10000),
  options: z.array(z.strictObject({
    optionKey: z.string().trim().min(1).max(40),
    label: z.string().trim().min(1).max(500),
    sortOrder: z.number().int().min(0).max(100),
    isCorrect: z.boolean(),
  })).min(2).max(10).refine((options) => options.filter((option) => option.isCorrect).length === 1),
});
const rewardCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullable().optional(),
  kind: z.enum(["catalogue", "earned"]),
  cost: z.number().int().min(0),
  emoji: z.string().trim().max(20).nullable().optional(),
  active: z.boolean().default(true),
  reason: z.unknown(),
});
const rewardUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).nullable().optional(),
  kind: z.enum(["catalogue", "earned"]),
  cost: z.number().int().min(0),
  emoji: z.string().trim().max(20).nullable().optional(),
  active: z.boolean(),
  reason: z.unknown(),
});

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function requestUrl(request: FastifyRequest) {
  return new URL(request.url, "http://localhost");
}

function auditMetadata(request: FastifyRequest) {
  return {
    ipAddress: request.ip ?? null,
    userAgent: typeof request.headers["user-agent"] === "string" ? request.headers["user-agent"] : null,
  };
}

function idempotencyKey(request: FastifyRequest) {
  const value = request.headers["idempotency-key"];
  return (typeof value === "string" ? value : Array.isArray(value) ? value[0] : "")?.trim() ?? "";
}

async function requireAdmin(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply, capability: Capability = CAPABILITIES.SETTINGS_MANAGE) {
  const actor = await app.requireActor(request, reply);
  if (!actor) return null;
  try {
    assertCapability(await loadAuthorizationContext({ userId: actor.userId, sessionId: actor.sessionId }), capability);
    return actor;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      sendError(reply, request, "forbidden", capability === CAPABILITIES.AUDIT_EXPORT ? "Administrator access required or session changed." : "You do not have permission to perform this action.", 403);
      return null;
    }
    throw error;
  }
}

function actorInput(actor: ApiActor, request: FastifyRequest, reason: unknown) {
  return { userId: actor.userId, sessionId: actor.sessionId, reason, ...auditMetadata(request) };
}

function sendRouteError(reply: FastifyReply, request: FastifyRequest, error: unknown, rewardRoute = false) {
  if (error instanceof z.ZodError) return sendError(reply, request, "validation_error", "The request could not be validated.", 400);
  if (error instanceof AuthorizationError) return sendError(reply, request, "forbidden", rewardRoute ? "You do not have permission to perform this action." : "Administrator access required or session changed.", 403);
  if (error instanceof AdminInputError || error instanceof AdminNotFoundError || error instanceof AdminConflictError) return sendError(reply, request, error.code, error.message, error.status);
  if (error instanceof RewardsError) return sendError(reply, request, error.code.toLowerCase(), error.message, error.status);
  request.log.error({ err: error }, "Admin content API request failed");
  return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
}

function route(app: FastifyInstance, method: "get" | "post" | "patch", url: string, handler: Handler, rewardRoute = false) {
  app[method](url, async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      return sendRouteError(reply, request, error, rewardRoute);
    }
  });
}

export async function registerAdminContentRoutes(app: FastifyInstance): Promise<void> {
  route(app, "get", "/api/admin/learning/articles", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const page = parsePage(requestUrl(request), 10);
    return sendEnvelope(reply, request, { ...await listAdminArticles(page), total: adminContentTotals().articles });
  });
  route(app, "post", "/api/admin/learning/articles", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const input = z.strictObject({ ...articleSchema.shape, reason: z.unknown() }).parse(request.body);
    const { reason, ...data } = input;
    return sendEnvelope(reply, request, await createAdminArticle(actorInput(actor, request, reason), data, idempotencyKey(request)), 201);
  });
  route(app, "patch", "/api/admin/learning/articles/:id", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const input = z.strictObject({ ...articleSchema.shape, reason: z.unknown() }).parse(request.body);
    const { reason, ...data } = input;
    const { id } = request.params as { id: string };
    return sendEnvelope(reply, request, await updateAdminArticle(actorInput(actor, request, reason), positiveId(id), data, idempotencyKey(request)));
  });

  route(app, "get", "/api/admin/learning/challenges", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    return sendEnvelope(reply, request, listAdminChallengePage(parsePage(requestUrl(request), 10)));
  });
  route(app, "post", "/api/admin/learning/challenges", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const body = z.strictObject({ ...challengeCreateSchema.shape, reason: z.unknown() }).parse(request.body);
    const { reason, ...input } = body;
    return sendEnvelope(reply, request, createChallenge(actorInput(actor, request, reason), input, idempotencyKey(request)), 201);
  });
  route(app, "patch", "/api/admin/learning/challenges/:id", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const body = z.strictObject({ title: z.string().trim().min(1).max(240).optional(), question: z.string().trim().min(1).max(3000).optional(), deadlineAt: z.iso.datetime({ offset: true }).optional(), active: z.boolean().optional(), reason: z.unknown() }).parse(request.body);
    const { reason, ...input } = body;
    const { id } = request.params as { id: string };
    return sendEnvelope(reply, request, updateChallenge(actorInput(actor, request, reason), positiveId(id), challengeUpdateSchema.parse(input), idempotencyKey(request)));
  });

  route(app, "get", "/api/admin/learning/quizzes", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    return sendEnvelope(reply, request, listAdminQuizPage(parsePage(requestUrl(request), 10)));
  });
  route(app, "post", "/api/admin/learning/quizzes", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const body = z.strictObject({ ...quizCreateSchema.shape, reason: z.unknown() }).parse(request.body);
    const { reason, ...input } = body;
    return sendEnvelope(reply, request, createQuiz(actorInput(actor, request, reason), input, idempotencyKey(request)), 201);
  });
  route(app, "post", "/api/admin/learning/quizzes/:id/versions", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const { reason } = z.strictObject({ reason: z.unknown() }).parse(request.body);
    const { id } = request.params as { id: string };
    return sendEnvelope(reply, request, createQuizVersion(actorInput(actor, request, reason), positiveId(id), idempotencyKey(request)), 201);
  });
  route(app, "get", "/api/admin/learning/quiz-versions/:id/questions", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    return sendEnvelope(reply, request, await getAdminQuizQuestions(positiveId(id)));
  });
  route(app, "post", "/api/admin/learning/quiz-versions/:id/questions", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const body = questionCreateSchema.safeExtend({ reason: z.unknown() }).parse(request.body);
    const { reason, ...question } = body;
    const { id } = request.params as { id: string };
    return sendEnvelope(reply, request, await addQuestion(actorInput(actor, request, reason), positiveId(id), question, idempotencyKey(request)), 201);
  });
  route(app, "patch", "/api/admin/learning/quiz-versions/:id/questions", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const input = questionUpdateSchema.parse(request.body);
    const { reason, questionId, ...question } = input;
    const { id } = request.params as { id: string };
    const versionId = positiveId(id);
    if (!(await getAdminQuizQuestions(versionId)).some((item) => item.id === questionId)) throw new AdminNotFoundError("Question not found in this quiz version.");
    return sendEnvelope(reply, request, await updateAdminQuestion(actorInput(actor, request, reason), questionId, question, idempotencyKey(request)));
  });
  route(app, "post", "/api/admin/learning/quiz-versions/:id/publish", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const { reason } = z.strictObject({ reason: z.unknown() }).parse(request.body);
    const { id } = request.params as { id: string };
    return sendEnvelope(reply, request, publishQuizVersion(actorInput(actor, request, reason), positiveId(id), idempotencyKey(request)));
  });

  route(app, "get", "/api/admin/engagement/announcements", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    return sendEnvelope(reply, request, listAdminAnnouncementPage(parseAdminOffsetPage(requestUrl(request))));
  });
  route(app, "post", "/api/admin/engagement/announcements", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const body = z.strictObject({ title: z.string(), body: z.string(), reason: z.unknown() }).parse(request.body);
    const { reason, ...input } = body;
    return sendEnvelope(reply, request, await createAnnouncement(actorInput(actor, request, reason), input, idempotencyKey(request)), 201);
  });
  route(app, "patch", "/api/admin/engagement/announcements/:id", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const { pinned, reason } = z.strictObject({ pinned: z.boolean(), reason: z.unknown() }).parse(request.body);
    const { id } = request.params as { id: string };
    return sendEnvelope(reply, request, await setAnnouncementPinned(actorInput(actor, request, reason), Number(id), pinned, idempotencyKey(request)));
  });
  route(app, "get", "/api/admin/engagement/campaigns", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    return sendEnvelope(reply, request, listAdminCampaignPage(parseAdminOffsetPage(requestUrl(request))));
  });
  route(app, "patch", "/api/admin/engagement/campaigns", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const body = z.strictObject({ campaignId: z.number().int().positive(), active: z.boolean(), reason: z.unknown() }).parse(request.body);
    const { reason, campaignId, active } = body;
    return sendEnvelope(reply, request, await setCampaignActive(actorInput(actor, request, reason), campaignId, active, idempotencyKey(request)));
  });

  route(app, "get", "/api/admin/rewards", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    return sendEnvelope(reply, request, await getAdminCatalogue());
  }, true);
  route(app, "post", "/api/admin/rewards", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const input = rewardCreateSchema.parse(request.body);
    const reason = requirePrivilegedReason(input.reason);
    return sendEnvelope(reply, request, await createReward({ ...input, reason, actorUserId: actor.userId, sessionId: actor.sessionId, ...auditMetadata(request) }), 201);
  }, true);
  route(app, "patch", "/api/admin/rewards/:id", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const rewardId = Number(id);
    if (!Number.isInteger(rewardId) || rewardId < 1) return sendError(reply, request, "validation_error", "Invalid reward ID.", 400);
    const input = rewardUpdateSchema.parse(request.body);
    const reason = requirePrivilegedReason(input.reason);
    return sendEnvelope(reply, request, await updateReward({ ...input, reason, rewardId, actorUserId: actor.userId, sessionId: actor.sessionId, ...auditMetadata(request) }));
  }, true);

  route(app, "get", "/api/admin/badges", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const url = requestUrl(request);
    const limit = z.coerce.number().int().min(1).max(10).parse(url.searchParams.get("limit") ?? "10");
    const afterRaw = url.searchParams.get("after");
    const after = afterRaw === null ? null : z.coerce.number().int().positive().safe().parse(afterRaw);
    const page = await listAdminBadgeRules({ limit, after });
    const total = db.select({ count: sql<number>`count(*)` }).from(badges).get()!.count;
    return sendEnvelope(reply, request, { ...page, total });
  }, true);
  route(app, "post", "/api/admin/badges", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const { reason, ...input } = z.record(z.string(), z.unknown()).parse(request.body);
    return sendEnvelope(reply, request, await createAdminBadgeRule(actorInput(actor, request, reason), input, idempotencyKey(request)), 201);
  }, true);
  route(app, "patch", "/api/admin/badges/:id", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    const { reason, ...input } = z.record(z.string(), z.unknown()).parse(request.body);
    return sendEnvelope(reply, request, await updateAdminBadgeRule(actorInput(actor, request, reason), Number(id), input, idempotencyKey(request)));
  }, true);

  route(app, "get", "/api/admin/settings", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    return sendEnvelope(reply, request, await getAdminSettings());
  });
  route(app, "patch", "/api/admin/settings", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply);
    if (!actor) return;
    const input = adminSettingsPatchSchema.parse(request.body);
    return sendEnvelope(reply, request, await updateAdminSettings(actorInput(actor, request, input.reason), input));
  });

  route(app, "get", "/api/admin/benefits/export", async (request, reply) => {
    const actor = await requireAdmin(app, request, reply, CAPABILITIES.AUDIT_EXPORT);
    if (!actor) return;
    const page = listIdeaExportRows(parsePage(requestUrl(request), 1000));
    const csv = csvForRecords([...BENEFITS_EXPORT_HEADERS], page.items.map((row) => [row.id, row.reference, row.priorityScore, row.priorityBand, row.department, row.benefits, row.status, row.updatedAt.toISOString()]));
    reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="admin-benefits.csv"');
    if (page.nextAfter) reply.header("x-next-after", String(page.nextAfter));
    return reply.send(csv);
  });
}
