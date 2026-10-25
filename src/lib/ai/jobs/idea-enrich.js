import { IdeaEnrichmentOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, objectResponseSchema, reviewSystemBoundary } from "./helpers";
export const ideaEnrichJob = defineIdeaJob({
    key: "idea.enrich",
    inputSchema: ideaInputSchema,
    outputSchema: IdeaEnrichmentOutputSchema,
    systemPrompt: `${reviewSystemBoundary} Structure the proposal into a suggested title, concise summary, problem statement, solution statement, value statement (benefits), and risk statement (risks and mitigations), plus taxonomy, tags, affected teams, and explicit assumptions. Preserve the submitter's intent. Clearly distinguish assumptions from evidence.`,
    responseJsonSchema: objectResponseSchema({
        suggestedTitle: { type: "string" }, conciseSummary: { type: "string" }, problemStatement: { type: "string" }, valueStatement: { type: "string" },
        solutionStatement: { type: "string" }, riskStatement: { type: "string" },
        tags: { type: "array", items: { type: "string" }, maxItems: 20 }, taxonomy: { type: "array", items: { type: "string" }, maxItems: 10 }, affectedTeams: { type: "array", items: { type: "string" }, maxItems: 20 }, assumptions: { type: "array", items: { type: "string" }, maxItems: 20 },
    }, ["suggestedTitle", "conciseSummary", "problemStatement", "solutionStatement", "valueStatement", "riskStatement", "tags", "taxonomy", "affectedTeams", "assumptions"]),
});
