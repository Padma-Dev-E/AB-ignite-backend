import assert from "node:assert/strict";
import test from "node:test";
import { canDevelopIdea, isAiRetryLimitReached, shouldReuseCompletedDevelopmentRun } from "./development";

test("only the author may develop an unsubmitted idea without preflight", () => {
  const idea = { authorId: 4, status: "screening" };
  assert.equal(canDevelopIdea(idea, 4, false), true);
  assert.equal(canDevelopIdea(idea, 5, false), false);
  assert.equal(canDevelopIdea(idea, 4, true), false);
  assert.equal(canDevelopIdea({ ...idea, status: "business_review" }, 4, false), false);
});

test("enrichment requests always run fresh and are not capped for an unchanged draft", () => {
  assert.equal(shouldReuseCompletedDevelopmentRun("enrich"), false);
  assert.equal(isAiRetryLimitReached("enrich", 3), false);
  assert.equal(isAiRetryLimitReached("enrich", 100), false);
});

test("completed question runs can be reused and other AI actions retain the retry cap", () => {
  assert.equal(shouldReuseCompletedDevelopmentRun("questions"), true);
  assert.equal(shouldReuseCompletedDevelopmentRun("validate"), false);
  assert.equal(isAiRetryLimitReached("questions", 2), false);
  assert.equal(isAiRetryLimitReached("questions", 3), true);
  assert.equal(isAiRetryLimitReached("validate", 3), true);
});
