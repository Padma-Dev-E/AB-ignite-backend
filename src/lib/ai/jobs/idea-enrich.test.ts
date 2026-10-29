import assert from "node:assert/strict";
import test from "node:test";
import { ideaEnrichJob } from "./idea-enrich";
import { aiPromptSeeds } from "../prompts/seed-data";

test("enrichment prompt uses the submitted idea context and avoids invented evidence", () => {
  const prompt = aiPromptSeeds.find((item) => item.jobKey === "idea.enrich")?.systemPrompt ?? "";
  assert.match(prompt, /title, summary, problem, solution, benefits, risks, category/i);
  assert.match(prompt, /answers.*metrics.*evidence.*relatedIdeas.*differentiation/i);
  assert.match(prompt, /Do not add Arab Bank systems, policies, products, customer facts.*unless the author supplied them/i);
  assert.match(prompt, /suggestedTitle/i);
});

test("enrichment JSON schema describes concise, usable proposal fields", () => {
  const properties = ideaEnrichJob.responseJsonSchema.properties ?? {};
  assert.equal(properties.suggestedTitle?.type, "string");
  assert.ok(properties.suggestedTitle?.description);
  assert.equal(properties.suggestedTitle?.maxLength, 120);
  assert.ok(properties.problemStatement?.description);
  assert.ok(properties.solutionStatement?.description);
  assert.ok(properties.valueStatement?.description);
  assert.ok(properties.riskStatement?.description);
});

test("enrichment accepts the idea-specific answers, measures, evidence, and relationships", () => {
  const result = ideaEnrichJob.inputSchema.safeParse({
    kind: "idea",
    title: "Reduce manual fee reversals",
    summary: "Give operations a controlled workflow to resolve eligible fee reversals.",
    problem: "Staff currently review each reversal across separate tools.",
    solution: "Add a guided workflow with eligibility checks and an audit record.",
    benefits: "Reduce handling time and improve traceability.",
    risks: "Incorrect eligibility rules could reverse an ineligible fee.",
    category: "Operations",
    answers: {
      beneficiaries: "Operations staff and customers awaiting resolution.",
      currentProcess: "Staff compare account and transaction records manually.",
      needed: "A guided, auditable review flow.",
      risks: "Incorrect eligibility decisions.",
      successMeasure: "Lower median handling time without increased corrections.",
    },
    metrics: { turnaround: 2, volume: 1, value: 2, turnaroundExplanation: "Several minutes per case." },
    evidence: ["The operations team reports repeated manual cross-checks."],
    relatedIdeas: ["Account servicing workflow"],
    differentiation: "This proposal focuses on fee reversals and eligibility controls.",
  });

  assert.equal(result.success, true);
});
