import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { env } from "../config/env.js";
import { postJson } from "../services/post-json.js";
import { sendEnvelope, sendError } from "../plugins/http.js";

const requestSchema = z.object({
  url: z.string().url().max(2_048),
  body: z.record(z.string(), z.unknown()),
}).strict();

const WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const MAX_REQUEST_BODY_BYTES = 64_000;
const requestWindows = new Map<string, { startedAt: number; count: number }>();

function allowedApigeeUrl(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

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
    if (rateLimited(request.ip)) return sendError(reply, request, "rate_limited", "Please wait a minute before sending another test request.", 429);

    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, request, "validation_error", "Provide a valid URL and a JSON object body.", 400);

    const target = allowedApigeeUrl(env.apigeeUrl);
    if (!target || !env.apigeeClientId) {
      return sendError(reply, request, "apigee_not_configured", "Set APIGEE_URL and APIGEE_CLIENT_ID in the backend environment first.", 503);
    }
    if (parsed.data.url !== target.href && parsed.data.url !== env.apigeeUrl) {
      return sendError(reply, request, "target_not_allowed", "The URL must exactly match the configured APIGEE_URL.", 400);
    }

    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(parsed.data.body);
    } catch {
      return sendError(reply, request, "validation_error", "The request body must be valid JSON.", 400);
    }
    if (Buffer.byteLength(serializedBody, "utf8") > MAX_REQUEST_BODY_BYTES) {
      return sendError(reply, request, "payload_too_large", "The JSON request body must be 64 KB or smaller.", 413);
    }

    try {
      const upstream = await postJson(
        target.href,
        parsed.data.body,
        { client_id: env.apigeeClientId },
        { timeoutMs: 30_000, maxResponseBytes: 128_000 },
      );
      return sendEnvelope(reply, request, {
        request: { method: "POST", url: target.href, headers: { "content-type": "application/json", client_id: "[configured on backend; value hidden]" }, body: parsed.data.body },
        response: upstream,
      });
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      request.log.warn({ requestId: request.id, timedOut }, "Apigee AI test request failed");
      return sendError(reply, request, timedOut ? "upstream_timeout" : "upstream_unavailable", timedOut ? "The Apigee request timed out after 30 seconds." : "The Apigee endpoint could not be reached.", timedOut ? 504 : 502);
    }
  });
}
