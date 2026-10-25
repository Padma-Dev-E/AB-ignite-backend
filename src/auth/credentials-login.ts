import type { UserRole } from "../db/schema";
import type { AuditEventInput } from "../lib/audit/service";
import { isLoginLocked } from "./security-core";

export type CredentialLoginUser = {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  passwordHash: string;
  isActive: boolean;
  lockedUntil: Date | null;
  sessionVersion: number;
  mustChangePassword: boolean;
};

type RequestMetadata = { ipAddress: string | null; userAgent: string | null };

export type CredentialLoginDependencies = {
  findUser(email: string): Promise<CredentialLoginUser | null>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  recordLoginFailure(userId: number, now: Date): { failedLoginAttempts: number; lockedUntil: Date | null } | null;
  recordLoginSuccess(userId: number, now: Date): void;
  issueSession(userId: number, metadata: RequestMetadata): Promise<{ record: { id: number } } | null>;
  appendAudit(event: AuditEventInput): void;
};

function requestMetadata(request: Request): RequestMetadata {
  return {
    ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  };
}

export async function authorizeCredentialLogin(
  credentials: Partial<Record<"email" | "password", unknown>> | undefined,
  request: Request,
  dependencies: CredentialLoginDependencies,
) {
  const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
  const password = typeof credentials?.password === "string" ? credentials.password : "";
  const metadata = requestMetadata(request);
  const reject = (reasonCode: string, actorUserId?: number, action = "auth.login.failed", attempts?: number) => {
    dependencies.appendAudit({
      actorUserId,
      action,
      metadata: { reasonCode, ...(attempts === undefined ? {} : { attempts }) },
      ...metadata,
    });
    return null;
  };

  if (!email || !password) return reject("missing_credentials");

  const user = await dependencies.findUser(email);
  if (!user) return reject("invalid_credentials");
  if (user.email.endsWith("@demo.abignite.invalid")) return reject("demo_credentials_denied", user.id);

  const now = new Date();
  if (!user.isActive || isLoginLocked(user, now)) {
    return reject(user.isActive ? "locked" : "inactive", user.id, "auth.login.locked");
  }

  if (!(await dependencies.verifyPassword(user.passwordHash, password))) {
    const next = dependencies.recordLoginFailure(user.id, now);
    return reject(next?.lockedUntil ? "lockout" : "invalid_credentials", user.id, "auth.login.failed", next?.failedLoginAttempts ?? 0);
  }

  const issued = await dependencies.issueSession(user.id, metadata);
  if (!issued) return reject("session_issue_failed", user.id);
  dependencies.recordLoginSuccess(user.id, now);
  dependencies.appendAudit({ actorUserId: user.id, sessionId: issued.record.id, action: "auth.login.succeeded", ...metadata });

  return {
    id: String(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    sessionId: String(issued.record.id),
    sessionVersion: user.sessionVersion,
    mustChangePassword: user.mustChangePassword,
  };
}
