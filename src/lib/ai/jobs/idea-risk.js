import { IdeaRiskOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonRiskFinding, objectResponseSchema, reviewSystemBoundary } from "./helpers";
export const ideaRiskJob = defineIdeaJob({
    key: "idea.risk",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaRiskOutputSchema,
    systemPrompt: `${reviewSystemBoundary} Assess privacy, security, regulatory, operational, financial, reputational, model, and data risks. Identify mitigations and control teams. A risk finding routes to human control review; it never changes status by itself.`,
    responseJsonSchema: objectResponseSchema({ overallRisk: { type: "string", enum: ["low", "medium", "high", "critical", "unknown"] }, risks: { type: "array", items: jsonRiskFinding, maxItems: 20 }, controlReviews: { type: "array", items: { type: "string" }, maxItems: 20 }, requiredMitigations: { type: "array", items: { type: "string" }, maxItems: 20 }, summary: { type: "string" } }, ["overallRisk", "risks", "controlReviews", "requiredMitigations", "summary"]),
});
