import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
} from "./permissions";

test("three account roles grant only their intended server capabilities", () => {
  assert.deepEqual(capabilitiesForRole("employee"), [
    CAPABILITIES.IDEAS_READ,
    CAPABILITIES.IDEAS_WRITE,
    CAPABILITIES.PROFILE_READ,
  ]);
  assert.equal(hasCapability("business_owner", CAPABILITIES.GOVERNANCE_MANAGE), true);
  assert.equal(hasCapability("business_owner", CAPABILITIES.USERS_MANAGE), false);
  assert.equal(hasCapability("employee", CAPABILITIES.GOVERNANCE_MANAGE), false);
  assert.equal(hasCapability("back_office", CAPABILITIES.USERS_MANAGE), true);
  assert.equal(hasCapability("back_office", CAPABILITIES.SETTINGS_MANAGE), true);
  assert.deepEqual(capabilitiesForRole("back_office"), Object.values(CAPABILITIES));
});
