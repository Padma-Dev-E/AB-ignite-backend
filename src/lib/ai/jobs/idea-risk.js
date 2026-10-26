import { IdeaRiskOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonRiskFinding, objectResponseSchema } from "./helpers";
export const ideaRiskJob = defineIdeaJob({
    key: "idea.risk",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaRiskOutputSchema,
    responseJsonSchema: objectResponseSchema({ overallRisk: { type: "string", enum: ["low", "medium", "high", "critical", "unknown"] }, risks: { type: "array", items: jsonRiskFinding, maxItems: 20 }, controlReviews: { type: "array", items: { type: "string" }, maxItems: 20 }, requiredMitigations: { type: "array", items: { type: "string" }, maxItems: 20 }, summary: { type: "string" } }, ["overallRisk", "risks", "controlReviews", "requiredMitigations", "summary"]),
});
