import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/connection';
import { users, refreshTokens, auditEvents } from '../../db/schema';
import { hashPassword, verifyPassword } from '../../auth/password-core';
import { isSessionActive, isLoginLocked, nextLoginFailure } from '../../auth/security-core';
import { buildAuditRecord } from '../../lib/audit/service';
import { passwordInput } from './password-policy';

export class PasswordError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export async function changePassword(actor: { userId: number; sessionId: number; ipAddress?: string | null; userAgent?: string | null }, input: unknown) {
  const values = passwordInput.parse(input);
  const user = db.select().from(users).where(eq(users.id, actor.userId)).get();
  const token = db.select().from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).get();
  const now = new Date();
  if (!user || !token || token.userId !== user.id || token.expiresAt <= now || !isSessionActive(token, user, now)) throw new PasswordError('Sign in again to change your password.', 401);
  if (user.email.endsWith('@demo.abignite.invalid')) throw new PasswordError('Demo profiles do not have a password to change.');
  if (isLoginLocked(user, now)) throw new PasswordError('Too many attempts. Try again in 15 minutes.', 429);
  const verified = await verifyPassword(user.passwordHash, values.currentPassword);
  const passwordHash = verified ? await hashPassword(values.newPassword) : null;
  const result = db.transaction(tx => {
    const current = tx.select().from(users).where(eq(users.id, user.id)).get();
    const session = tx.select().from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).get();
    const at = new Date();
    if (!current || !session || session.userId !== current.id || session.expiresAt <= at || !isSessionActive(session, current, at) || current.passwordHash !== user.passwordHash) throw new PasswordError('Your session changed. Sign in again.', 401);
    if (isLoginLocked(current, at)) throw new PasswordError('Too many attempts. Try again in 15 minutes.', 429);
    if (!verified || !passwordHash) {
      tx.update(users).set({ ...nextLoginFailure(current, at), lastFailedLoginAt: at, updatedAt: at }).where(eq(users.id, current.id)).run();
      tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: current.id, sessionId: actor.sessionId, action: 'account.password.rejected', targetType: 'user', targetId: current.id, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, at)).run();
      return false;
    }
    tx.update(users).set({ passwordHash, mustChangePassword: false, failedLoginAttempts: 0, lockedUntil: null, sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: at }).where(eq(users.id, current.id)).run();
    tx.update(refreshTokens).set({ revokedAt: at, revocationReason: 'account.password.changed', updatedAt: at }).where(and(eq(refreshTokens.userId, current.id), isNull(refreshTokens.revokedAt))).run();
    tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: current.id, sessionId: actor.sessionId, action: 'account.password.changed', targetType: 'user', targetId: current.id, metadata: { result: 'all_sessions_revoked' }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, at)).run();
    return true;
  });
  if (!result) throw new PasswordError('Current password is incorrect.');
  return { changed: true, sessionsRevoked: true };
}
