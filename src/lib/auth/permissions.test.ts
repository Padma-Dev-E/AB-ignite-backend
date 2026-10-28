import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES,
  capabilitiesForRole,
  hasCapability,
} from "./permissions";

test("four account roles grant only their intended server capabilities", () => {
  assert.deepEqual(capabilitiesForRole("employee"), [
    CAPABILITIES.IDEAS_READ,
    CAPABILITIES.IDEAS_WRITE,
    CAPABILITIES.PROFILE_READ,
  ]);
  assert.equal(hasCapability("business_owner", CAPABILITIES.GOVERNANCE_MANAGE), true);
  assert.equal(hasCapability("business_owner", CAPABILITIES.USERS_MANAGE), false);
  assert.equal(hasCapability("employee", CAPABILITIES.GOVERNANCE_MANAGE), false);
  assert.equal(hasCapability("maintainer", CAPABILITIES.GOVERNANCE_READ), true);
  assert.equal(hasCapability("maintainer", CAPABILITIES.GOVERNANCE_MANAGE), true);
  assert.equal(hasCapability("maintainer", CAPABILITIES.USERS_MANAGE), false);
  assert.equal(hasCapability("maintainer", CAPABILITIES.AI_PROMPTS_MANAGE), false);
  assert.equal(hasCapability("admin", CAPABILITIES.USERS_MANAGE), true);
  assert.equal(hasCapability("admin", CAPABILITIES.SETTINGS_MANAGE), true);
  assert.deepEqual(capabilitiesForRole("admin"), Object.values(CAPABILITIES));
});
