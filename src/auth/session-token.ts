import type { UserRole } from "../db/schema";

export type SessionTokenUser = {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  mustChangePassword: boolean;
};

export function createSessionTokenPayload(
  user: SessionTokenUser,
  sessionId: number,
  sessionVersion: number,
  accessTokenExpires: number,
) {
  return {
    sub: String(user.id),
    name: user.name,
    email: user.email,
    role: user.role,
    mustChangePassword: user.mustChangePassword,
    sessionId: String(sessionId),
    sessionVersion,
    accessTokenExpires,
  };
}
