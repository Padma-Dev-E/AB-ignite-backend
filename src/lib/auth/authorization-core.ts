import type { UserRole } from "./permissions";

export class AuthorizationError extends Error {
  readonly status = 403;
  readonly code = "FORBIDDEN";
}

export function requirePrivilegedReason(reason: unknown): string {
  if (typeof reason !== "string") throw new AuthorizationError("A reason is required for privileged mutations.");
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > 500) {
    throw new AuthorizationError("A reason between 1 and 500 characters is required for privileged mutations.");
  }
  return trimmed;
}

export type ClaimedRole = UserRole | undefined;
