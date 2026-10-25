import { z } from "zod";

const boundedText = (max: number) => z.string().trim().min(1).max(max);

export const RiskFindingSchema = z.strictObject({
  category: z.enum(["privacy", "security", "regulatory", "operational", "financial", "reputational", "model", "data"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  description: boundedText(2_000),
  mitigations: z.array(boundedText(500)).max(10),
  requiresHumanReview: z.boolean(),
});

export const RiskFindingListSchema = z.array(RiskFindingSchema).max(20);

export const ClarifyingQuestionSchema = z.strictObject({
  id: boundedText(80),
  question: boundedText(500),
  reason: boundedText(500),
  required: z.boolean(),
  answerType: z.enum(["text", "number", "boolean", "date", "choice"]),
});

export const DuplicateCandidateSchema = z.strictObject({
  reference: boundedText(120),
  similarity: z.number().min(0).max(1),
  reason: boundedText(500),
});

export const RecommendedRouteSchema = z.strictObject({
  department: boundedText(120),
  category: boundedText(120),
  reviewers: z.array(boundedText(120)).max(20),
  controlReviews: z.array(boundedText(120)).max(20),
});

export const EstimatedImpactSchema = z.strictObject({
  benefits: z.array(boundedText(500)).max(20),
  affectedUsers: boundedText(500),
  timeSaved: boundedText(200),
  costBand: z.enum(["unknown", "low", "medium", "high"]),
  effortBand: z.enum(["unknown", "small", "medium", "large"]),
  timeToValue: boundedText(200),
  confidence: z.number().min(0).max(1),
});

export const NextActionSchema = z.strictObject({
  action: boundedText(500),
  ownerRole: z.enum(["author", "business_owner", "back_office", "delivery"]),
  priority: z.enum(["low", "medium", "high"]),
  dueInDays: z.number().int().min(0).max(365).optional(),
});

export type RiskFinding = z.infer<typeof RiskFindingSchema>;
export type ClarifyingQuestion = z.infer<typeof ClarifyingQuestionSchema>;
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;
export type RecommendedRoute = z.infer<typeof RecommendedRouteSchema>;
export type EstimatedImpact = z.infer<typeof EstimatedImpactSchema>;
export type NextAction = z.infer<typeof NextActionSchema>;
