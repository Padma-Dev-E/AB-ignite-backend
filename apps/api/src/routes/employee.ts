import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../../../src/db/connection.js";
import { pointsLedger, users } from "../../../../src/db/schema.js";
import { changePassword, PasswordError } from "../../../../src/features/account/password-service.js";
import { AuthorizationError } from "../../../../src/lib/auth/authorization-core.js";
import { LibraryError, type RequestContext as LibraryContext, articleInsight, completeArticle, getFeedback, getLibraryArticle, listLibrary, submitFeedback } from "../../../../src/lib/articles/service.js";
import { AiIdempotencyError, AiPolicyError, AiProviderError, AiSchemaValidationError, AiTimeoutError } from "../../../../src/lib/ai/errors.js";
import { listNotifications, setNotificationRead, getPublishedAnnouncement } from "../../../../src/lib/notifications/service.js";
import { QuizError } from "../../../../src/lib/quizzes/errors.js";
import { idempotencySchema, rankingScopeSchema, submitAnswersSchema } from "../../../../src/lib/quizzes/schemas.js";
import { getJourney, getQuizAttempt, getQuizDetails, getRankings, joinChallenge, listChallenges, listQuizCatalogue, startQuizAttempt, submitQuizAttempt } from "../../../../src/lib/quizzes/service.js";
import { RewardsError } from "../../../../src/lib/rewards/errors.js";
import { getBadgeProgress, getEmployeePointsSummary, getEmployeeRewards } from "../../../../src/lib/rewards/service.js";
import { sendEnvelope, sendError } from "../plugins/http.js";
import type { ApiActor } from "../types.js";

const profileUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120).optional(),
  department: z.string().trim().min(1).max(120).optional(),
  jobTitle: z.string().trim().max(120).nullable().optional(),
});

const articleReadSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(200).optional() });
const articleInsightSchema = z.object({ recommendationId: z.number().int().positive() });
const feedbackSchema = z.object({
  category: z.enum(["experience", "ideas", "content", "technical", "other"]),
  message: z.string().trim().min(1).max(4000),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});
const notificationQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z.enum(["true", "false"]).transform((value) => value === "true").default(false),
  cursor: z.string().min(1).max(200).optional(),
});
const notificationUpdateSchema = z.strictObject({
  id: z.number().int().positive().optional(),
  read: z.boolean().default(true),
  all: z.boolean().default(false),
}).refine((value) => Boolean(value.id) !== value.all);

type EmployeeRouteRequest = FastifyRequest & { actor: ApiActor | null };
type EmployeeApi = FastifyInstance & {
  requireActor(request: FastifyRequest, reply: FastifyReply): Promise<ApiActor | null>;
};

function actorContext(actor: ApiActor, request: FastifyRequest): LibraryContext {
  const userAgent = request.headers["user-agent"];
  return {
    userId: actor.userId,
    sessionId: actor.sessionId,
    // Fastify derives request.ip from forwarded headers only when the configured
    // trusted-proxy boundary permits it.
    ipAddress: request.ip || null,
    userAgent: typeof userAgent === "string" ? userAgent : Array.isArray(userAgent) ? userAgent[0] ?? null : null,
    requestId: request.id,
  };
}

function pathId(request: FastifyRequest): string {
  const params = request.params as { id?: string } | undefined;
  return params?.id ?? "";
}

function positiveIntegerParam(request: FastifyRequest): number {
  return Number(pathId(request));
}

function idempotencyHeader(request: FastifyRequest): string {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" ? key.trim() : "";
}

function bodyObject(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
}

function webUrl(request: FastifyRequest): URL {
  return new URL(request.url, `${request.protocol}://${request.headers.host ?? "localhost"}`);
}

function isZodError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}

function sendLibraryError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof LibraryError) return sendError(reply, request, error.code.toLowerCase(), error.message, error.status);
  if (error instanceof AuthorizationError) return sendError(reply, request, "forbidden", "You do not have permission to perform this action.", 403);
  return sendCommonError(reply, request, error);
}

function sendQuizError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof QuizError) {
    if (error.status >= 500) return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
    return sendError(reply, request, error.code.toLowerCase(), error.message, error.status);
  }
  if (error instanceof AuthorizationError) return sendError(reply, request, "forbidden", "You do not have permission to perform this action.", 403);
  return sendCommonError(reply, request, error);
}

function sendRewardError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof RewardsError) return sendError(reply, request, error.code.toLowerCase(), error.message, error.status);
  if (error instanceof AuthorizationError) return sendError(reply, request, "forbidden", "You do not have permission to perform this action.", 403);
  return sendCommonError(reply, request, error);
}

function sendCommonError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (isZodError(error) || error instanceof AiSchemaValidationError) {
    return sendError(reply, request, "validation_error", "The request could not be validated.", 400);
  }
  if (error instanceof AiPolicyError) return sendError(reply, request, "policy_blocked", "This request requires human review.", 422);
  if (error instanceof AiIdempotencyError) return sendError(reply, request, "conflict", "This request is already being processed.", 409);
  if (error instanceof AiProviderError || error instanceof AiTimeoutError) {
    return sendError(reply, request, "provider_unavailable", "The AI service is temporarily unavailable.", 502);
  }
  request.log.error({ err: error }, "Employee API request failed");
  return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
}

async function requireActor(app: FastifyInstance, request: EmployeeRouteRequest, reply: FastifyReply) {
  return (app as EmployeeApi).requireActor(request, reply);
}

function safeUser(user: typeof users.$inferSelect) {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export async function registerEmployeeRoutes(app: FastifyInstance): Promise<void> {
  // Account password and profile
  app.post("/api/account/password", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    const origin = request.headers.origin;
    const sameOrigin = Boolean(origin && origin === `${request.protocol}://${request.hostname}`);
    if ((origin && !sameOrigin) || request.headers["sec-fetch-site"] === "cross-site") {
      return sendError(reply, request, "forbidden", "Cross-origin request refused.", 403);
    }
    const contentType = request.headers["content-type"];
    if (typeof contentType !== "string" || !contentType.includes("application/json")) {
      return sendError(reply, request, "validation_error", "JSON is required.", 415);
    }
    try {
      return sendEnvelope(reply, request, await changePassword(actorContext(actor, request), request.body), 200);
    } catch (error) {
      if (error instanceof PasswordError) return sendError(reply, request, "password_change_failed", error.message, error.status);
      return sendCommonError(reply, request, error);
    }
  });

  app.get("/api/account/password/statement", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    const page = Math.max(1, Math.min(100000, Number(webUrl(request).searchParams.get("page")) || 1));
    try {
      const rows = db.select({ id: pointsLedger.id, amount: pointsLedger.amount, activity: pointsLedger.eventType, createdAt: pointsLedger.createdAt })
        .from(pointsLedger)
        .where(eq(pointsLedger.userId, actor.userId))
        .orderBy(desc(pointsLedger.createdAt), desc(pointsLedger.id))
        .limit(21)
        .offset((Math.floor(page) - 1) * 20)
        .all();
      return sendEnvelope(reply, request, { items: rows.slice(0, 20), hasMore: rows.length > 20 }, 200);
    } catch (error) {
      return sendCommonError(reply, request, error);
    }
  });

  const getProfile = async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const [user] = db.select().from(users).where(eq(users.id, actor.userId)).limit(1).all();
      if (!user) return sendError(reply, request, "unauthorized", "Authentication required.", 401);
      return sendEnvelope(reply, request, safeUser(user), 200);
    } catch (error) {
      return sendCommonError(reply, request, error);
    }
  };

  const patchProfile = async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const input = profileUpdateSchema.parse(request.body);
      if (!Object.keys(input).length) return sendError(reply, request, "validation_error", "At least one profile field is required.", 400);
      const [user] = db.update(users).set({ ...input, updatedAt: new Date() }).where(eq(users.id, actor.userId)).returning().all();
      if (!user) return sendError(reply, request, "unauthorized", "Authentication required.", 401);
      return sendEnvelope(reply, request, safeUser(user), 200);
    } catch (error) {
      return sendCommonError(reply, request, error);
    }
  };

  app.get("/api/profile", getProfile);
  app.patch("/api/profile", patchProfile);
  // Preserve the existing account-profile aliases.
  app.get("/api/account/profile", getProfile);
  app.patch("/api/account/profile", patchProfile);

  // Articles and employee feedback
  app.get("/api/articles", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    const url = webUrl(request);
    const category = url.searchParams.get("category")?.slice(0, 60) || undefined;
    try {
      return sendEnvelope(reply, request, await listLibrary(actor.userId, category, url.searchParams.get("view") === "recommended"), 200);
    } catch (error) {
      return sendLibraryError(reply, request, error);
    }
  });

  app.get("/api/articles/:id", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    const articleId = positiveIntegerParam(request);
    try {
      if (!Number.isInteger(articleId) || articleId < 1) throw new LibraryError("Invalid article id.", "VALIDATION_ERROR", 400);
      return sendEnvelope(reply, request, await getLibraryArticle(articleId, actor.userId), 200);
    } catch (error) {
      return sendLibraryError(reply, request, error);
    }
  });

  app.post("/api/articles/:id/read", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    const articleId = positiveIntegerParam(request);
    try {
      if (!Number.isInteger(articleId) || articleId < 1) throw new LibraryError("Invalid article id.", "VALIDATION_ERROR", 400);
      const body = articleReadSchema.parse(request.body);
      const key = idempotencyHeader(request) || body.idempotencyKey;
      if (!key) throw new LibraryError("An idempotency key is required.", "VALIDATION_ERROR", 400);
      return sendEnvelope(reply, request, await completeArticle(actorContext(actor, request), articleId, key), 200);
    } catch (error) {
      return sendLibraryError(reply, request, error);
    }
  });

  app.post("/api/articles/:id/insight", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    const articleId = positiveIntegerParam(request);
    try {
      if (!Number.isInteger(articleId) || articleId < 1) throw new LibraryError("Invalid article id.", "VALIDATION_ERROR", 400);
      const body = articleInsightSchema.parse(request.body);
      return sendEnvelope(reply, request, await articleInsight(actorContext(actor, request), articleId, body.recommendationId), 200);
    } catch (error) {
      return sendLibraryError(reply, request, error);
    }
  });

  app.get("/api/feedback", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, await getFeedback(actor.userId), 200);
    } catch (error) {
      return sendLibraryError(reply, request, error);
    }
  });

  app.post("/api/feedback", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const body = feedbackSchema.parse(request.body);
      const key = idempotencyHeader(request) || body.idempotencyKey;
      if (!key) throw new LibraryError("An idempotency key is required.", "VALIDATION_ERROR", 400);
      return sendEnvelope(reply, request, await submitFeedback(actorContext(actor, request), { ...body, idempotencyKey: key }), 201);
    } catch (error) {
      return sendLibraryError(reply, request, error);
    }
  });

  // Quizzes, attempts, learning journey and challenges
  app.get("/api/quizzes", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, { items: await listQuizCatalogue(actor.userId) }, 200);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.get("/api/quizzes/:id", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const quiz = await getQuizDetails(positiveIntegerParam(request));
      if (!quiz) return sendError(reply, request, "not_found", "Quiz not found.", 404);
      return sendEnvelope(reply, request, quiz, 200);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.post("/api/quizzes/:id/attempts", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const body = bodyObject(request.body);
      const key = idempotencySchema.parse(idempotencyHeader(request) || body.idempotencyKey);
      const metadata = actorContext(actor, request);
      return sendEnvelope(reply, request, await startQuizAttempt(actor.userId, positiveIntegerParam(request), key, new Date(), {
        sessionId: actor.sessionId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        requestId: request.id,
      }), 201);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.get("/api/quizzes/attempts/:id", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, await getQuizAttempt(actor.userId, positiveIntegerParam(request)), 200);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.post("/api/quizzes/attempts/:id/submit", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const input = submitAnswersSchema.parse(request.body);
      const metadata = actorContext(actor, request);
      return sendEnvelope(reply, request, await submitQuizAttempt(actor.userId, positiveIntegerParam(request), input.answers, new Date(), {
        sessionId: actor.sessionId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        requestId: request.id,
      }), 200);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.get("/api/quizzes/journey", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, await getJourney(actor.userId), 200);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.get("/api/quizzes/rankings", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const scope = rankingScopeSchema.parse(webUrl(request).searchParams.get("scope") ?? "bank");
      return sendEnvelope(reply, request, { scope, items: await getRankings(actor.userId, scope) }, 200);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.get("/api/challenges", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, { items: await listChallenges(actor.userId) }, 200);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  app.post("/api/challenges/:id/join", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const body = bodyObject(request.body);
      const key = idempotencySchema.parse(idempotencyHeader(request) || body.idempotencyKey);
      const metadata = actorContext(actor, request);
      return sendEnvelope(reply, request, await joinChallenge(actor.userId, positiveIntegerParam(request), key, new Date(), {
        sessionId: actor.sessionId,
        ipAddress: metadata.ipAddress,
        userAgent: metadata.userAgent,
        requestId: request.id,
      }), 201);
    } catch (error) {
      return sendQuizError(reply, request, error);
    }
  });

  // Notifications and announcement aliases
  app.get("/api/notifications", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const query = notificationQuerySchema.parse(Object.fromEntries(webUrl(request).searchParams.entries()));
      try {
        return sendEnvelope(reply, request, listNotifications(actor.userId, query), 200);
      } catch (error) {
        if (error instanceof Error && error.message === "Invalid notification cursor.") {
          return sendError(reply, request, "validation_error", "Invalid notification cursor.", 400);
        }
        throw error;
      }
    } catch (error) {
      return sendCommonError(reply, request, error);
    }
  });

  app.patch("/api/notifications", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      const input = notificationUpdateSchema.parse(request.body);
      if (!setNotificationRead(actor.userId, input)) return sendError(reply, request, "not_found", "Notification not found.", 404);
      return sendEnvelope(reply, request, { updated: true }, 200);
    } catch (error) {
      return sendCommonError(reply, request, error);
    }
  });

  const getAnnouncement = async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    const rawId = pathId(request);
    if (!/^[1-9]\d*$/.test(rawId)) return sendError(reply, request, "validation_error", "Invalid announcement ID.", 400);
    const announcement = getPublishedAnnouncement(Number(rawId));
    if (!announcement) return sendError(reply, request, "not_found", "Announcement not found.", 404);
    return sendEnvelope(reply, request, announcement, 200);
  };
  app.get("/api/notifications/announcements/:id", getAnnouncement);
  app.get("/api/announcements/:id", getAnnouncement);

  // Points and rewards
  app.get("/api/points/summary", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, await getEmployeePointsSummary(actor.userId), 200);
    } catch (error) {
      return sendRewardError(reply, request, error);
    }
  });

  app.get("/api/rewards", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, await getEmployeeRewards(actor.userId), 200);
    } catch (error) {
      return sendRewardError(reply, request, error);
    }
  });

  app.get("/api/rewards/badges", async (request, reply) => {
    const actor = await requireActor(app, request as EmployeeRouteRequest, reply);
    if (!actor) return;
    try {
      return sendEnvelope(reply, request, await getBadgeProgress(actor.userId), 200);
    } catch (error) {
      return sendRewardError(reply, request, error);
    }
  });
}
