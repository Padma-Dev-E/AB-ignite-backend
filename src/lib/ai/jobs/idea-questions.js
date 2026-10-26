import { IdeaQuestionsOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, objectResponseSchema } from "./helpers";
export const ideaQuestionsJob = defineIdeaJob({
    key: "idea.questions",
    version: "2",
    inputSchema: ideaInputSchema.describe("Idea submission and context used to generate one idea-specific follow-up for each of the five required review topics."),
    outputSchema: IdeaQuestionsOutputSchema,
    responseJsonSchema: objectResponseSchema({
        completeness: { type: "number", description: "How complete the current proposal is for meaningful assessment: 0 means major idea-specific gaps; 1 means no material clarification is needed.", minimum: 0, maximum: 1 },
        questions: {
            type: "array",
            description: "Exactly five idea-specific follow-ups, one for each required review topic, in the required order.",
            minItems: 5,
            maxItems: 5,
            items: {
                type: "object",
                additionalProperties: false,
                properties: {
                    id: { type: "string", description: "Stable short identifier unique within this response.", minLength: 1, maxLength: 80 },
                    topic: { type: "string", description: "The review topic this question addresses.", enum: ["beneficiaries", "current_process", "needed", "risks", "success_measure"] },
                    question: { type: "string", description: "A direct, answerable question grounded in a concrete detail or omission in this idea.", minLength: 1, maxLength: 500 },
                    reason: { type: "string", description: "Why this answer matters for understanding or evaluating this specific proposal.", minLength: 1, maxLength: 500 },
                    required: { type: "boolean", description: "True only when the missing answer blocks meaningful assessment." },
                    answerType: { type: "string", description: "Most suitable response format.", enum: ["text", "number", "boolean", "date", "choice"] },
                },
                required: ["id", "topic", "question", "reason", "required", "answerType"],
            },
        },
    }, ["completeness", "questions"]),
});
