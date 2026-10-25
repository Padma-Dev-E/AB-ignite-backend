import type { FastifyInstance } from "fastify";
import { authSecret } from "../../../../src/auth/config.js";
import { appendAuditEvent } from "../../../../src/lib/audit/service.js";
import { sendError } from "../plugins/http.js";

export async function registerDemoRoutes(app: FastifyInstance) {
  app.post("/api/demo/session", async (request, reply) => {
    try {
      const auditSecret = process.env.AUTH_AUDIT_HASH_SECRET ?? authSecret;
      appendAuditEvent({
        action: "auth.demo.rejected",
        metadata: { reasonCode: "login_method_removed" },
        ...(auditSecret.length >= 24
          ? { ipAddress: request.ip ?? null, userAgent: request.headers["user-agent"] ?? null }
          : {}),
      });
    } catch {
      // The legacy sign-in method remains rejected even if audit persistence fails.
    }
    return sendError(reply, request, "login_method_removed", "Sign in with your assigned email and password.", 410);
  });
}
