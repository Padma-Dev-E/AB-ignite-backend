import { and, eq } from "drizzle-orm";
import { decode } from "next-auth/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../../../src/db/connection.js";
import { refreshTokens, users } from "../../../../src/db/schema.js";
import { isSessionActive } from "../../../../src/auth/security-core.js";
import { env } from "../config/env.js";
import type { ApiActor } from "../types.js";

declare module "fastify" {
  interface FastifyRequest {
    actor: ApiActor | null;
  }
  interface FastifyInstance {
    requireActor(request: FastifyRequest, reply: FastifyReply): Promise<ApiActor | null>;
  }
}

function readSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  const cookies = new Map<string, string>();
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  const decodeCookie = (value: string) => {
    try { return decodeURIComponent(value); } catch { return null; }
  };
  const direct = cookies.get(env.sessionCookieName);
  if (direct) return decodeCookie(direct);
  const chunks = Array.from(cookies.entries())
    .map(([key, value]) => {
      const escapedName = env.sessionCookieName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = key.match(new RegExp(`^${escapedName}\\.(\\d+)$`));
      return match ? { index: Number(match[1]), value } : null;
    })
    .filter((item): item is { index: number; value: string } => item !== null)
    .sort((left, right) => left.index - right.index);
  return chunks.length ? decodeCookie(chunks.map((chunk) => chunk.value).join("")) : null;
}

export async function resolveActor(request: FastifyRequest): Promise<ApiActor | null> {
  const rawCookie = readSessionCookie(request.headers.cookie);
  if (!rawCookie) return null;
  let token: Record<string, unknown> | null;
  try {
    token = await decode({ token: rawCookie, secret: env.authSecret, salt: env.sessionCookieName });
  } catch {
    return null;
  }
  if (!token?.sub || !token.sessionId) return null;
  const userId = Number(token.sub);
  const sessionId = Number(token.sessionId);
  if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(sessionId) || sessionId <= 0) return null;

  const [user] = db.select().from(users).where(eq(users.id, userId)).limit(1).all();
  const [session] = db.select().from(refreshTokens)
    .where(and(eq(refreshTokens.id, sessionId), eq(refreshTokens.userId, userId))).limit(1).all();
  if (!user || !session || session.expiresAt <= new Date() || user.email.endsWith("@demo.abignite.invalid") || !isSessionActive(session, user)) return null;
  if (Number(token.sessionVersion) !== user.sessionVersion) return null;

  return {
    userId: user.id,
    sessionId: session.id,
    role: user.role,
    name: user.name,
    email: user.email,
    mustChangePassword: user.mustChangePassword,
    sessionVersion: user.sessionVersion,
  };
}

export function registerAuth(app: import("fastify").FastifyInstance) {
  app.decorateRequest("actor", null);
  app.decorate("requireActor", async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = request.actor ?? await resolveActor(request);
    if (!actor) {
      await reply.code(401).send({ data: null, error: { code: "unauthorized", message: "Authentication required." }, requestId: request.id });
      return null;
    }
    if (actor.mustChangePassword && request.url.split("?", 1)[0] !== "/api/account/password") {
      await reply.code(403).send({ data: null, error: { code: "PASSWORD_CHANGE_REQUIRED", message: "Change your password before continuing." }, requestId: request.id });
      return null;
    }
    request.actor = actor;
    return actor;
  });
}
