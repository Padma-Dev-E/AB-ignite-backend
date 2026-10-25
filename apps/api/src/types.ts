import type { UserRole } from "../../../src/db/schema.js";

export type ApiActor = {
  userId: number;
  sessionId: number;
  role: UserRole;
  name: string;
  email: string;
  mustChangePassword: boolean;
  sessionVersion: number;
};

export type ApiEnvelope<T = unknown> = {
  data: T | null;
  error: { code: string; message: string } | null;
  requestId: string;
};
