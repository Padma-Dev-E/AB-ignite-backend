import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { refreshTokens, users } from "../../db/schema";
import { isSessionActive } from "../../auth/security-core";
import { capabilitiesForRole, hasCapability, type Capability, type UserRole } from "./permissions";
import { AuthorizationError, requirePrivilegedReason } from "./authorization-core";

export { AuthorizationError, requirePrivilegedReason } from "./authorization-core";

export type AuthorizationSubject = {
  userId: number | string;
  sessionId?: number | string | null;
  claimedRole?: UserRole;
};

export type AuthorizationContext = {
  userId: number;
  role: UserRole;
  capabilities: readonly Capability[];
  sessionId: number | null;
};

function numericId(value: number | string, label: string) {
  const id = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AuthorizationError(`Invalid ${label}.`);
  return id;
}

export async function loadAuthorizationContext(
  subject: AuthorizationSubject,
  executor: typeof db = db,
): Promise<AuthorizationContext> {
  const userId = numericId(subject.userId, "user id");
  const [user] = executor.select().from(users).where(eq(users.id, userId)).limit(1).all();
  if (!user || !user.isActive) throw new AuthorizationError("Account is not active.");

  let sessionId: number | null = null;
  if (subject.sessionId !== undefined && subject.sessionId !== null) {
    sessionId = numericId(subject.sessionId, "session id");
    const [session] = executor.select().from(refreshTokens).where(and(
      eq(refreshTokens.id, sessionId),
      eq(refreshTokens.userId, user.id),
    )).limit(1).all();
    if (!session || !isSessionActive(session, user)) {
      throw new AuthorizationError("Session is no longer valid.");
    }
  }

  return {
    userId: user.id,
    role: user.role,
    capabilities: capabilitiesForRole(user.role),
    sessionId,
  };
}

export function assertCapability(context: AuthorizationContext, capability: Capability) {
  if (!hasCapability(context.role, capability)) {
    throw new AuthorizationError("You do not have permission to perform this action.");
  }
  return context;
}

export async function requireCapability(
  subject: AuthorizationSubject,
  capability: Capability,
  executor: typeof db = db,
) {
  return assertCapability(await loadAuthorizationContext(subject, executor), capability);
}

export async function requireUserAccess(
  subject: AuthorizationSubject,
  ownerUserId: number,
  capability: Capability,
  executor: typeof db = db,
) {
  const context = await loadAuthorizationContext(subject, executor);
  if (context.userId !== ownerUserId) assertCapability(context, capability);
  return context;
}
