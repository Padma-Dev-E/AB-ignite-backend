import assert from "node:assert/strict";
import test from "node:test";
import { hasValidPrivateSession } from "./private-access";
import { canAccessAdminWorkspace, postLoginPath, forcedPasswordChangePathAllowed } from "./config";

test("a JWT with a revoked session cannot render private content", () => {
  assert.equal(hasValidPrivateSession(null), false);
  assert.equal(hasValidPrivateSession({ user: { id: "1" }, isValid: false }), false);
  assert.equal(hasValidPrivateSession({ user: { id: "1" }, isValid: true }), true);
});

test("three account roles route to their authorized workspace", () => {
  assert.equal(postLoginPath("back_office"), "/private/admin");
  assert.equal(postLoginPath("business_owner"), "/private/admin");
  assert.equal(postLoginPath("employee"), "/private");
  assert.equal(canAccessAdminWorkspace("back_office"), true);
  assert.equal(canAccessAdminWorkspace("business_owner"), true);
  assert.equal(canAccessAdminWorkspace("employee"), false);
});

test("forced password-change sessions can reach only password change and required auth endpoints", () => {
  assert.equal(forcedPasswordChangePathAllowed("/change-password"), true);
  assert.equal(forcedPasswordChangePathAllowed("/api/account/password"), true);
  assert.equal(forcedPasswordChangePathAllowed("/api/auth/session"), true);
  assert.equal(forcedPasswordChangePathAllowed("/private"), false);
  assert.equal(forcedPasswordChangePathAllowed("/api/ideas"), false);
  assert.equal(forcedPasswordChangePathAllowed("/change-password/anything"), false);
});
