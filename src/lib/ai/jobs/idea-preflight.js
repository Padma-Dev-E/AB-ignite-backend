import { IdeaPreflightOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonDuplicate, objectResponseSchema } from "./helpers";
export const ideaPreflightJob = defineIdeaJob({
    key: "idea.preflight",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaPreflightOutputSchema,
    responseJsonSchema: objectResponseSchema({
        decision: { type: "string", enum: ["allow", "needs_human_review", "block"] },
        safeToProcess: { type: "boolean" },
        missingFields: { type: "array", items: { type: "string" }, maxItems: 20 },
        piiFound: { type: "boolean" }, secretFound: { type: "boolean" }, promptInjectionDetected: { type: "boolean" },
        duplicateCandidates: { type: "array", items: jsonDuplicate, maxItems: 20 },
        notes: { type: "array", items: { type: "string" }, maxItems: 20 },
    }, ["decision", "safeToProcess", "missingFields", "piiFound", "secretFound", "promptInjectionDetected", "duplicateCandidates", "notes"]),
});
