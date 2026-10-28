import assert from "node:assert/strict";
import test from "node:test";
import type { AiConfig } from "./config-core";
import { AiProviderError, AiProviderOutputError } from "./errors";
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

test("accepts JSON embedded in explanatory text from an array-wrapped APIGEE response", async () => {
  const expected = { title: "Reduce branch wait time", score: 8 };
  const provider = createApigeeProvider(config, {
    call: async () => [{ candidates: [{ content: { role: "model", parts: [{ text: `Here is the requested result:\n${JSON.stringify(expected)}\nI hope this helps.` }] }, finishReason: "STOP" }] }],
  });

  const result = await provider.generateStructured(request);
  assert.deepEqual(JSON.parse(result.text), expected);
});

test("unwraps a JSON-stringified APIGEE envelope before reading its candidate text", async () => {
  const expected = { title: "Reduce branch wait time", score: 8 };
  const envelope = [{ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(expected) }] }, finishReason: "STOP" }] }];
  const provider = createApigeeProvider(config, { call: async () => JSON.stringify(JSON.stringify(envelope)) });

  const result = await provider.generateStructured(request);
  assert.deepEqual(JSON.parse(result.text), expected);
});

test("unwraps a JSON object returned as a JSON-encoded string", async () => {
  const expected = { title: "Reduce branch wait time", score: 8 };
  const provider = createApigeeProvider(config, {
    call: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(JSON.stringify(expected)) }] }, finishReason: "STOP" }] }),
  });

  const result = await provider.generateStructured(request);
  assert.deepEqual(JSON.parse(result.text), expected);
});

test("decodes escaped structural quotes in an otherwise unquoted JSON object", async () => {
  const expected = { suggestedTitle: "Structured Readiness Checklist", conciseSummary: "Coordinate procedure changes." };
  const escaped = String.raw`{\"suggestedTitle\":\"Structured Readiness Checklist\",\"conciseSummary\":\"Coordinate procedure changes.\"}`;
  const provider = createApigeeProvider(config, {
    call: async () => [{ candidates: [{ content: { role: "model", parts: [{ text: escaped }] }, finishReason: "STOP" }] }],
  });

  const result = await provider.generateStructured(request);
  assert.deepEqual(JSON.parse(result.text), expected);
});

test("extracts JSON from a fenced block even when the model adds surrounding text", async () => {
  const expected = { title: "Reduce branch wait time", score: 8 };
  const provider = createApigeeProvider(config, {
    call: async () => ({ candidates: [{ content: { parts: [{ text: `Result:\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`\nCompleted.` }] }, finishReason: "STOP" }] }),
  });

  const result = await provider.generateStructured(request);
  assert.deepEqual(JSON.parse(result.text), expected);
});

test("does not make another provider call when output has no recoverable JSON value", async () => {
  let calls = 0;
  const provider = createApigeeProvider(config, {
    call: async () => {
      calls += 1;
      return { candidates: [{ content: { parts: [{ text: "I could not produce a structured answer." }] }, finishReason: "STOP" }] };
    },
  });

  await assert.rejects(provider.generateStructured(request), (error: unknown) =>
    error instanceof AiProviderOutputError && error.code === "model_output_not_json");
  assert.equal(calls, 1);
});
