import assert from "node:assert/strict";
import test from "node:test";
import { extractJsonOutput, extractJsonOutputs, unwrapJsonStringLayers } from "./json-output";

const expected = { suggestedTitle: "Structured Readiness Checklist", note: "Braces stay inside {quoted text}." };

test("extracts direct JSON values", () => {
  const extracted = extractJsonOutput(JSON.stringify(expected));
  assert.deepEqual(extracted?.value, expected);
  assert.equal(extracted?.format, "direct");
});

test("extracts balanced JSON from prose without treating quoted braces as delimiters", () => {
  const extracted = extractJsonOutput(`Model response follows:\n${JSON.stringify(expected)}\nDone.`);
  assert.deepEqual(extracted?.value, expected);
  assert.equal(extracted?.format, "embedded");
});

test("extracts JSON from Markdown fences surrounded by prose", () => {
  const extracted = extractJsonOutput(`Result:\n\`\`\`json\n${JSON.stringify(expected)}\n\`\`\`\nFinished.`);
  assert.deepEqual(extracted?.value, expected);
  assert.equal(extracted?.format, "markdown_fence");
});

test("unwraps JSON encoded as a JSON string", () => {
  const extracted = extractJsonOutput(JSON.stringify(JSON.stringify(expected)));
  assert.deepEqual(extracted?.value, expected);
  assert.equal(extracted?.format, "json_string");
});

test("extracts JSON nested through many serialized string and Markdown layers", () => {
  let nested = `\`\`\`json\n${JSON.stringify(expected)}\n\`\`\``;
  for (let layer = 0; layer < 12; layer += 1) nested = JSON.stringify(nested);

  const extracted = extractJsonOutput(nested);
  assert.deepEqual(extracted?.value, expected);
});

test("returns all complete JSON values in streamed text so the job schema can select the valid one", () => {
  const firstFragment = { partial: true };
  const expected = { suggestedTitle: "Structured Readiness Checklist", note: "Valid final object." };
  const outputs = extractJsonOutputs(`${JSON.stringify(firstFragment)}${JSON.stringify(expected)}`);

  assert.deepEqual(outputs.map((output) => output.value), [firstFragment, expected]);
});

test("extracts JSON whose structural quotes are escaped without outer string quotes", () => {
  const escaped = String.raw`{\"suggestedTitle\":\"Structured Readiness Checklist\",\"note\":\"Braces stay inside {quoted text}.\"}`;
  const extracted = extractJsonOutput(escaped);
  assert.deepEqual(extracted?.value, expected);
  assert.equal(extracted?.format, "escaped_json");
});

test("unwraps a JSON-encoded APIGEE response envelope", () => {
  const envelope = [{ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(expected) }] } }] }];
  assert.deepEqual(unwrapJsonStringLayers(JSON.stringify(JSON.stringify(envelope))), envelope);
});

test("returns no result for text without a JSON value", () => {
  assert.equal(extractJsonOutput("No structured output was generated."), undefined);
});
