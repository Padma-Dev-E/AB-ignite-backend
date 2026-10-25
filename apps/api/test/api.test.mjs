import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

process.env.AUTH_SECRET = "local-fastify-api-test-secret-value-0123456789";
process.env.DATABASE_URL = `/tmp/ab-ignite-api-test-${process.pid}.db`;
process.env.API_HOST = "127.0.0.1";
process.env.API_PORT = "4198";
process.env.API_ALLOWED_ORIGINS = "https://app.example.test,http://127.0.0.1:3100";

let app;
before(async () => {
  const { buildApi } = await import("../src/app.ts");
  app = await buildApi();
});

after(async () => {
  await app?.close();
});

test("liveness and readiness endpoints report service and database state", async () => {
  const live = await app.inject({ method: "GET", url: "/health/live" });
  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: "ok" });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { status: "ready" });
});

test("unauthed requests to a protected route get the standard 401 envelope", async () => {
  const response = await app.inject({ method: "GET", url: "/api/ideas" });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, "unauthorized");
  assert.ok(response.headers["x-request-id"]);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("cross-origin cookie mutations are rejected before route handling", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/ideas",
    headers: { origin: "https://attacker.example" },
    payload: {},
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, "forbidden_origin");
});

test("same-origin requests forwarded by the web service pass the origin check", async () => {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/refresh",
    headers: { host: "127.0.0.1:3100", origin: "http://127.0.0.1:3100" },
  });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { ok: false, error: "Refresh token is invalid or expired." });
});

test("password changes accept the configured frontend origin through the API proxy", async () => {
  const [{ db }, { users, refreshTokens }, { hashPassword }, { encode }, { SESSION_COOKIE_NAME }] = await Promise.all([
    import("../../../src/db/connection.js"),
    import("../../../src/db/schema.js"),
    import("../../../src/auth/password-core.js"),
    import("next-auth/jwt"),
    import("../../../src/auth/config.js"),
  ]);
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(db, { migrationsFolder: path.resolve("drizzle") });
  const currentPassword = "CurrentPassword2026";
  const user = db.insert(users).values({
    name: "Password Route Test",
    email: `password-route-${process.pid}@example.test`,
    department: "QA",
    role: "employee",
    passwordHash: await hashPassword(currentPassword),
  }).returning().get();
  const now = new Date();
  const session = db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: `password-route-${process.pid}`,
    expiresAt: new Date(now.getTime() + 60_000),
    idleExpiresAt: new Date(now.getTime() + 60_000),
    absoluteExpiresAt: new Date(now.getTime() + 60_000),
    sessionVersion: user.sessionVersion,
  }).returning().get();
  const sessionCookie = await encode({
    secret: process.env.AUTH_SECRET,
    salt: SESSION_COOKIE_NAME,
    maxAge: 60,
    token: { sub: String(user.id), sessionId: String(session.id), sessionVersion: user.sessionVersion },
  });

  const response = await app.inject({
    method: "POST",
    url: "/api/account/password",
    headers: {
      host: "api:4100",
      origin: "http://127.0.0.1:3100",
      cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionCookie)}`,
      "content-type": "application/json",
    },
    payload: { currentPassword, newPassword: "NewPassword2026" },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().data, { changed: true, sessionsRevoked: true });
});

test("Auth.js refresh failures preserve their non-envelope compatibility shape", async () => {
  const response = await app.inject({ method: "POST", url: "/api/auth/refresh" });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { ok: false, error: "Refresh token is invalid or expired." });
});

test("retired passwordless demo access remains explicitly rejected", async () => {
  const response = await app.inject({ method: "POST", url: "/api/demo/session", payload: {} });
  assert.equal(response.statusCode, 410);
  assert.equal(response.json().error.code, "login_method_removed");
});

test("every Fastify route module is registered in the backend app", async () => {
  const collect = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await collect(file));
      else if (entry.name.endsWith(".ts")) result.push(file);
    }
    return result;
  };
  const routeDirectory = path.resolve("apps/api/src/routes");
  const files = await collect(routeDirectory);
  const appSource = await readFile(path.resolve("apps/api/src/app.ts"), "utf8");
  const expected = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const registration = source.match(/export async function (register\w+)\(/)?.[1];
    assert.ok(registration, `${path.basename(file)} should export a route registration function`);
    const relative = path.relative(path.resolve("apps/api/src"), file).split(path.sep).join("/").replace(/\.ts$/, ".js");
    expected.push(registration);
    assert.ok(appSource.includes(`import { ${registration} } from "./${relative}"`));
    assert.ok(appSource.includes(`await ${registration}(app)`));
  }
  assert.equal(expected.length, 8);
});
