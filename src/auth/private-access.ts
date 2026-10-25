import type { Session } from "next-auth";

export function hasValidPrivateSession(session: Pick<Session, "user" | "isValid"> | null | undefined): boolean {
  return Boolean(session?.user?.id && session.isValid !== false);
}
