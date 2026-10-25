import test from "node:test";
import assert from "node:assert/strict";
import { resolveRequiredControlsPolicy, validatePolicySetting } from "./validation";

test("workflow policy requires bounded, named SLA days and unique controls", () => {
  assert.doesNotThrow(() => validatePolicySetting("sla_days", '{"screening":5,"business_review":10}'));
  for (const value of ['[5,10]', '{"screening":0}', '{"screening":1.5}', '{"":10}', '{"screening":366}', '{"benefit_validation":30}', '{"unknown_stage":10}']) {
    assert.throws(() => validatePolicySetting("sla_days", value));
  }
  assert.throws(() => validatePolicySetting("required_controls", '["Risk","risk"]'));
  assert.throws(() => validatePolicySetting("departments", '["Treasury","treasury"]'));
});

test("required controls contract distinguishes legacy default from an explicit empty policy", () => {
  assert.deepEqual(resolveRequiredControlsPolicy(undefined), { configured: false, controls: [], requiresControlApproval: true });
  assert.deepEqual(resolveRequiredControlsPolicy("[]"), { configured: true, controls: [], requiresControlApproval: false });
  assert.deepEqual(resolveRequiredControlsPolicy('["Risk"]'), { configured: true, controls: ["Risk"], requiresControlApproval: true });
});

test("access policy and minimum score reject misleading values", () => {
  for (const value of ["", " ", "NaN", "Infinity", "-1", "4"]) assert.throws(() => validatePolicySetting("minimum_priority_score", value));
  assert.doesNotThrow(() => validatePolicySetting("minimum_priority_score", "2.25"));
  for (const value of ['[]', '{"enabled":"true"}', '{"enabled":true,"password":"x"}']) assert.throws(() => validatePolicySetting("demo_access", value));
  assert.throws(() => validatePolicySetting("roles", '["back_office","back_office"]'));
  assert.throws(() => validatePolicySetting("roles", '["unrecognized"]'));
});
