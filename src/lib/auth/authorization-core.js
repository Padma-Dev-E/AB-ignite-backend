export class AuthorizationError extends Error {
    status = 403;
    code = "FORBIDDEN";
}
export function requirePrivilegedReason(reason) {
    if (typeof reason !== "string")
        throw new AuthorizationError("A reason is required for privileged mutations.");
    const trimmed = reason.trim();
    if (!trimmed || trimmed.length > 500) {
        throw new AuthorizationError("A reason between 1 and 500 characters is required for privileged mutations.");
    }
    return trimmed;
}
