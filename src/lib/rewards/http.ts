import type { Session } from "next-auth";
import {
  loadAuthorizationContext,
  assertCapability,
  AuthorizationError,
} from "../auth/authorization";
import { CAPABILITIES } from "../auth/permissions";
import { apiError, handleApiError } from "../http/errors";
import { RewardsError } from "./errors";

function sessionIds(session: Session | null) {
  const userId = Number(session?.user?.id);
  const sessionId = Number(session?.user?.sessionId);
  if (
    !session?.user?.id ||
    session.isValid === false ||
    !Number.isInteger(userId) ||
    userId < 1 ||
    !Number.isInteger(sessionId) ||
    sessionId < 1
  )
    return null;
  return { userId, sessionId };
}

export async function employeeContext(session: Session | null) {
  const ids = sessionIds(session);
  if (!ids)
    throw new RewardsError("Authentication required.", "UNAUTHORIZED", 401);
  try {
    return await loadAuthorizationContext({
      userId: ids.userId,
      sessionId: ids.sessionId,
    });
  } catch {
    throw new RewardsError("Authentication required.", "UNAUTHORIZED", 401);
  }
}

export async function adminContext(session: Session | null) {
  const context = await employeeContext(session);
  return assertCapability(context, CAPABILITIES.SETTINGS_MANAGE);
}

export function rewardApiError(error: unknown, requestId: string) {
  if (error instanceof RewardsError)
    return apiError(
      error.code.toLowerCase(),
      error.message,
      error.status,
      requestId,
    );
  if (error instanceof AuthorizationError)
    return apiError(
      "forbidden",
      "You do not have permission to perform this action.",
      403,
      requestId,
    );
  return handleApiError(error, requestId);
}

export function idempotencyKey(request: Request, bodyValue?: unknown) {
  const header = request.headers.get("idempotency-key")?.trim();
  if (header) return header;
  return typeof bodyValue === "string" ? bodyValue.trim() : "";
}

export function requestAuditMetadata(request: Request) {
  return {
    ipAddress:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  };
}
