import test from "node:test";
import assert from "node:assert/strict";
import { demoEmail, normalizeDemoName } from "./demo-core";

test("demo names normalize to a stable opaque identity", () => {
  assert.equal(normalizeDemoName("  Padma   Dev  "), "Padma Dev");
  assert.equal(demoEmail("Padma Dev", "a-secure-test-secret-long-enough"), demoEmail(" padma  dev ", "a-secure-test-secret-long-enough"));
  assert.notEqual(demoEmail("Padma Dev", "a-secure-test-secret-long-enough"), demoEmail("Padma Devi", "a-secure-test-secret-long-enough"));
  assert.throws(() => normalizeDemoName("<script>"));
  assert.throws(() => demoEmail("Padma Dev", "short"));
});
