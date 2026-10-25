import assert from "node:assert/strict";
import test from "node:test";
import { ideaQuestionsJob } from "./idea-questions";

test("question prompt requires idea-specific questions and permits complete ideas", () => {
  assert.match(ideaQuestionsJob.systemPrompt, /specific idea/i);
  assert.match(ideaQuestionsJob.systemPrompt, /reference.*concrete|concrete.*detail/i);
  assert.match(ideaQuestionsJob.systemPrompt, /generic questionnaire|generic questions/i);
  assert.match(ideaQuestionsJob.systemPrompt, /empty questions array/i);
  assert.match(ideaQuestionsJob.systemPrompt, /beneficiaries, currentProcess, needed, risks, successMeasure/i);
});

test("question schema constrains the number and content of generated questions", () => {
  const response = ideaQuestionsJob.responseJsonSchema.properties ?? {};
  const questionArray = response.questions;
  assert.equal(questionArray?.maxItems, 8);
  const question = questionArray?.items?.properties ?? {};
  assert.ok(question.question?.description);
  assert.ok(question.reason?.description);
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
