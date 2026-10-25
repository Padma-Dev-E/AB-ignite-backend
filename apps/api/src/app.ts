import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { env } from "./config/env.js";
import { registerAuth } from "./plugins/auth.js";
import { registerHttp } from "./plugins/http.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerAuthRefreshRoutes } from "./routes/auth-refresh.js";
import { registerInternalAuthRoutes } from "./routes/auth-internal.js";
import { registerDemoRoutes } from "./routes/demo.js";
import { registerEmployeeRoutes } from "./routes/employee.js";
import { registerIdeaRoutes } from "./routes/ideas.js";
import { registerAdminGovernanceRoutes } from "./routes/admin-governance.js";
import { registerAdminContentRoutes } from "./routes/admin-content.js";

export async function buildApi() {
  const trustedProxy = env.trustProxy.split(",").map((value) => value.trim()).filter(Boolean);
  const app = Fastify({
    logger: { level: env.nodeEnv === "production" ? "info" : "debug", redact: ["req.headers.cookie", "req.headers.authorization"] },
    bodyLimit: env.maxBodyBytes,
    trustProxy: trustedProxy,
    requestIdHeader: "x-request-id",
    genReqId: (request) => {
      const supplied = request.headers["x-request-id"];
      return typeof supplied === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
    },
  });
  registerHttp(app);
  registerAuth(app);
  await registerHealthRoutes(app);
  await registerAuthRefreshRoutes(app);
  await registerInternalAuthRoutes(app);
  await registerDemoRoutes(app);
  await registerEmployeeRoutes(app);
  await registerIdeaRoutes(app);
  await registerAdminGovernanceRoutes(app);
  await registerAdminContentRoutes(app);
  return app;
}
