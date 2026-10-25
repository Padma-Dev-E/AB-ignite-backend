import { eq } from "drizzle-orm";
import { encode } from "next-auth/jwt";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { db } from "../../../../src/db/connection.js";
import { refreshTokens, users } from "../../../../src/db/schema.js";
import { accessTokenTtlSeconds, refreshTokenTtlSeconds } from "../../../../src/auth/config.js";
import { createSessionTokenPayload } from "../../../../src/auth/session-token.js";
import { hashRefreshToken, issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from "../../../../src/auth/refresh-core.js";
import { env } from "../config/env.js";
import { resolveActor } from "../plugins/auth.js";

function readCookie(request: FastifyRequest, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0 || item.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(separator + 1).trim()); } catch { return null; }
  }
  return null;
}

function requestMetadata(request: FastifyRequest) {
  return { ipAddress: request.ip ?? null, userAgent: request.headers["user-agent"] ?? null };
}

function cookie(name: string, value: string, options: { expires?: Date; clear?: boolean } = {}) {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.clear) parts.push("Max-Age=0");
  if (env.secureCookies) parts.push("Secure");
  return parts.join("; ");
}

function refreshResponse(reply: import("fastify").FastifyReply, body: unknown, status = 200) {
  return reply.code(status).header("cache-control", "no-store").header("x-request-id", reply.request.id).send(body);
}

export async function registerAuthRefreshRoutes(app: FastifyInstance) {
  app.post("/api/auth/refresh", async (request, reply) => {
    const rawToken = readCookie(request, env.refreshCookieName);
    const actor = await resolveActor(request);
    const cookieSession = rawToken ? db.select({ id: refreshTokens.id, userId: refreshTokens.userId })
      .from(refreshTokens).where(eq(refreshTokens.tokenHash, hashRefreshToken(rawToken))).limit(1).get() : null;
    const currentSessionMatches = Boolean(actor && cookieSession?.id === actor.sessionId && cookieSession.userId === actor.userId);

    if (rawToken && actor && !currentSessionMatches) await revokeRefreshToken(rawToken, "replaced_on_login");
    const result = rawToken && (!actor || currentSessionMatches)
      ? await rotateRefreshToken(rawToken, requestMetadata(request))
      : actor ? await issueRefreshToken(actor.userId, requestMetadata(request)) : null;
    if (!result) return refreshResponse(reply, { ok: false, error: "Refresh token is invalid or expired." }, 401);

    const [user] = db.select().from(users).where(eq(users.id, result.userId ?? actor?.userId ?? 0)).limit(1).all();
    if (!user) return refreshResponse(reply, { ok: false, error: "User no longer exists." }, 401);
    const expiresAt = result.record.absoluteExpiresAt ?? result.record.expiresAt;
    const session = await encode({
      secret: env.authSecret,
      salt: env.sessionCookieName,
      maxAge: refreshTokenTtlSeconds,
      token: createSessionTokenPayload(user, result.record.id, result.record.sessionVersion, Date.now() + accessTokenTtlSeconds * 1000),
    });
    reply.header("set-cookie", [
      cookie(env.refreshCookieName, encodeURIComponent(result.rawToken), { expires: expiresAt }),
      cookie(env.sessionCookieName, session, { expires: expiresAt }),
    ]);
    return refreshResponse(reply, { ok: true, expiresAt });
  });

  app.delete("/api/auth/refresh", async (request, reply) => {
    const rawToken = readCookie(request, env.refreshCookieName);
    if (rawToken) await revokeRefreshToken(rawToken, "logout");
    reply.header("set-cookie", [
      cookie(env.refreshCookieName, "", { clear: true }),
      cookie(env.sessionCookieName, "", { clear: true }),
    ]);
    return refreshResponse(reply, { ok: true });
  });
}
