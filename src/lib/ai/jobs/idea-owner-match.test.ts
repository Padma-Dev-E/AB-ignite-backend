import assert from "node:assert/strict";
import test from "node:test";
import { ideaOwnerMatchJob, validateIdeaOwnerMatchOutput } from "./idea-owner-match";
import "./index";
import { getAiJob } from "../registry";
import { aiPromptSeeds } from "../prompts/seed-data";

const validInput = {
  ideaSummary: "Reduce repeated manual checks in the fee reversal review process.",
  candidates: [
    { candidateOwnerId: 11, businessProfile: "Owns payments operations and service workflow improvements." },
    { candidateOwnerId: 12, businessProfile: "Leads digital channels and customer onboarding." },
  ],
};

test("owner-match input accepts a bounded idea summary and profiled candidate owners", () => {
  const parsed = ideaOwnerMatchJob.inputSchema.safeParse(validInput);
  assert.equal(parsed.success, true);
});

test("owner-match is registered and exported as version 1", () => {
  assert.equal(getAiJob("idea.owner_match", "1"), ideaOwnerMatchJob);
});

test("owner-match input rejects empty, duplicate, invalid, or excessive candidates", () => {
  const empty = ideaOwnerMatchJob.inputSchema.safeParse({ ...validInput, candidates: [] });
  const duplicate = ideaOwnerMatchJob.inputSchema.safeParse({ ...validInput, candidates: [validInput.candidates[0], validInput.candidates[0]] });
  const invalidId = ideaOwnerMatchJob.inputSchema.safeParse({ ...validInput, candidates: [{ ...validInput.candidates[0], candidateOwnerId: 0 }] });
  const tooMany = ideaOwnerMatchJob.inputSchema.safeParse({
    ...validInput,
    candidates: Array.from({ length: 21 }, (_, index) => ({ candidateOwnerId: index + 1, businessProfile: "Operations" })),
  });

  assert.equal(empty.success, false);
  assert.equal(duplicate.success, false);
  assert.equal(invalidId.success, false);
  assert.equal(tooMany.success, false);
});

test("owner-match input bounds summary and profile text", () => {
  const longSummary = ideaOwnerMatchJob.inputSchema.safeParse({ ...validInput, ideaSummary: "x".repeat(8_001) });
  const longProfile = ideaOwnerMatchJob.inputSchema.safeParse({
    ...validInput,
    candidates: [{ ...validInput.candidates[0], businessProfile: "x".repeat(2_001) }],
  });
  assert.equal(longSummary.success, false);
  assert.equal(longProfile.success, false);
});

test("owner-match output constrains confidence, rationale, and recommendation membership", () => {
  const validOutput = { candidateOwnerId: 11, confidence: 0.82, rationale: "The profile explicitly covers payments operations and workflow ownership." };
  assert.equal(validateIdeaOwnerMatchOutput(validInput, validOutput).success, true);
  assert.equal(validateIdeaOwnerMatchOutput(validInput, { ...validOutput, candidateOwnerId: 99 }).success, false);
  assert.equal(validateIdeaOwnerMatchOutput(validInput, { ...validOutput, confidence: 1.01 }).success, false);
  assert.equal(validateIdeaOwnerMatchOutput(validInput, { ...validOutput, rationale: "x".repeat(401) }).success, false);
  assert.equal(validateIdeaOwnerMatchOutput(validInput, { candidateOwnerId: null, confidence: 0.2, rationale: "No candidate profile supports this subject." }).success, true);
});

test("owner-match prompt requires evidence-based fit and a no-match response", () => {
  const matches = aiPromptSeeds.filter((seed) => seed.jobKey === "idea.owner_match");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].schemaVersion, ideaOwnerMatchJob.version);
  assert.equal(matches[0].usage.length, 1);
  assert.match(matches[0].usage[0].page, /Maintainer/i);
  assert.match(matches[0].systemPrompt, /do not invent.*capabilit/i);
  assert.match(matches[0].systemPrompt, /no candidate/i);
  assert.match(matches[0].systemPrompt, /use only the idea summary and the business profiles in the supplied candidate list/i);
});
