import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.AUTH_SECRET = "idea-validation-input-test-secret-value-0123456789";
process.env.INTERNAL_API_TOKEN = "idea-validation-input-test-internal-token-0123456789";
process.env.DATABASE_URL = path.join(mkdtempSync(path.join(tmpdir(), "ab-ignite-validation-input-")), "test.sqlite");
process.env.API_HOST = "127.0.0.1";
process.env.API_PORT = "4199";

let app;
let db;
let cookie;
let aiRuns;
let user;

before(async () => {
  ({ db } = await import("../../../src/db/connection.js"));
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { users, refreshTokens } = await import("../../../src/db/schema.js");
  const { encode } = await import("next-auth/jwt");
  const { SESSION_COOKIE_NAME } = await import("../../../src/auth/config.js");
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  const { buildApi } = await import("../src/app.ts");
  app = await buildApi();
  ({ aiRuns } = await import("../../../src/db/schema.js"));

  user = db.insert(users).values({
    name: "Validation Input Test",
    email: `validation-input-${process.pid}@example.test`,
    role: "employee",
    passwordHash: "test-only",
  }).returning().get();
  const now = new Date();
  const session = db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: `validation-input-${process.pid}`,
    expiresAt: new Date(now.getTime() + 60_000),
    idleExpiresAt: new Date(now.getTime() + 60_000),
    absoluteExpiresAt: new Date(now.getTime() + 60_000),
    sessionVersion: user.sessionVersion,
  }).returning().get();
  const value = await encode({
    secret: process.env.AUTH_SECRET,
    salt: SESSION_COOKIE_NAME,
    maxAge: 60,
    token: { sub: String(user.id), sessionId: String(session.id), sessionVersion: user.sessionVersion },
  });
  cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`;
});

after(async () => {
  await app?.close();
});

test("idea validation receives saved Numbers ratings and explanations", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/api/ideas",
    headers: { cookie, "content-type": "application/json" },
    payload: {
      kind: "idea",
      title: "Validation input assembly test",
      summary: "A sufficiently detailed test proposal for checking the AI validation payload.",
      category: "Operations",
      answers: {
        beneficiaries: "Operations colleagues",
        currentProcess: "They manually review cases.",
        needed: "A guided review process.",
        risks: "Incorrect routing could delay cases.",
        successMeasure: "Measure median handling time.",
      },
      metrics: {
        turnaround: 2,
        volume: 1,
        value: 2.5,
        turnaroundExplanation: "The proposal may reduce repeated review steps.",
        volumeExplanation: "The process recurs across the operations team.",
        valueExplanation: "Released capacity is an estimate and not measured yet.",
      },
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  const ideaId = created.json().data.idea.id;

  const queued = await app.inject({
    method: "POST",
    url: `/api/ideas/${ideaId}/development`,
    headers: { cookie, "content-type": "application/json" },
    payload: { action: "validate" },
  });
  assert.equal(queued.statusCode, 202, queued.body);
  const [run] = db.select().from(aiRuns).where((await import("drizzle-orm")).eq(aiRuns.id, queued.json().data.runId)).all();
  const input = JSON.parse(run.inputJson);
  assert.deepEqual(input.metrics, {
    turnaround: 2,
    volume: 1,
    value: 2.5,
    turnaroundExplanation: "The proposal may reduce repeated review steps.",
    volumeExplanation: "The process recurs across the operations team.",
    valueExplanation: "Released capacity is an estimate and not measured yet.",
  });
});
