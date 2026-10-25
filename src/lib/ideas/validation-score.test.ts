import assert from "node:assert/strict";
import test from "node:test";
import { ideaValidationPasses, normalizeIdeaValidationScore } from "./validation-score";
import { IdeaValidationOutputSchema } from "./schemas";
import { ideaValidateJob } from "../ai/jobs/idea-validate";

test("validation score is 0–10, including persisted 0–100 scores", () => {
  assert.equal(normalizeIdeaValidationScore(7), 7);
  assert.equal(normalizeIdeaValidationScore(7.01), 7.01);
  assert.equal(normalizeIdeaValidationScore(70), 7);
  assert.equal(normalizeIdeaValidationScore(71), 7.1);
  assert.equal(normalizeIdeaValidationScore(100), 10);
  for (const value of [undefined, null, "8", NaN, Infinity, -1, 101]) {
    assert.equal(normalizeIdeaValidationScore(value), null);
  }
});

test("only a normalized score strictly above seven passes, regardless of review advisory", () => {
  for (const score of [0, 7, 70, undefined, 101]) {
    assert.equal(ideaValidationPasses({ overallScore: score, decision: "accept" }), false);
  }
  for (const score of [7.01, 71, 10, 100]) {
    assert.equal(ideaValidationPasses({ overallScore: score, decision: "needs_human_review" }), true);
  }
  assert.equal(ideaValidationPasses(null), false);
});

test("new AI validation outputs request a 0–10 score", () => {
  assert.equal(IdeaValidationOutputSchema.shape.overallScore.safeParse(10).success, true);
  assert.equal(IdeaValidationOutputSchema.shape.overallScore.parse(71), 7.1);
  assert.equal(IdeaValidationOutputSchema.shape.overallScore.safeParse(101).success, false);
  const scoreSchema = ideaValidateJob.responseJsonSchema.properties?.overallScore;
  assert.equal(scoreSchema?.maximum, 10);
  assert.match(ideaValidateJob.systemPrompt, /strictly above 7/);
  assert.match(ideaValidateJob.systemPrompt, /needs_human_review as an advisory/i);
});
