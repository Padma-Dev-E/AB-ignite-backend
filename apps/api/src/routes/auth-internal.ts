import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../../../src/db/connection.js";
import { users } from "../../../../src/db/schema.js";
import { authorizeCredentialLogin } from "../../../../src/auth/credentials-login.js";
import { nextLoginFailure, successfulLoginState } from "../../../../src/auth/security-core.js";
import { verifyPassword } from "../../../../src/auth/password.js";
import { issueRefreshToken } from "../../../../src/auth/refresh-core.js";
import { appendAuditEvent } from "../../../../src/lib/audit/service.js";
import { env } from "../config/env.js";
import { resolveActor } from "../plugins/auth.js";

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(1024),
}).strict();

function hasInternalToken(request: FastifyRequest) {
  const supplied = request.headers["x-internal-api-token"];
  if (typeof supplied !== "string") return false;
  const expectedBytes = Buffer.from(env.internalApiToken);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function recordLoginFailure(userId: number, now: Date) {
  return db.transaction((tx) => {
    const [current] = tx.select().from(users).where(eq(users.id, userId)).limit(1).all();
    if (!current) return null;
    const next = nextLoginFailure(current, now);
    tx.update(users).set({
      failedLoginAttempts: next.failedLoginAttempts,
      lockedUntil: next.lockedUntil,
      lastFailedLoginAt: now,
      lastSeenAt: now,
      updatedAt: now,
    }).where(eq(users.id, userId)).run();
    return next;
  });
}

function recordLoginSuccess(userId: number, now: Date) {
  const state = successfulLoginState(now);
  db.update(users).set({
    failedLoginAttempts: state.failedLoginAttempts,
    lockedUntil: state.lockedUntil,
    lastLoginAt: state.lastLoginAt,
    lastSeenAt: now,
    updatedAt: now,
  }).where(eq(users.id, userId)).run();
}

export async function registerInternalAuthRoutes(app: FastifyInstance) {
  app.post("/internal/auth/credentials", async (request, reply) => {
    if (!hasInternalToken(request)) return reply.code(404).send({ error: "Not found." });
    const parsed = credentialsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(401).send({ error: "Invalid email or password." });

    const user = await authorizeCredentialLogin(parsed.data, new Request("http://api.internal/auth", {
      headers: {
        ...(request.headers["user-agent"] ? { "user-agent": request.headers["user-agent"] } : {}),
        ...(request.ip ? { "x-real-ip": request.ip } : {}),
      },
    }), {
      async findUser(email) {
        const [found] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        return found ?? null;
      },
      verifyPassword,
      recordLoginFailure,
      recordLoginSuccess,
      issueSession: issueRefreshToken,
      appendAudit: appendAuditEvent,
    });

    if (!user) return reply.code(401).send({ error: "Invalid email or password." });
    return reply.header("cache-control", "no-store").send({ user });
  });

  app.get("/internal/auth/session", async (request, reply) => {
    if (!hasInternalToken(request)) return reply.code(404).send({ error: "Not found." });
    const actor = await resolveActor(request);
    if (!actor) return reply.code(401).send({ error: "Session is invalid." });
    return reply.header("cache-control", "no-store").send({ user: actor });
  });
}
