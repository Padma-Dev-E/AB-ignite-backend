import test from "node:test";
import assert from "node:assert/strict";

const { aiPromptSeeds } = await import("../../../src/lib/ai/prompts/seed-data.ts");
const prompt = (jobKey) => aiPromptSeeds.find((entry) => entry.jobKey === jobKey)?.systemPrompt ?? "";

test("idea validation prompt calibrates evidence and does not default impact lenses to one", () => {
  const validation = prompt("idea.validate");
  assert.match(validation, /0 = no credible causal path/);
  assert.match(validation, /2 = a clear, plausible mechanism and named group or recurring process/);
  assert.match(validation, /Do not default all lenses to 1/);
  assert.match(validation, /server is authoritative and recomputes/);
  assert.match(validation, /Never use `reject` solely because a score is low/);
});

test("idea enrichment prompt requires useful, grounded, editable fields", () => {
  const enrichment = prompt("idea.enrich");
  for (const field of ["suggestedTitle", "conciseSummary", "problemStatement", "solutionStatement", "valueStatement", "riskStatement", "affectedTeams", "assumptions"]) {
    assert.match(enrichment, new RegExp(field));
  }
  assert.match(enrichment, /Preserve the author's intent/);
  assert.match(enrichment, /Do not add Arab Bank systems, policies/);
});

test("idea questions remain tied to the five required topics and avoid sensitive data", () => {
  const questions = prompt("idea.questions");
  assert.match(questions, /Generate exactly five useful follow-up questions/);
  assert.match(questions, /`beneficiaries`[\s\S]*`current_process`[\s\S]*`needed`[\s\S]*`risks`[\s\S]*`success_measure`/);
  assert.match(questions, /Never ask for customer names, account or card numbers, credentials/);
});

test("preflight distinguishes safety eligibility from ordinary idea completeness", () => {
  const preflight = prompt("idea.preflight");
  assert.match(preflight, /Ordinary incompleteness is not a safety violation/);
  assert.match(preflight, /Missing detail may be listed without blocking safe processing/);
  assert.match(preflight, /never invent a reference/);
});
