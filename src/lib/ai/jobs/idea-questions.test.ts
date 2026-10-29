import assert from "node:assert/strict";
import test from "node:test";
import { ideaQuestionsJob } from "./idea-questions";
import { aiPromptSeeds } from "../prompts/seed-data";

test("question prompt maps idea-specific follow-ups to the five required review topics", () => {
  const prompt = aiPromptSeeds.find((item) => item.jobKey === "idea.questions")?.systemPrompt ?? "";
  assert.match(prompt, /grounded in its matching answer and the full proposal/i);
  assert.match(prompt, /concrete detail or omission in the idea/i);
  assert.match(prompt, /Generate exactly five useful follow-up questions/i);
  assert.match(prompt, /Who benefits/i);
  assert.match(prompt, /What happens today/i);
  assert.match(prompt, /What is needed/i);
  assert.match(prompt, /What could go wrong/i);
  assert.match(prompt, /How is success measured/i);
});

test("question schema requires five questions with a required topic label", () => {
  const response = ideaQuestionsJob.responseJsonSchema.properties ?? {};
  const questionArray = response.questions;
  assert.equal(questionArray?.minItems, 5);
  assert.equal(questionArray?.maxItems, 5);
  const question = questionArray?.items?.properties ?? {};
  assert.deepEqual(question.topic?.enum, ["beneficiaries", "current_process", "needed", "risks", "success_measure"]);
  assert.ok(question.question?.description);
  assert.ok(question.reason?.description);
  assert.ok(questionArray?.items?.required?.includes("topic"));
  assert.deepEqual(question.answerType?.enum, ["text", "number", "boolean", "date", "choice"]);
});

test("questions accept the same idea context as enrichment", () => {
  const result = ideaQuestionsJob.inputSchema.safeParse({
    kind: "idea",
    title: "Reduce manual fee reversals",
    summary: "Give operations a controlled workflow to resolve eligible fee reversals.",
    category: "Operations",
    answers: {
      beneficiaries: "Operations staff and customers awaiting resolution.",
      currentProcess: "Staff compare account and transaction records manually.",
      needed: "A guided, auditable review flow.",
      risks: "Incorrect eligibility decisions.",
      successMeasure: "Lower median handling time without increased corrections.",
    },
    metrics: { turnaround: 2, volume: 1, value: 2 },
    evidence: ["The operations team reports repeated manual cross-checks."],
    relatedIdeas: ["Account servicing workflow"],
  });

  assert.equal(result.success, true);
});
