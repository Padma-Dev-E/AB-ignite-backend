import assert from "node:assert/strict";
import { test } from "node:test";
import { adminSettingsPatchSchema } from "./request-schema";

test("admin settings PATCH accepts only the changed priority policy keys", () => {
  const result = adminSettingsPatchSchema.safeParse({
    reason: "Set the minimum score",
    priority: { minimum_priority_score: "1.5" },
  });

  assert.equal(result.success, true);
});

test("admin settings PATCH rejects unknown priority policy keys", () => {
  const result = adminSettingsPatchSchema.safeParse({
    reason: "Try an unsupported policy",
    priority: { unsupported: "value" },
  });

  assert.equal(result.success, false);
});
