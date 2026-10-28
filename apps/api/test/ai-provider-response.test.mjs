import test from "node:test";
import assert from "node:assert/strict";

const { createApigeeProvider } = await import("../../../src/lib/ai/apigee-provider-core.js");

function config() {
  return {
    model: "apigee",
    apigeeUrl: "https://apigee.example.test/generate",
    apigeeClientId: "test-client-id",
    skipSslAiCalls: false,
    aiDebugPayloads: false,
    aiDebugRetentionHours: 1,
    timeoutMs: 1_000,
    maxAttempts: 1,
    retryInitialDelayMs: 0,
    retryMaxDelayMs: 0,
    maxOutputTokens: 256,
    temperature: 0,
    maxInputChars: 10_000,
    maxOutputBytes: 10_000,
    allowedDataClassification: "internal",
    logSensitive: false,
    rateLimitPerUser: 10,
    globalConcurrency: 1,
    retentionDays: 1,
  };
}

const request = {
  runId: 21,
  model: "apigee",
  systemPrompt: "Return structured data.",
  userContent: "Build a short idea summary.",
  responseMimeType: "application/json",
  responseJsonSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
  maxOutputTokens: 256,
  temperature: 0,
  timeoutMs: 1_000,
};

test("APIGEE array response unwraps JSON text and sends the documented request envelope", async () => {
  let sentBody;
  const provider = createApigeeProvider(config(), {
    call: async (_config, body) => {
      sentBody = body;
      return [{ candidates: [{ content: { role: "model", parts: [{ text: '{"summary":"A clear idea."}' }] } }] }];
    },
  });

  const result = await provider.generateStructured(request);

  assert.equal(sentBody.contents.role, "user");
  assert.equal(sentBody.contents.parts.length, 1);
  assert.match(sentBody.contents.parts[0].text, /Build a short idea summary/);
  const prompt = sentBody.contents.parts[0].text;
  assert.ok(prompt.indexOf("<system_instructions>") < prompt.indexOf("<response_schema>"));
  assert.ok(prompt.indexOf("<response_schema>") < prompt.indexOf("<user_data>"));
  assert.ok(prompt.indexOf("<user_data>") < prompt.indexOf("<task>"));
  assert.match(prompt, /<user_data>[\s\S]*Build a short idea summary[\s\S]*<\/user_data>/);
  assert.equal(result.text, '{"summary":"A clear idea."}');
  assert.deepEqual(JSON.parse(result.text), { summary: "A clear idea." });
});

test("APIGEE output errors expose a stable safe stage code", async () => {
  const provider = createApigeeProvider(config(), { call: async () => [{ candidates: [] }] });
  await assert.rejects(provider.generateStructured(request), (error) => {
    assert.equal(error.code, "candidate_text_missing");
    assert.equal(error.stage, "candidate_extraction");
    return true;
  });
});

test("malformed candidate JSON is distinguished from a missing candidate", async () => {
  const provider = createApigeeProvider(config(), {
    call: async () => [{ candidates: [{ content: { parts: [{ text: "{not json}" }] }, finishReason: "STOP" }] }],
  });
  await assert.rejects(provider.generateStructured(request), (error) => {
    assert.equal(error.code, "model_output_not_json");
    assert.equal(error.stage, "model_json_parsing");
    return true;
  });
});

test("blocked or incomplete candidates return specific safe output errors", async () => {
  for (const [response, expectedCode] of [
    [{ promptFeedback: { blockReason: "SAFETY" }, candidates: [] }, "provider_prompt_blocked"],
    [{ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "MAX_TOKENS" }] }, "provider_candidate_incomplete"],
  ]) {
    const provider = createApigeeProvider(config(), { call: async () => response });
    await assert.rejects(provider.generateStructured(request), (error) => {
      assert.equal(error.code, expectedCode);
      assert.equal(error.stage, "candidate_extraction");
      return true;
    });
  }
});
