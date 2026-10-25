import type { FastifyInstance } from "fastify";
import { db } from "../../../../src/db/connection.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health/live", async (_request, reply) => reply.code(200).send({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      db.$client.prepare("SELECT 1").get();
      return reply.code(200).send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
}
