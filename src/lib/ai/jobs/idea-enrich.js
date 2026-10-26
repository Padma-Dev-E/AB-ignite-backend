import { IdeaEnrichmentOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, objectResponseSchema } from "./helpers";
export const ideaEnrichJob = defineIdeaJob({
    key: "idea.enrich",
    inputSchema: ideaInputSchema.describe("Idea submission context: kind, title, summary, problem, solution, benefits, risks, category, structured answers, metrics, evidence, related ideas, and differentiation."),
    outputSchema: IdeaEnrichmentOutputSchema,
    responseJsonSchema: objectResponseSchema({
        suggestedTitle: { type: "string", description: "Short, specific, author-editable title for the proposed change or outcome.", minLength: 3, maxLength: 120 },
        conciseSummary: { type: "string", description: "One or two sentences summarizing this specific proposal.", minLength: 1, maxLength: 1_000 },
        problemStatement: { type: "string", description: "Current problem and affected users, grounded in the supplied submission.", minLength: 1, maxLength: 2_000 },
        solutionStatement: { type: "string", description: "The change proposed by the author; identify missing detail for confirmation instead of making it up.", minLength: 1, maxLength: 2_000 },
        valueStatement: { type: "string", description: "Expected benefit connected to the supplied context, without inventing quantified impact.", minLength: 1, maxLength: 2_000 },
        riskStatement: { type: "string", description: "Stated risks and practical mitigations; request confirmation when the submission lacks detail.", minLength: 1, maxLength: 2_000 },
        tags: { type: "array", description: "Short, evidence-grounded topic tags.", items: { type: "string", minLength: 1, maxLength: 80 }, maxItems: 20 },
        taxonomy: { type: "array", description: "Specific proposal themes supported by the submission.", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 10 },
        affectedTeams: { type: "array", description: "Only teams explicitly identified or clearly supported by the supplied context.", items: { type: "string", minLength: 1, maxLength: 120 }, maxItems: 20 },
        assumptions: { type: "array", description: "Unverified inferences clearly labeled as assumptions, not evidence.", items: { type: "string", minLength: 1, maxLength: 500 }, maxItems: 20 },
    }, ["suggestedTitle", "conciseSummary", "problemStatement", "solutionStatement", "valueStatement", "riskStatement", "tags", "taxonomy", "affectedTeams", "assumptions"]),
});
