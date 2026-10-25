import assert from "node:assert/strict";
import test from "node:test";
import { createSessionTokenPayload } from "./session-token";

test("refresh-token JWT preserves the forced-change flag for back-office accounts", () => {
  const payload = createSessionTokenPayload({
    id: 4,
    name: "New admin",
    email: "new-admin@example.test",
    role: "back_office",
    mustChangePassword: true,
  }, 12, 3, 1_800_000_000_000);

  assert.equal(payload.mustChangePassword, true);
  assert.equal(payload.role, "back_office");
  assert.equal(payload.sessionId, "12");
  assert.equal(payload.sessionVersion, 3);
});

test("refresh-token JWT preserves normal employee role without forcing established users", () => {
  const payload = createSessionTokenPayload({
    id: 5,
    name: "Employee",
    email: "employee@example.test",
    role: "employee",
    mustChangePassword: false,
  }, 13, 0, 1_800_000_000_000);

  assert.equal(payload.mustChangePassword, false);
  assert.equal(payload.role, "employee");
});
