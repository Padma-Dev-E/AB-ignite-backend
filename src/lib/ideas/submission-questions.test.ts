import assert from "node:assert/strict";
import test from "node:test";
import { IdeaSubmissionDetailsSchema } from "./schemas.js";

const base = {
  metrics: { turnaround: 1, volume: 1, value: 1 },
};

test("idea submission accepts and preserves idea-specific question answers", () => {
  const result = IdeaSubmissionDetailsSchema.parse({
    ...base,
    answers: {
      "Which onboarding step causes the most repeat calls?": "Identity verification, based on the current call log review.",
      "How will staff confirm the new flow worked?": "Compare repeat calls before and after rollout.",
    },
  });
  assert.equal(Object.keys(result.answers).length, 2);
  assert.equal(result.answers["Which onboarding step causes the most repeat calls?"], "Identity verification, based on the current call log review.");
});

test("idea submission accepts no follow-up questions and rejects more than eight or oversized labels", () => {
  assert.equal(IdeaSubmissionDetailsSchema.safeParse({ ...base, answers: {} }).success, true);
  assert.equal(IdeaSubmissionDetailsSchema.safeParse({ ...base, answers: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`Question ${index + 1}`, "Answer"])) }).success, false);
  assert.equal(IdeaSubmissionDetailsSchema.safeParse({ ...base, answers: { ["q".repeat(501)]: "Answer" } }).success, false);
});
