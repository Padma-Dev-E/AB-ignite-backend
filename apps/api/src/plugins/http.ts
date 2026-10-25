import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AiIdempotencyError, AiPolicyError, AiProviderError, AiSchemaValidationError, AiTimeoutError } from "../../../../src/lib/ai/errors.js";
import { env } from "../config/env.js";
import type { ApiEnvelope } from "../types.js";

export function sendEnvelope<T>(reply: FastifyReply, request: FastifyRequest, data: T, status = 200) {
  const requestId = typeof request.id === "string" ? request.id : randomUUID();
  return reply.code(status).header("x-request-id", requestId).header("cache-control", "no-store")
    .send({ data, error: null, requestId } satisfies ApiEnvelope<T>);
}

export function sendError(reply: FastifyReply, request: FastifyRequest, code: string, message: string, status: number) {
  const requestId = typeof request.id === "string" ? request.id : randomUUID();
  return reply.code(status).header("x-request-id", requestId).header("cache-control", "no-store")
    .send({ data: null, error: { code, message }, requestId } satisfies ApiEnvelope<never>);
}

export function registerHttp(app: FastifyInstance) {
  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id).header("cache-control", "no-store");
  });
  app.addHook("preHandler", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    const origin = request.headers.origin;
    if (!origin) return;
    let requestOrigin = "";
    try {
      if (request.headers.host) requestOrigin = new URL(`${request.protocol}://${request.headers.host}`).origin;
    } catch {
      requestOrigin = "";
    }
    if (origin === requestOrigin || env.allowedOrigins.includes(origin)) return;
    return sendError(reply, request, "forbidden_origin", "Cross-origin requests are not allowed.", 403);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError || error instanceof AiSchemaValidationError) return sendError(reply, request, "validation_error", "The request could not be validated.", 400);
    if (error instanceof AiPolicyError) return sendError(reply, request, "policy_blocked", "This request requires human review.", 422);
    if (error instanceof AiIdempotencyError) return sendError(reply, request, "conflict", "This request is already being processed.", 409);
    if (error instanceof AiProviderError || error instanceof AiTimeoutError) return sendError(reply, request, "provider_unavailable", "The AI service is temporarily unavailable.", 502);
    request.log.error({ err: error }, "API request failed");
    return sendError(reply, request, "internal_error", "An unexpected server error occurred.", 500);
  });
}
