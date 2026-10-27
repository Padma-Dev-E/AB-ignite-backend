import type { FastifyInstance } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "../../../../src/db/connection.js";
import { env } from "../config/env.js";

function hasInternalToken(request: import("fastify").FastifyRequest) {
  const supplied = request.headers["x-internal-api-token"];
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(env.internalApiToken);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function hasMatchingSessionConfiguration(request: import("fastify").FastifyRequest) {
  const suppliedProof = request.headers["x-auth-config-proof"];
  const suppliedCookieName = request.headers["x-session-cookie-name"];
  if (typeof suppliedProof !== "string" || typeof suppliedCookieName !== "string") return false;
  const expectedProof = createHmac("sha256", env.authSecret).update("ab-ignite-session-config-check-v1").digest();
  const suppliedBytes = Buffer.from(suppliedProof, "hex");
  return suppliedCookieName === env.sessionCookieName
    && suppliedBytes.length === expectedProof.length
    && timingSafeEqual(suppliedBytes, expectedProof);
}

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health/live", async (_request, reply) => reply.code(200).send({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      db.$client.prepare("SELECT 1").get();
      return reply.code(200).send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  app.get("/internal/health", async (request, reply) => {
    if (!hasInternalToken(request)) return reply.code(404).send({ error: "Not found." });
    if (!hasMatchingSessionConfiguration(request)) return reply.code(409).send({ error: "Session configuration mismatch." });
    return reply.code(200).send({ status: "ready" });
  });
}
