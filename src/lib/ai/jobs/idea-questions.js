import { IdeaQuestionsOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonQuestion, objectResponseSchema, reviewSystemBoundary } from "./helpers";
export const ideaQuestionsJob = defineIdeaJob({
    key: "idea.questions",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaQuestionsOutputSchema,
    systemPrompt: `${reviewSystemBoundary} Identify the smallest set of specific questions needed to understand users, baseline, evidence, dependencies, controls, cost, and implementation constraints. Mark required questions and provide an answer type.`,
    responseJsonSchema: objectResponseSchema({ completeness: { type: "number", minimum: 0, maximum: 1 }, questions: { type: "array", items: jsonQuestion, maxItems: 20 } }, ["completeness", "questions"]),
});
