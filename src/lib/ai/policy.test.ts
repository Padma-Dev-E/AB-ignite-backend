import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAiInput } from "./policy";

test("serializes sanitized idea data without adding a prompt delimiter", () => {
  const input = {
    kind: "idea",
    title: "Improve branch appointment flow",
    dataClassification: "internal",
  };
  const result = evaluateAiInput(input, {
    maxInputChars: 30_000,
    allowedDataClassification: "internal",
    blockRestricted: true,
    blockSensitive: true,
  });

  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.serialized, JSON.stringify(input));
  assert.equal(result.serialized.includes("<user_data>"), false);
});
