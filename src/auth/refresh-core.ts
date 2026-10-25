import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../db/connection";
import { refreshTokens, users } from "../db/schema";
import { hashAuditValue } from "../lib/audit/redaction-core";
import { isSessionActive, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS } from "./security-core";
import { demoSessionSeconds, refreshTokenTtlSeconds } from "./config";

export function hashRefreshToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function newRawToken() {
  return randomBytes(32).toString("base64url");
}

const isDemo = (email: string) => email.endsWith("@demo.abignite.invalid");

export type RefreshMetadata = { userAgent?: string | null; ipAddress?: string | null };

function insertRefreshToken(
  executor: typeof db,
  userId: number,
  sessionVersion: number,
  now: Date,
  rotatedFromId: number | null,
  metadata?: RefreshMetadata,
  absoluteExpiresAt?: Date,
) {
  const [user] = executor.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1).all();
  if (!user) throw new Error("Session user no longer exists");
  const demo = isDemo(user.email);
  const ttlMs = (demo ? demoSessionSeconds : refreshTokenTtlSeconds) * 1000;
  const boundedAbsoluteExpiresAt = absoluteExpiresAt ?? new Date(now.getTime() + (demo ? ttlMs : SESSION_ABSOLUTE_MS));
  const rawToken = newRawToken();
  const idleExpiresAt = new Date(Math.min(now.getTime() + (demo ? ttlMs : SESSION_IDLE_MS), boundedAbsoluteExpiresAt.getTime()));
  const [record] = executor.insert(refreshTokens).values({
    userId,
    tokenHash: hashRefreshToken(rawToken),
    expiresAt: new Date(Math.min(now.getTime() + ttlMs, boundedAbsoluteExpiresAt.getTime())),
    idleExpiresAt,
    absoluteExpiresAt: boundedAbsoluteExpiresAt,
    ipHash: hashAuditValue(metadata?.ipAddress),
    userAgentHash: hashAuditValue(metadata?.userAgent),
    lastSeenAt: now,
    sessionVersion,
    rotatedFromId,
  }).returning({
    id: refreshTokens.id,
    expiresAt: refreshTokens.expiresAt,
    idleExpiresAt: refreshTokens.idleExpiresAt,
    absoluteExpiresAt: refreshTokens.absoluteExpiresAt,
    sessionVersion: refreshTokens.sessionVersion,
  }).all();
  return { rawToken, record };
}

function refreshSessionIsActive(session: typeof refreshTokens.$inferSelect, user: typeof users.$inferSelect, now: Date) {
  return session.expiresAt.getTime() > now.getTime() && isSessionActive(session, user, now);
}

export async function issueRefreshToken(userId: number, metadata?: RefreshMetadata) {
  const now = new Date();
  const [user] = db.select().from(users).where(and(eq(users.id, userId), eq(users.isActive, true))).limit(1).all();
  if (!user || isDemo(user.email)) return null;
  return { userId, ...insertRefreshToken(db, user.id, user.sessionVersion, now, null, metadata) };
}

export async function rotateRefreshToken(rawToken: string, metadata?: RefreshMetadata) {
  const now = new Date();
  return db.transaction((tx) => {
    const [current] = tx.select().from(refreshTokens).where(and(
      eq(refreshTokens.tokenHash, hashRefreshToken(rawToken)),
      isNull(refreshTokens.revokedAt),
      gt(refreshTokens.expiresAt, now),
    )).limit(1).all();
    if (!current) return null;
    const [user] = tx.select().from(users).where(eq(users.id, current.userId)).limit(1).all();
    if (!user || isDemo(user.email) || !refreshSessionIsActive(current, user, now)) return null;

    tx.update(refreshTokens).set({
      revokedAt: now,
      revocationReason: "rotated",
      lastSeenAt: now,
      updatedAt: now,
    }).where(eq(refreshTokens.id, current.id)).run();
    return {
      userId: current.userId,
      ...insertRefreshToken(tx as unknown as typeof db, current.userId, user.sessionVersion, now, current.id, metadata, current.absoluteExpiresAt ?? undefined),
    };
  });
}

export async function revokeRefreshToken(rawToken: string, reason = "logout") {
  const now = new Date();
  return db.update(refreshTokens).set({
    revokedAt: now,
    revocationReason: reason.slice(0, 120),
    updatedAt: now,
  }).where(and(
    eq(refreshTokens.tokenHash, hashRefreshToken(rawToken)),
    isNull(refreshTokens.revokedAt),
  )).run();
}

export function revokeSession(sessionId: number, reason: string) {
  const now = new Date();
  return db.update(refreshTokens).set({
    revokedAt: now,
    revocationReason: reason.slice(0, 120),
    updatedAt: now,
  }).where(and(eq(refreshTokens.id, sessionId), isNull(refreshTokens.revokedAt))).run();
}

export function revokeAllUserSessions(userId: number, reason: string) {
  const now = new Date();
  return db.transaction((tx) => {
    tx.update(users).set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, userId)).run();
    return tx.update(refreshTokens).set({
      revokedAt: now,
      revocationReason: reason.slice(0, 120),
      updatedAt: now,
    }).where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt))).run();
  });
}
