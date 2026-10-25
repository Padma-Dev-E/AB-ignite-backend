import { desc } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteHandlerMethod } from "fastify";
import { z } from "zod";
import { db } from "../../../../src/db/connection.js";
import { aiRuns } from "../../../../src/db/schema.js";
import { AuthorizationError, assertCapability, loadAuthorizationContext } from "../../../../src/lib/auth/authorization.js";
import { CAPABILITIES } from "../../../../src/lib/auth/permissions.js";
import {
  AdminConflictError,
  AdminInputError,
  AdminNotFoundError,
  boundedFilter,
  directoryQuery,
  optionalId,
  parsePage,
  positiveId,
} from "../../../../src/lib/admin/query.js";
import {
  changeUserRole,
  createUser,
  getAdminAnalytics,
  getUserDetail,
  listAuditEvents,
  listAdminFeedbackPage,
  listFeedbackExportRows,
  listIdeaExportRows,
  listUserSessions,
  listUsers,
  resetUserPassword,
  resetUserSecurity,
  revokeUserSession,
  setUserActive,
} from "../../../../src/lib/admin/service.js";
import {
  decideGovernance,
  getEvaluation,
  listBusinessOwners,
  listDeliveryQueue,
  listRoutedEvaluations,
  listScreeningQueue,
  listTransformationQueue,
  requireGovernanceRole,
} from "../../../../src/lib/admin/governance/service.js";
import { IDEAS_EXPORT_HEADERS, FEEDBACK_EXPORT_HEADERS } from "../../../../src/lib/admin/export.js";
import { csvForRecords } from "../../../../src/lib/admin/query.js";
import { csvForSafeAudit } from "../../../../src/lib/audit/export.js";
import { LibraryError, respondToFeedback } from "../../../../src/lib/articles/service.js";
import { sendEnvelope, sendError } from "../plugins/http.js";
import type { ApiActor } from "../types.js";

type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function route(handler: Handler): RouteHandlerMethod {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof AdminInputError || error instanceof AdminNotFoundError || error instanceof AdminConflictError) {
        return sendError(reply, request, error.code, error.message, error.status);
      }
      if (error instanceof AuthorizationError) {
        return sendError(reply, request, "forbidden", "Administrator access required or session changed.", 403);
      }
      if (error instanceof LibraryError) {
        return sendError(reply, request, error.code.toLowerCase(), error.message, error.status);
      }
      throw error;
    }
  };
}

async function authorizedActor(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  capability: (typeof CAPABILITIES)[keyof typeof CAPABILITIES],
): Promise<ApiActor | null> {
  const actor = await app.requireActor(request, reply);
  if (!actor) return null;

  let context;
  try {
    // Reload role and active session state before checking capabilities. Never authorize from JWT claims alone.
    context = await loadAuthorizationContext({ userId: actor.userId, sessionId: actor.sessionId });
  } catch {
    sendError(reply, request, "unauthorized", "Authentication required.", 401);
    return null;
  }
  assertCapability(context, capability);
  return actor;
}

function auditMetadata(request: FastifyRequest) {
  return { ipAddress: request.ip ?? null, userAgent: request.headers["user-agent"] ?? null };
}

function requestUrl(request: FastifyRequest) {
  return new URL(request.url, "http://fastify.internal");
}

function auditFilters(url: URL, maxLimit: number) {
  const date = (key: string) => {
    const value = url.searchParams.get(key);
    if (value === null) return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new AdminInputError(`Invalid ${key} date.`);
    return parsed;
  };
  return {
    ...parsePage(url, maxLimit),
    actorUserId: optionalId(url.searchParams.get("actorUserId")),
    action: boundedFilter(url.searchParams.get("action"), 120),
    targetType: boundedFilter(url.searchParams.get("targetType"), 80),
    targetId: boundedFilter(url.searchParams.get("targetId"), 120),
    from: date("from"),
    to: date("to"),
    ipHash: boundedFilter(url.searchParams.get("ipHash"), 64),
  };
}

function csvReply(reply: FastifyReply, request: FastifyRequest, filename: string, csv: string, nextAfter?: number | null) {
  reply
    .code(200)
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${filename}"`)
    .header("cache-control", "no-store")
    .header("x-request-id", request.id);
  if (nextAfter) reply.header("x-next-after", String(nextAfter));
  return reply.send(csv);
}

function params(request: FastifyRequest): Record<string, string> {
  return request.params as Record<string, string>;
}

const createUserSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  department: z.string().trim().min(1).max(120),
  jobTitle: z.string().trim().max(120).optional(),
  role: z.enum(["employee", "back_office", "business_owner"]),
  reason: z.unknown(),
});
const reasonSchema = z.strictObject({ reason: z.unknown() });
const roleSchema = z.strictObject({ role: z.enum(["employee", "back_office", "business_owner"]), reason: z.unknown() });
const activationSchema = z.strictObject({ active: z.boolean(), reason: z.unknown() });
const decisionSchema = z.strictObject({
  action: z.enum(["route", "return", "reject", "defer", "accept", "approve", "not_recommended", "confirm", "start_implementation", "mark_implemented"]),
  reason: z.string().trim().min(1).max(500),
  businessOwnerId: z.number().int().positive().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  controlName: z.string().trim().min(1).max(500).optional(),
});
const feedbackResponseSchema = z.object({ response: z.string().trim().min(1).max(2000) });

export async function registerAdminGovernanceRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/admin/analytics", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.AUDIT_READ)) return;
    return sendEnvelope(reply, request, await getAdminAnalytics());
  }));

  app.get("/api/admin/audit", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.AUDIT_READ)) return;
    return sendEnvelope(reply, request, await listAuditEvents(auditFilters(requestUrl(request), 10)));
  }));

  app.get("/api/admin/audit/export", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.AUDIT_EXPORT)) return;
    const page = await listAuditEvents(auditFilters(requestUrl(request), 1000));
    return csvReply(reply, request, "admin-audit.csv", csvForSafeAudit(page.items), page.nextAfter);
  }));

  app.get("/api/admin/users", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.USERS_READ)) return;
    const url = requestUrl(request);
    return sendEnvelope(reply, request, await listUsers({ ...parsePage(url, 10), q: directoryQuery(url) }));
  }));

  app.post("/api/admin/users", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.USERS_MANAGE);
    if (!actor) return;
    const { reason, ...input } = createUserSchema.parse(request.body);
    const data = await createUser({ userId: actor.userId, sessionId: actor.sessionId }, input, reason, auditMetadata(request));
    return sendEnvelope(reply, request, data, 201);
  }));

  app.get("/api/admin/users/export", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.AUDIT_EXPORT)) return;
    const page = await listUsers(parsePage(requestUrl(request), 1000));
    const headers = ["id", "name", "email", "role", "department", "isActive", "createdAt"];
    const rows = page.items.map((user) => [user.id, user.name, user.email, user.role, user.department, user.isActive, user.createdAt.toISOString()]);
    return csvReply(reply, request, "admin-users.csv", csvForRecords(headers, rows), page.nextAfter);
  }));

  app.get("/api/admin/users/:id", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.USERS_READ)) return;
    return sendEnvelope(reply, request, await getUserDetail(positiveId(params(request).id)));
  }));

  app.patch("/api/admin/users/:id/role", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.USERS_MANAGE);
    if (!actor) return;
    const input = roleSchema.parse(request.body);
    const data = await changeUserRole({ userId: actor.userId, sessionId: actor.sessionId }, positiveId(params(request).id), input.role, input.reason, auditMetadata(request));
    return sendEnvelope(reply, request, data);
  }));

  app.patch("/api/admin/users/:id/activation", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.USERS_MANAGE);
    if (!actor) return;
    const input = activationSchema.parse(request.body);
    const data = await setUserActive({ userId: actor.userId, sessionId: actor.sessionId }, positiveId(params(request).id), input.active, input.reason, auditMetadata(request));
    return sendEnvelope(reply, request, data);
  }));

  app.post("/api/admin/users/:id/password", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.USERS_MANAGE);
    if (!actor) return;
    const input = reasonSchema.parse(request.body);
    const data = await resetUserPassword({ userId: actor.userId, sessionId: actor.sessionId }, positiveId(params(request).id), input.reason, auditMetadata(request));
    return sendEnvelope(reply, request, data);
  }));

  app.post("/api/admin/users/:id/reset", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.USERS_MANAGE);
    if (!actor) return;
    const input = reasonSchema.parse(request.body);
    const data = await resetUserSecurity({ userId: actor.userId, sessionId: actor.sessionId }, positiveId(params(request).id), input.reason, auditMetadata(request));
    return sendEnvelope(reply, request, data);
  }));

  app.get("/api/admin/users/:id/sessions", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.SESSIONS_READ)) return;
    const url = requestUrl(request);
    return sendEnvelope(reply, request, await listUserSessions(positiveId(params(request).id), parsePage(url, 10)));
  }));

  app.delete("/api/admin/users/:id/sessions/:sessionId", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.SESSIONS_REVOKE);
    if (!actor) return;
    const input = reasonSchema.parse(request.body);
    const routeParams = params(request);
    const data = await revokeUserSession({ userId: actor.userId, sessionId: actor.sessionId }, positiveId(routeParams.id), positiveId(routeParams.sessionId), input.reason, auditMetadata(request));
    return sendEnvelope(reply, request, data);
  }));

  app.get("/api/admin/ai/runs", route(async (request, reply) => {
    const actor = await app.requireActor(request, reply);
    if (!actor) return;
    if (actor.role !== "back_office") return sendError(reply, request, "forbidden", "Administrator access required.", 403);
    const runs = db.select({
      id: aiRuns.id, ideaId: aiRuns.ideaId, jobKey: aiRuns.jobKey, jobVersion: aiRuns.jobVersion, model: aiRuns.model,
      status: aiRuns.status, attemptCount: aiRuns.attemptCount, errorCode: aiRuns.errorCode, createdAt: aiRuns.createdAt,
      startedAt: aiRuns.startedAt, completedAt: aiRuns.completedAt,
    }).from(aiRuns).orderBy(desc(aiRuns.createdAt)).limit(100).all();
    return sendEnvelope(reply, request, runs);
  }));

  app.get("/api/admin/governance/evaluations", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.GOVERNANCE_READ);
    if (!actor) return;
    const page = parsePage(requestUrl(request), 100);
    const data = await listRoutedEvaluations({ userId: actor.userId, sessionId: actor.sessionId }, page.limit, page.after);
    return sendEnvelope(reply, request, data);
  }));

  app.get("/api/admin/governance/evaluations/:ideaId", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.GOVERNANCE_READ);
    if (!actor) return;
    const data = await getEvaluation(positiveId(params(request).ideaId), { userId: actor.userId, sessionId: actor.sessionId });
    return sendEnvelope(reply, request, data);
  }));

  app.post("/api/admin/governance/ideas/:ideaId/decision", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.GOVERNANCE_MANAGE);
    if (!actor) return;
    const body = decisionSchema.parse(request.body);
    const dueAt = typeof body.dueAt === "string" ? new Date(body.dueAt) : body.dueAt;
    const data = await decideGovernance(
      { userId: actor.userId, sessionId: actor.sessionId, ipAddress: request.ip ?? null, userAgent: request.headers["user-agent"] ?? null },
      positiveId(params(request).ideaId), body.action, body.reason, body.businessOwnerId, dueAt,
      typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : undefined,
      body.controlName,
    );
    return sendEnvelope(reply, request, data);
  }));

  app.get("/api/admin/governance/owners", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.GOVERNANCE_READ);
    if (!actor) return;
    const page = parsePage(requestUrl(request), 100);
    const data = await listBusinessOwners({ userId: actor.userId, sessionId: actor.sessionId }, page.limit, page.after);
    return sendEnvelope(reply, request, data);
  }));

  app.get("/api/admin/governance/queues/screening", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.GOVERNANCE_READ);
    if (!actor) return;
    await requireGovernanceRole({ userId: actor.userId, sessionId: actor.sessionId }, ["back_office"]);
    const page = parsePage(requestUrl(request), 100);
    return sendEnvelope(reply, request, await listScreeningQueue(page.limit, page.after));
  }));

  app.get("/api/admin/governance/queues/transformation", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.GOVERNANCE_READ);
    if (!actor) return;
    await requireGovernanceRole({ userId: actor.userId, sessionId: actor.sessionId }, ["back_office"]);
    const page = parsePage(requestUrl(request), 100);
    return sendEnvelope(reply, request, await listTransformationQueue(page.limit, page.after));
  }));

  app.get("/api/admin/governance/queues/delivery", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.GOVERNANCE_READ);
    if (!actor) return;
    const page = parsePage(requestUrl(request), 10);
    return sendEnvelope(reply, request, await listDeliveryQueue({ userId: actor.userId, sessionId: actor.sessionId }, page.limit, page.after));
  }));

  app.get("/api/admin/ideas/export", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.AUDIT_EXPORT)) return;
    const page = listIdeaExportRows(parsePage(requestUrl(request), 1000));
    const rows = page.items.map((row) => [row.id, row.reference, row.status, row.priorityBand, row.priorityScore, row.authorId, row.authorName, row.department, row.title, row.summary, row.benefits, row.createdAt.toISOString(), row.updatedAt.toISOString()]);
    return csvReply(reply, request, "admin-ideas.csv", csvForRecords([...IDEAS_EXPORT_HEADERS], rows), page.nextAfter);
  }));

  app.get("/api/admin/feedback", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.SETTINGS_MANAGE)) return;
    return sendEnvelope(reply, request, listAdminFeedbackPage(parsePage(requestUrl(request), 10)));
  }));

  app.get("/api/admin/feedback/export", route(async (request, reply) => {
    if (!await authorizedActor(app, request, reply, CAPABILITIES.AUDIT_EXPORT)) return;
    const page = listFeedbackExportRows(parsePage(requestUrl(request), 1000));
    const rows = page.items.map((row) => [row.id, row.campaignId, row.userId, row.userName, row.department, row.category, row.message, row.response, row.createdAt.toISOString(), row.respondedAt?.toISOString() ?? null]);
    return csvReply(reply, request, "admin-feedback.csv", csvForRecords([...FEEDBACK_EXPORT_HEADERS], rows), page.nextAfter);
  }));

  app.post("/api/admin/feedback/:id/respond", route(async (request, reply) => {
    const actor = await authorizedActor(app, request, reply, CAPABILITIES.SETTINGS_MANAGE);
    if (!actor) return;
    const responseId = positiveId(params(request).id);
    const body = feedbackResponseSchema.parse(request.body);
    const data = await respondToFeedback({ userId: actor.userId, sessionId: actor.sessionId, ...auditMetadata(request), requestId: request.id }, responseId, body.response);
    return sendEnvelope(reply, request, data);
  }));
}
