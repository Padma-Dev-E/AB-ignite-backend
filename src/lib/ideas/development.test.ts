import assert from "node:assert/strict";
import test from "node:test";
import { canDevelopIdea } from "./development";

test("only the author may develop an unsubmitted idea without preflight", () => {
  const idea = { authorId: 4, status: "screening" };
  assert.equal(canDevelopIdea(idea, 4, false), true);
  assert.equal(canDevelopIdea(idea, 5, false), false);
  assert.equal(canDevelopIdea(idea, 4, true), false);
  assert.equal(canDevelopIdea({ ...idea, status: "business_review" }, 4, false), false);
});
