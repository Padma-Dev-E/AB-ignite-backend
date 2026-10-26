import { z } from "zod";
import { IdeaValidationOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonDuplicate, jsonImpact, jsonNextAction, jsonQuestion, jsonRiskFinding, jsonRoute, jsonScores, objectResponseSchema } from "./helpers";

export function weightedValidationScore(evaluation: {
  turnaroundTime: { score: number };
  volume: { score: number };
  savingsRevenue: { score: number };
}) {
  const score = ((evaluation.turnaroundTime.score * 0.3 + evaluation.volume.score * 0.3 + evaluation.savingsRevenue.score * 0.4) / 3) * 10;
  return Math.round(score * 100) / 100;
}

const humanGatedValidationSchema = IdeaValidationOutputSchema.transform((value) => {
  const overallScore = value.evaluation
    ? weightedValidationScore(value.evaluation)
    : value.overallScore;
  const highRisk = value.risks.some((risk) => risk.severity === "high" || risk.severity === "critical");
  if ((highRisk || value.confidence < 0.5) && value.decision !== "needs_human_review") {
    return { ...value, overallScore, decision: "needs_human_review" as const, recommendedStatus: "business_review" as const };
  }
  return { ...value, overallScore };
});

export const ideaValidateJob = defineIdeaJob({
  key: "idea.validate",
  version: "3",
  inputSchema: ideaInputSchema,
  outputSchema: humanGatedValidationSchema,
  responseJsonSchema: objectResponseSchema({
    decision: { type: "string", enum: ["accept", "needs_clarification", "needs_human_review", "reject"] },
    recommendedStatus: { type: "string", enum: ["screening", "returned", "business_review", "control_review", "decision", "poc", "implementation", "implemented", "rejected", "deferred"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, overallScore: { type: "number", minimum: 0, maximum: 10 },
    scores: jsonScores,
    evaluation: {
      type: "object",
      properties: {
        turnaroundTime: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 3 }, rationale: { type: "string" } }, required: ["score", "rationale"] },
        volume: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 3 }, rationale: { type: "string" } }, required: ["score", "rationale"] },
        savingsRevenue: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 3 }, rationale: { type: "string" } }, required: ["score", "rationale"] },
      },
      required: ["turnaroundTime", "volume", "savingsRevenue"],
    },
    strengths: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } }, questions: { type: "array", items: jsonQuestion }, risks: { type: "array", items: jsonRiskFinding },
    duplicates: { type: "array", items: jsonDuplicate }, recommendedRoute: jsonRoute, estimatedImpact: jsonImpact, nextActions: { type: "array", items: jsonNextAction }, auditSummary: { type: "string" },
  }, ["decision", "recommendedStatus", "confidence", "overallScore", "scores", "evaluation", "strengths", "gaps", "assumptions", "questions", "risks", "duplicates", "recommendedRoute", "estimatedImpact", "nextActions", "auditSummary"]),
});

export type IdeaValidateOutput = z.output<typeof humanGatedValidationSchema>;
