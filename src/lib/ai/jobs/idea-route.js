import { IdeaRouteOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonRoute, objectResponseSchema } from "./helpers";
export const ideaRouteJob = defineIdeaJob({
    key: "idea.route",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaRouteOutputSchema,
    responseJsonSchema: objectResponseSchema({ recommendedRoute: jsonRoute, priorityBand: { type: "string", enum: ["Watch", "Quality", "Priority"] }, priorityScore: { type: "number", minimum: 0, maximum: 100 }, confidence: { type: "number", minimum: 0, maximum: 1 }, rationale: { type: "string" } }, ["recommendedRoute", "priorityBand", "priorityScore", "confidence", "rationale"]),
});
