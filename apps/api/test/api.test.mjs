import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

process.env.AUTH_SECRET = "local-fastify-api-test-secret-value-0123456789";
process.env.DATABASE_URL = `/tmp/ab-ignite-api-test-${process.pid}.db`;
process.env.API_HOST = "127.0.0.1";
process.env.API_PORT = "4198";
process.env.API_ALLOWED_ORIGINS = "https://app.example.test";

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

test("every inventoried non-Auth.js method and path is registered in Fastify", async () => {
  const collect = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await collect(file));
      else if (entry.name === "route.ts") result.push(file);
    }
    return result;
  };
  const files = await collect(path.resolve("app/api"));
  const missing = [];
  let expected = 0;
  for (const file of files) {
    const relative = path.relative(path.resolve("app/api"), path.dirname(file)).split(path.sep).join("/");
    if (relative === "auth/[...nextauth]") continue;
    const source = await readFile(file, "utf8");
    const methods = new Set(source.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g).map((match) => match[1]));
    for (const match of source.matchAll(/export\s+const\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) methods.add(match[1]);
    if (source.includes("export const { GET, POST }")) { methods.add("GET"); methods.add("POST"); }
    let url = `/api/${relative}`
      .replaceAll("[id]", ":id")
      .replaceAll("[ideaId]", ":ideaId")
      .replaceAll("[sessionId]", ":sessionId");
    if (relative === "account/profile") { methods.add("GET"); methods.add("PATCH"); }
    if (relative === "announcements/[id]") methods.add("GET");
    for (const method of methods) {
      expected++;
      if (!app.hasRoute({ method, url })) missing.push(`${method} ${url}`);
    }
  }
  assert.equal(expected, 101, "expected 101 Fastify-owned operations out of 103 total");
  assert.deepEqual(missing, []);
});
