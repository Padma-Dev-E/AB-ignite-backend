import { IdeaValidationOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonDuplicate, jsonImpact, jsonNextAction, jsonQuestion, jsonRiskFinding, jsonRoute, jsonScores, objectResponseSchema, reviewSystemBoundary } from "./helpers";
const humanGatedValidationSchema = IdeaValidationOutputSchema.transform((value) => {
    const highRisk = value.risks.some((risk) => risk.severity === "high" || risk.severity === "critical");
    if ((highRisk || value.confidence < 0.5) && value.decision !== "needs_human_review") {
        return { ...value, decision: "needs_human_review", recommendedStatus: "business_review" };
    }
    return value;
});
export const ideaValidateJob = defineIdeaJob({
    key: "idea.validate",
    inputSchema: ideaInputSchema,
    outputSchema: humanGatedValidationSchema,
    systemPrompt: `${reviewSystemBoundary} Score novelty, problem clarity, customer and employee impact, strategic alignment, feasibility, value, risk, urgency, and scalability from 0 to 5. Set overallScore on a 0 to 10 scale: only a score strictly above 7 passes draft validation; 7 or below means improve the draft and revalidate. Return specific evidence gaps, risks, questions, route, impact, and next actions so the author can improve a low-scoring draft. High risk or low confidence must be marked needs_human_review as an advisory for later review, regardless of score; never make a final bank decision.`,
    responseJsonSchema: objectResponseSchema({
        decision: { type: "string", enum: ["accept", "needs_clarification", "needs_human_review", "reject"] },
        recommendedStatus: { type: "string", enum: ["screening", "returned", "business_review", "control_review", "decision", "poc", "implementation", "implemented", "rejected", "deferred"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, overallScore: { type: "number", minimum: 0, maximum: 10 },
        scores: jsonScores, strengths: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } },
        assumptions: { type: "array", items: { type: "string" } }, questions: { type: "array", items: jsonQuestion }, risks: { type: "array", items: jsonRiskFinding },
        duplicates: { type: "array", items: jsonDuplicate }, recommendedRoute: jsonRoute, estimatedImpact: jsonImpact, nextActions: { type: "array", items: jsonNextAction }, auditSummary: { type: "string" },
    }, ["decision", "recommendedStatus", "confidence", "overallScore", "scores", "strengths", "gaps", "assumptions", "questions", "risks", "duplicates", "recommendedRoute", "estimatedImpact", "nextActions", "auditSummary"]),
});
