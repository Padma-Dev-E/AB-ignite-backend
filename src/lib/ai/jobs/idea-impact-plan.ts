import { ImpactPlanInputSchema, IdeaImpactPlanOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, jsonMetric, objectResponseSchema } from "./helpers";

export const ideaImpactPlanJob = defineIdeaJob({
  key: "idea.impact_plan",
  inputSchema: ImpactPlanInputSchema,
  outputSchema: IdeaImpactPlanOutputSchema,
  responseJsonSchema: objectResponseSchema({ metrics: { type: "array", items: jsonMetric, maxItems: 20 }, instrumentationNeeds: { type: "array", items: { type: "string" }, maxItems: 20 }, successCriteria: { type: "array", items: { type: "string" }, maxItems: 20 }, failureCriteria: { type: "array", items: { type: "string" }, maxItems: 20 }, confidence: { type: "number", minimum: 0, maximum: 1 }, measurementOwner: { type: "string" } }, ["metrics", "instrumentationNeeds", "successCriteria", "failureCriteria", "confidence", "measurementOwner"]),
});
