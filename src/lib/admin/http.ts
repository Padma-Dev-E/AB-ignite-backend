import type { Session } from "next-auth";
import { eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { refreshTokens } from "../../db/schema";
import { assertCapability, loadAuthorizationContext, AuthorizationError } from "../auth/authorization";
import { CAPABILITIES, type Capability } from "../auth/permissions";
import { apiError, handleApiError } from "../http/errors";
import { AdminConflictError, AdminInputError, AdminNotFoundError, boundedFilter, optionalId, parsePage } from "./query";

export async function adminAccess(session: Session | null, capability: Capability) {
  const userId = Number(session?.user?.id);
  const sessionId = Number(session?.user?.sessionId);
  if (!session?.user?.id || session.isValid === false || !Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(sessionId) || sessionId < 1) {
    throw new AdminAuthError();
  }
  let context;
  try { context = await loadAuthorizationContext({ userId, sessionId }); }
  catch { throw new AdminAuthError(); }
  const token = db.select({ expiresAt: refreshTokens.expiresAt }).from(refreshTokens).where(eq(refreshTokens.id, sessionId)).limit(1).get();
  if (!token || token.expiresAt <= new Date()) throw new AdminAuthError();
  return assertCapability(context, capability);
}

class AdminAuthError extends Error {
  readonly status = 401;
  readonly code = "unauthorized";
}

export function adminApiError(error: unknown, requestId: string) {
  if (error instanceof AdminAuthError) return apiError(error.code, "Authentication required.", error.status, requestId);
  if (error instanceof AuthorizationError) return apiError("forbidden", "Administrator access required or session changed.", 403, requestId);
  if (error instanceof AdminInputError || error instanceof AdminNotFoundError || error instanceof AdminConflictError) return apiError(error.code, error.message, error.status, requestId);
  return handleApiError(error, requestId);
}

export function auditFilters(url: URL, maxLimit: number) {
  const date = (key: string) => { const value = url.searchParams.get(key); if (value === null) return null; const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw new AdminInputError(`Invalid ${key} date.`); return parsed; };
  return {
    ...parsePage(url, maxLimit),
    actorUserId: optionalId(url.searchParams.get("actorUserId")),
    action: boundedFilter(url.searchParams.get("action"), 120),
    targetType: boundedFilter(url.searchParams.get("targetType"), 80),
    targetId: boundedFilter(url.searchParams.get("targetId"), 120),
    from: date("from"), to: date("to"), ipHash: boundedFilter(url.searchParams.get("ipHash"), 64),
  };
}

export { CAPABILITIES };
