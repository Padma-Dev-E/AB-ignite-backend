import { IdeaRouteOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonRoute, objectResponseSchema, reviewSystemBoundary } from "./helpers";
export const ideaRouteJob = defineIdeaJob({
    key: "idea.route",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaRouteOutputSchema,
    systemPrompt: `${reviewSystemBoundary} Recommend a department, category, reviewer groups, control reviews, priority band, and score using only the supplied evidence. Routing and priority are advisory and must be checked by server policy and authorized humans.`,
    responseJsonSchema: objectResponseSchema({ recommendedRoute: jsonRoute, priorityBand: { type: "string", enum: ["Watch", "Quality", "Priority"] }, priorityScore: { type: "number", minimum: 0, maximum: 100 }, confidence: { type: "number", minimum: 0, maximum: 1 }, rationale: { type: "string" } }, ["recommendedRoute", "priorityBand", "priorityScore", "confidence", "rationale"]),
});
