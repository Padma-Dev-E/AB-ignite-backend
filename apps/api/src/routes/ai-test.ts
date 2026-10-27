import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { outboundErrorDetails, sendOutboundHttpRequest } from "../services/outbound-http-request.js";

const requestSchema = z.object({
  url: z.string().trim().min(1).max(2_048),
  method: z.string().trim().min(1).max(32).regex(/^[!#$%&'*+.^_`|~0-9A-Z-]+$/i),
  headers: z.array(z.object({
    name: z.string().max(256),
    value: z.string().max(8_192),
  }).strict()).max(100),
  body: z.string().max(64_000),
}).strict();

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;
const requestWindows = new Map<string, { startedAt: number; count: number }>();

function rateLimited(ip: string, now = Date.now()) {
  for (const [key, window] of requestWindows) {
    if (now - window.startedAt >= WINDOW_MS) requestWindows.delete(key);
  }
  const current = requestWindows.get(ip);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    requestWindows.set(ip, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > MAX_REQUESTS_PER_WINDOW;
}

export async function registerAiTestRoutes(app: FastifyInstance) {
  app.post("/api/ai-test", async (request, reply) => {
    const actor = await app.requireActor(request, reply);
    if (!actor) return;
    if (actor.role !== "back_office") {
      return reply.code(403).send({ error: { name: "AuthorizationError", message: "A back-office account is required to send API test requests.", code: "FORBIDDEN" }, requestId: request.id });
    }
    if (rateLimited(`${actor.userId}:${request.ip}`)) {
      return reply.code(429).send({ error: { name: "RateLimitError", message: "Too many test requests. Try again in a minute.", code: "RATE_LIMITED" }, requestId: request.id });
    }

    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { name: "ValidationError", message: parsed.error.message, code: "INVALID_REQUEST" }, requestId: request.id });
    }

    let target: URL;
    try {
      target = new URL(parsed.data.url);
    } catch (error) {
      const details = outboundErrorDetails(error);
      return reply.code(400).send({ error: details, requestId: request.id });
    }
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
      return reply.code(400).send({
        error: { name: "InvalidUrlError", message: "Only HTTP or HTTPS URLs without embedded credentials are supported.", code: "INVALID_URL" },
        requestId: request.id,
      });
    }

    try {
      const response = await sendOutboundHttpRequest({
        url: target,
        method: parsed.data.method.toUpperCase(),
        headers: parsed.data.headers,
        body: parsed.data.body,
      });
      return reply.code(200).header("cache-control", "no-store").send({
        requestId: request.id,
        request: {
          method: parsed.data.method.toUpperCase(),
          url: target.href,
          headers: parsed.data.headers.filter((header) => header.name.trim()),
          body: parsed.data.body,
        },
        response,
      });
    } catch (error) {
      const details = outboundErrorDetails(error);
      const status = details.code === "DESTINATION_BLOCKED" || details.code === "INVALID_HEADER" ? 400
        : details.code === "ETIMEDOUT" ? 504
          : 502;
      request.log.warn({ requestId: request.id, errorName: details.name, errorCode: details.code }, "AI test outbound request failed");
      return reply.code(status).header("cache-control", "no-store").send({ error: details, requestId: request.id });
    }
  });
}
