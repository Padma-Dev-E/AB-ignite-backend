export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
import { sessionAbsoluteSeconds, sessionIdleSeconds } from "./config";

export const SESSION_IDLE_MS = sessionIdleSeconds * 1000;
export const SESSION_ABSOLUTE_MS = sessionAbsoluteSeconds * 1000;

export type LoginSecurityState = {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
};

export function isLoginLocked(state: Pick<LoginSecurityState, "lockedUntil">, now = new Date()) {
  return Boolean(state.lockedUntil && state.lockedUntil.getTime() > now.getTime());
}

export function nextLoginFailure(state: LoginSecurityState, now = new Date()): LoginSecurityState {
  const failedLoginAttempts = state.lockedUntil && state.lockedUntil.getTime() <= now.getTime()
    ? 0
    : state.failedLoginAttempts;
  const nextAttempts = failedLoginAttempts + 1;
  return {
    failedLoginAttempts: nextAttempts,
    lockedUntil: nextAttempts >= MAX_LOGIN_ATTEMPTS
      ? new Date(now.getTime() + LOGIN_LOCKOUT_MS)
      : null,
  };
}

export function successfulLoginState(now = new Date()) {
  return {
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: now,
  };
}

type SessionState = {
  revokedAt: Date | null;
  idleExpiresAt: Date | null;
  absoluteExpiresAt: Date | null;
  sessionVersion: number;
};

type AccountState = {
  isActive: boolean;
  sessionVersion: number;
};

export function isSessionActive(session: SessionState, account: AccountState, now = new Date()) {
  if (!account.isActive || session.revokedAt) return false;
  if (session.sessionVersion !== account.sessionVersion) return false;
  if (session.idleExpiresAt && session.idleExpiresAt.getTime() <= now.getTime()) return false;
  if (session.absoluteExpiresAt && session.absoluteExpiresAt.getTime() <= now.getTime()) return false;
  return true;
}
