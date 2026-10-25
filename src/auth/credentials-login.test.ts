import assert from "node:assert/strict";
import test from "node:test";
import { buildAuditRecord, type AuditEventInput } from "../lib/audit/service";
import { hashAuditValue } from "../lib/audit/redaction-core";
import { authorizeCredentialLogin, type CredentialLoginDependencies, type CredentialLoginUser } from "./credentials-login";

const ip = "203.0.113.17";
const password = "sensitive-password-value";
const user: CredentialLoginUser = {
  id: 17,
  name: "Audit test user",
  email: "audit-user@example.test",
  role: "employee",
  passwordHash: "stored-password-hash",
  isActive: true,
  lockedUntil: null,
  sessionVersion: 2,
  mustChangePassword: false,
};

function harness(overrides: Partial<CredentialLoginDependencies> = {}) {
  const events: AuditEventInput[] = [];
  const calls = { find: 0, verify: 0, failure: 0, success: 0, issue: 0 };
  const dependencies: CredentialLoginDependencies = {
    async findUser() { calls.find++; return user; },
    async verifyPassword() { calls.verify++; return true; },
    recordLoginFailure() { calls.failure++; return { failedLoginAttempts: 1, lockedUntil: null }; },
    recordLoginSuccess() { calls.success++; },
    async issueSession() { calls.issue++; return { record: { id: 91 } }; },
    appendAudit(event) { events.push(event); },
    ...overrides,
  };
  const request = new Request("https://bank.example.test/api/auth/callback/credentials", {
    headers: { "x-forwarded-for": ip, "user-agent": "test-agent" },
  });
  return { events, calls, dependencies, request };
}

function assertSafeEvent(event: AuditEventInput, reasonCode: string, actorUserId: number | null, action = "auth.login.failed") {
  assert.equal(event.action, action);
  assert.equal(event.actorUserId ?? null, actorUserId);
  assert.equal((event.metadata as { reasonCode: string }).reasonCode, reasonCode);
  const stored = buildAuditRecord(event);
  const serialized = JSON.stringify(stored);
  assert.equal(stored.ipHash, hashAuditValue(ip));
  for (const sensitive of [ip, password, user.email, user.passwordHash, "raw-refresh-token"]) {
    assert.ok(!serialized.includes(sensitive), `audit record exposed ${sensitive}`);
  }
}

test("missing credentials create one safe rejection event before lookup", async () => {
  for (const credentials of [{ email: "", password }, { email: user.email, password: "" }]) {
    const h = harness();
    const result = await authorizeCredentialLogin(credentials, h.request, h.dependencies);
    assert.equal(result, null);
    assert.equal(h.calls.find, 0);
    assert.equal(h.events.length, 1);
    assertSafeEvent(h.events[0], "missing_credentials", null);
  }
});

test("unknown, demo, inactive, locked, and incorrect-password attempts are each audited", async () => {
  const cases: { name: string; overrides: Partial<CredentialLoginDependencies>; reason: string; actor: number | null }[] = [
    { name: "unknown", overrides: { async findUser() { return null; } }, reason: "invalid_credentials", actor: null },
    { name: "demo", overrides: { async findUser() { return { ...user, email: "x@demo.abignite.invalid" }; } }, reason: "demo_credentials_denied", actor: user.id },
    { name: "inactive", overrides: { async findUser() { return { ...user, isActive: false }; } }, reason: "inactive", actor: user.id },
    { name: "locked", overrides: { async findUser() { return { ...user, lockedUntil: new Date(Date.now() + 60000) }; } }, reason: "locked", actor: user.id },
    { name: "incorrect", overrides: { async verifyPassword() { return false; } }, reason: "invalid_credentials", actor: user.id },
  ];
  for (const item of cases) {
    const h = harness(item.overrides);
    const result = await authorizeCredentialLogin({ email: user.email, password }, h.request, h.dependencies);
    assert.equal(result, null, item.name);
    assert.equal(h.events.length, 1, item.name);
    assertSafeEvent(h.events[0], item.reason, item.actor, item.reason === "inactive" || item.reason === "locked" ? "auth.login.locked" : "auth.login.failed");
  }
});

test("session issuance failure is audited without claiming login success", async () => {
  const h = harness({ async issueSession() { return null; } });
  const result = await authorizeCredentialLogin({ email: user.email, password }, h.request, h.dependencies);
  assert.equal(result, null);
  assert.equal(h.events.length, 1);
  assert.equal(h.calls.success, 0);
  assertSafeEvent(h.events[0], "session_issue_failed", user.id);
});

test("successful login keeps only session ID in audit and returned identity", async () => {
  const h = harness({ async issueSession() { return { record: { id: 91 }, rawToken: "raw-refresh-token" }; } });
  const result = await authorizeCredentialLogin({ email: user.email, password }, h.request, h.dependencies);
  assert.equal(result?.sessionId, "91");
  assert.equal(result?.mustChangePassword, false);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0].action, "auth.login.succeeded");
  assert.equal(h.events[0].sessionId, 91);
  assert.ok(!JSON.stringify(buildAuditRecord(h.events[0])).includes("raw-refresh-token"));
});

test("successful login carries the forced password-change state into the JWT user", async () => {
  const h = harness({ async findUser() { return { ...user, mustChangePassword: true }; } });
  const result = await authorizeCredentialLogin({ email: user.email, password }, h.request, h.dependencies);
  assert.equal(result?.mustChangePassword, true);
});
