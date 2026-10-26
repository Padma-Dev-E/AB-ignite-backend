import { IdeaEstimateOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonImpact, objectResponseSchema } from "./helpers";
export const ideaEstimateJob = defineIdeaJob({
    key: "idea.estimate",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaEstimateOutputSchema,
    responseJsonSchema: objectResponseSchema({ estimatedImpact: jsonImpact, assumptions: { type: "array", items: { type: "string" }, maxItems: 20 }, confidence: { type: "number", minimum: 0, maximum: 1 }, evidenceGaps: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["estimatedImpact", "assumptions", "confidence", "evidenceGaps"]),
});
