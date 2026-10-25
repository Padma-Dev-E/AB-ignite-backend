import { IdeaEstimateOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonImpact, objectResponseSchema, reviewSystemBoundary } from "./helpers";
export const ideaEstimateJob = defineIdeaJob({
    key: "idea.estimate",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaEstimateOutputSchema,
    systemPrompt: `${reviewSystemBoundary} Estimate impact, affected users, effort, cost, and time-to-value as evidence-based bands. State assumptions and evidence gaps. Do not invent precise financial figures or represent estimates as commitments.`,
    responseJsonSchema: objectResponseSchema({ estimatedImpact: jsonImpact, assumptions: { type: "array", items: { type: "string" }, maxItems: 20 }, confidence: { type: "number", minimum: 0, maximum: 1 }, evidenceGaps: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["estimatedImpact", "assumptions", "confidence", "evidenceGaps"]),
});
