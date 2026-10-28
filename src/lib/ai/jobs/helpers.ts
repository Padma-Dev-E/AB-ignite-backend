import type { AiJobDefinition, JsonSchema } from "../types";
import type { SafeAiInput } from "../policy";
import { IdeaAnalysisInputSchema, type IdeaAnalysisInput } from "../../ideas/schemas";

export const ideaSafety = {
  maxInputChars: 30_000,
  allowedDataClassification: "internal" as const,
  blockRestricted: true,
  blockSensitive: true,
};

export const ideaInputSchema = IdeaAnalysisInputSchema;

export function objectResponseSchema(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const jsonRiskFinding: JsonSchema = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["privacy", "security", "regulatory", "operational", "financial", "reputational", "model", "data"] }, severity: { type: "string", enum: ["low", "medium", "high", "critical"] }, description: { type: "string" },
    mitigations: { type: "array", items: { type: "string" }, maxItems: 10 }, requiresHumanReview: { type: "boolean" },
  },
  required: ["category", "severity", "description", "mitigations", "requiresHumanReview"],
};
export const jsonQuestion: JsonSchema = {
  type: "object",
  properties: { id: { type: "string" }, question: { type: "string" }, reason: { type: "string" }, required: { type: "boolean" }, answerType: { type: "string", enum: ["text", "number", "boolean", "date", "choice"] } },
  required: ["id", "question", "reason", "required", "answerType"],
};
export const jsonDuplicate: JsonSchema = {
  type: "object",
  properties: { reference: { type: "string" }, similarity: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string" } },
  required: ["reference", "similarity", "reason"],
};
export const jsonRoute: JsonSchema = {
  type: "object",
  properties: { department: { type: "string" }, category: { type: "string" }, reviewers: { type: "array", items: { type: "string" } }, controlReviews: { type: "array", items: { type: "string" } } },
  required: ["department", "category", "reviewers", "controlReviews"],
};
export const jsonImpact: JsonSchema = {
  type: "object",
  properties: { benefits: { type: "array", items: { type: "string" } }, affectedUsers: { type: "string" }, timeSaved: { type: "string" }, costBand: { type: "string", enum: ["unknown", "low", "medium", "high"] }, effortBand: { type: "string", enum: ["unknown", "small", "medium", "large"] }, timeToValue: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 } },
  required: ["benefits", "affectedUsers", "timeSaved", "costBand", "effortBand", "timeToValue", "confidence"],
};
export const jsonNextAction: JsonSchema = {
  type: "object",
  properties: { action: { type: "string" }, ownerRole: { type: "string", enum: ["author", "business_owner", "admin", "delivery"] }, priority: { type: "string", enum: ["low", "medium", "high"] }, dueInDays: { type: "integer", minimum: 0, maximum: 365 } },
  required: ["action", "ownerRole", "priority"],
};
export const jsonMetric: JsonSchema = {
  type: "object",
  properties: { name: { type: "string" }, baseline: { type: "string" }, target: { type: "string" }, owner: { type: "string" }, measurementWindow: { type: "string" } },
  required: ["name", "baseline", "target", "owner", "measurementWindow"],
};
export const jsonOption: JsonSchema = {
  type: "object",
  properties: { name: { type: "string" }, description: { type: "string" }, tradeoffs: { type: "array", items: { type: "string" } } },
  required: ["name", "description", "tradeoffs"],
};
export const jsonScore: JsonSchema = {
  type: "object",
  properties: {
    score: { type: "number", description: "Score from 0 to 5 using the shared quality anchors; higher means stronger support, not stronger wording.", minimum: 0, maximum: 5 },
    rationale: { type: "string", description: "Briefly cite supplied idea details supporting the score and note the most material limitation, if any." },
  },
  required: ["score", "rationale"],
};
const scoreDescriptions: Record<string, string> = {
  novelty: "Distinctiveness supported by supplied context; do not claim no similar idea exists without evidence.",
  problemClarity: "How clearly the current problem, process, and affected group are described.",
  customerImpact: "Credible customer benefit, only when the proposal supports a customer effect.",
  employeeImpact: "Credible employee or team benefit supported by the proposal.",
  strategicAlignment: "Alignment to a goal explicitly supplied in context; do not invent bank strategy.",
  feasibility: "Plausibility of the implementation path given supplied information and material dependencies.",
  value: "Proportionate expected benefit relative to the problem and effort described.",
  risk: "Risk readiness: how well material risks are understood and mitigations are plausible; this is not risk severity.",
  urgency: "Evidence of time sensitivity, recurring harm, or cost of delay.",
  scalability: "Evidence the approach can extend to additional users or processes without unsupported assumptions.",
};
export const jsonScores: JsonSchema = {
  type: "object",
  properties: Object.fromEntries(Object.entries(scoreDescriptions).map(([key, description]) => [key, {
    ...jsonScore,
    description,
    properties: {
      ...jsonScore.properties,
      score: { ...jsonScore.properties?.score, description: `${description} Use the shared 0–5 rubric.` },
    },
  }])),
  required: Object.keys(scoreDescriptions),
};

export function defineIdeaJob<TInput = IdeaAnalysisInput, TOutput = unknown>(definition: {
  key: string;
  inputSchema: AiJobDefinition<TInput, TOutput>["inputSchema"];
  outputSchema: AiJobDefinition<TInput, TOutput>["outputSchema"];
  responseJsonSchema: JsonSchema;
  version?: string;
}): AiJobDefinition<TInput, TOutput> {
  return {
    ...definition,
    version: definition.version ?? "1",
    model: undefined,
    buildInput: (_input: TInput, safeInput: SafeAiInput) => safeInput.serialized,
    safety: ideaSafety,
  };
}
