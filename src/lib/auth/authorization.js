import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { refreshTokens, users } from "../../db/schema";
import { isSessionActive } from "../../auth/security-core";
import { capabilitiesForRole, hasCapability } from "./permissions";
import { AuthorizationError } from "./authorization-core";
export { AuthorizationError, requirePrivilegedReason } from "./authorization-core";
function numericId(value, label) {
    const id = typeof value === "number" ? value : Number(value);
    if (!Number.isInteger(id) || id <= 0)
        throw new AuthorizationError(`Invalid ${label}.`);
    return id;
}
export async function loadAuthorizationContext(subject, executor = db) {
    const userId = numericId(subject.userId, "user id");
    const [user] = executor.select().from(users).where(eq(users.id, userId)).limit(1).all();
    if (!user || !user.isActive)
        throw new AuthorizationError("Account is not active.");
    let sessionId = null;
    if (subject.sessionId !== undefined && subject.sessionId !== null) {
        sessionId = numericId(subject.sessionId, "session id");
        const [session] = executor.select().from(refreshTokens).where(and(eq(refreshTokens.id, sessionId), eq(refreshTokens.userId, user.id))).limit(1).all();
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
export function assertCapability(context, capability) {
    if (!hasCapability(context.role, capability)) {
        throw new AuthorizationError("You do not have permission to perform this action.");
    }
    return context;
}
export async function requireCapability(subject, capability, executor = db) {
    return assertCapability(await loadAuthorizationContext(subject, executor), capability);
}
export async function requireUserAccess(subject, ownerUserId, capability, executor = db) {
    const context = await loadAuthorizationContext(subject, executor);
    if (context.userId !== ownerUserId)
        assertCapability(context, capability);
    return context;
}
