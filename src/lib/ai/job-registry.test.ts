import assert from "node:assert/strict";
import test from "node:test";
import { getAiJob } from "./registry.js";
import "./jobs/index.js";

test("API job entrypoint registers validation and development jobs in the API registry", () => {
  const validation = getAiJob("idea.validate");
  assert.equal(validation.key, "idea.validate");
  assert.equal(validation.version, "3");
  assert.equal(getAiJob("idea.enrich", "1").key, "idea.enrich");
  assert.equal(getAiJob("idea.questions", "2").key, "idea.questions");
});
