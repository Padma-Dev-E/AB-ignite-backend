import "next-auth";
import "next-auth/jwt";
import type { UserRole } from "../src/db/schema";

declare module "next-auth" {
  interface User {
    role: UserRole;
    sessionId?: string;
    sessionVersion?: number;
    mustChangePassword: boolean;
  }

  interface Session {
    user: {
      id: string;
      role: UserRole;
      sessionId?: string;
      mustChangePassword: boolean;
    } & Session["user"];
    accessTokenExpires?: number;
    mustChangePassword?: boolean;
    isValid?: boolean;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: UserRole;
    sessionId?: string;
    sessionVersion?: number;
    sessionRevoked?: boolean;
    accessTokenExpires?: number;
  }
}
