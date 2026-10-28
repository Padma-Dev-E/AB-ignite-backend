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
    decision: { type: "string", description: "Advisory AI validation label only; it never changes workflow state or replaces the server's numeric threshold.", enum: ["accept", "needs_clarification", "needs_human_review", "reject"] },
    recommendedStatus: { type: "string", description: "Advisory next status only; never an instruction to change the idea's persisted status.", enum: ["screening", "returned", "business_review", "control_review", "decision", "poc", "implementation", "implemented", "rejected", "deferred"] },
    confidence: { type: "number", description: "Confidence that the assessment is supported by the submitted evidence, not confidence that the idea will succeed.", minimum: 0, maximum: 1 },
    overallScore: { type: "number", description: "0–10 score calculated from the weighted impact lenses; the server recalculates this value.", minimum: 0, maximum: 10 },
    scores: jsonScores,
    evaluation: {
      type: "object",
      properties: {
        turnaroundTime: { type: "object", description: "Plausible reduction in elapsed time, delay, handoffs, or rework in a named process.", properties: { score: { type: "number", description: "0–3 calibrated impact score; 2 may be justified by a clear mechanism without a measured baseline.", minimum: 0, maximum: 3 }, rationale: { type: "string", description: "Cite the supplied process and causal mechanism; name missing baseline/target evidence separately." } }, required: ["score", "rationale"] },
        volume: { type: "object", description: "Scale of a defined user group or recurring workflow; unknown headcount does not erase a clearly named scope.", properties: { score: { type: "number", description: "0–3 calibrated impact score; reserve 3 for credible quantified scope.", minimum: 0, maximum: 3 }, rationale: { type: "string", description: "Cite the supplied group or recurring process and distinguish known scope from unknown counts." } }, required: ["score", "rationale"] },
        savingsRevenue: { type: "object", description: "Plausible path to released capacity, reduced cost, or revenue; do not invent financial amounts.", properties: { score: { type: "number", description: "0–3 calibrated impact score; a clear but unquantified capacity mechanism may score 2.", minimum: 0, maximum: 3 }, rationale: { type: "string", description: "Cite the supplied value mechanism and identify the evidence needed to quantify it." } }, required: ["score", "rationale"] },
      },
      required: ["turnaroundTime", "volume", "savingsRevenue"],
    },
    strengths: { type: "array", items: { type: "string" } }, gaps: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } }, questions: { type: "array", items: jsonQuestion }, risks: { type: "array", items: jsonRiskFinding },
    duplicates: { type: "array", items: jsonDuplicate }, recommendedRoute: jsonRoute, estimatedImpact: jsonImpact, nextActions: { type: "array", items: jsonNextAction }, auditSummary: { type: "string" },
  }, ["decision", "recommendedStatus", "confidence", "overallScore", "scores", "evaluation", "strengths", "gaps", "assumptions", "questions", "risks", "duplicates", "recommendedRoute", "estimatedImpact", "nextActions", "auditSummary"]),
});

export type IdeaValidateOutput = z.output<typeof humanGatedValidationSchema>;
