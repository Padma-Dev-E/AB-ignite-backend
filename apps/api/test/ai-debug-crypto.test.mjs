import test from "node:test";
import assert from "node:assert/strict";

process.env.AUTH_SECRET = "ai-debug-test-secret-which-is-long-enough-123456";
const { encryptAiDebugPayload, decryptAiDebugPayload } = await import("../../../src/lib/ai/debug-crypto.js");

test("AI diagnostic payloads encrypt and decrypt without changing JSON", () => {
  const payload = '{"contents":{"role":"user","parts":[{"text":"private prompt"}]}}';
  const encrypted = encryptAiDebugPayload(payload);
  assert.notEqual(encrypted, payload);
  assert.equal(decryptAiDebugPayload(encrypted), payload);
});

test("AI diagnostic payload encryption rejects tampered ciphertext", () => {
  const encrypted = encryptAiDebugPayload("response");
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptAiDebugPayload(tampered));
});
