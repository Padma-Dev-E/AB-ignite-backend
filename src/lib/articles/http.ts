import type { Session } from "next-auth";
import { loadAuthorizationContext, assertCapability, AuthorizationError } from "../auth/authorization";
import { CAPABILITIES } from "../auth/permissions";
import { apiError, handleApiError } from "../http/errors";
import { LibraryError, type RequestContext } from "./service";
export async function libraryContext(session: Session | null, request: Request, requestId: string): Promise<RequestContext> {
  const userId = Number(session?.user?.id), sessionId = Number(session?.user?.sessionId);
  if (!session?.user?.id || session.isValid === false || !Number.isInteger(userId) || userId < 1 || !Number.isInteger(sessionId) || sessionId < 1) throw new LibraryError("Authentication required.", "UNAUTHORIZED", 401);
  try {
    const context = await loadAuthorizationContext({ userId, sessionId });
    return { userId: context.userId, sessionId, ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request.headers.get("x-real-ip"), userAgent: request.headers.get("user-agent"), requestId };
  } catch { throw new LibraryError("Authentication required.", "UNAUTHORIZED", 401); }
}
export async function feedbackAdmin(session: Session | null, request: Request, requestId: string) {
  const context = await libraryContext(session, request, requestId);
  try { assertCapability(await loadAuthorizationContext({ userId: context.userId, sessionId: context.sessionId }), CAPABILITIES.SETTINGS_MANAGE); return context; }
  catch (error) { if (error instanceof AuthorizationError) throw error; throw new LibraryError("Authentication required.", "UNAUTHORIZED", 401); }
}
export function libraryApiError(error: unknown, id: string) {
  if (error instanceof LibraryError) return apiError(error.code.toLowerCase(), error.message, error.status, id);
  if (error instanceof AuthorizationError) return apiError("forbidden", "You do not have permission to perform this action.", 403, id);
  return handleApiError(error, id);
}
