import assert from "node:assert/strict";
import test from "node:test";
import type { AiConfig } from "./config-core";
import { AiProviderError } from "./errors";
import { createApigeeProvider } from "./apigee-provider-core";
import type { StructuredGenerationRequest } from "./types";

const config = {
  apigeeUrl: "https://apigee.example.test/generate",
  apigeeClientId: "test-client",
  maxAttempts: 3,
  retryInitialDelayMs: 0,
  retryMaxDelayMs: 0,
} as AiConfig;

const request: StructuredGenerationRequest = {
  model: "apigee",
  systemPrompt: "Return JSON.",
  userContent: "Test input",
  responseMimeType: "application/json",
  responseJsonSchema: { type: "object" },
  maxOutputTokens: 100,
  temperature: 0,
  timeoutMs: 1_000,
  runId: 10,
  attempt: 2,
};

test("one provider invocation is made per durable AI run attempt", async () => {
  const calls: Array<{ runId?: number; attempt?: number }> = [];
  const provider = createApigeeProvider(config, {
    call: async (_config, _body, diagnostic) => {
      calls.push(diagnostic ?? {});
      throw new AiProviderError("transient", "temporary provider failure");
    },
  });

  await assert.rejects(provider.generateStructured(request), /temporary provider failure/);
  assert.deepEqual(calls, [{ runId: 10, attempt: 2 }]);
});
