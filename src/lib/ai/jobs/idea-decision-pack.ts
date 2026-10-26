import { DecisionPackInputSchema, IdeaDecisionPackOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, jsonOption, jsonQuestion, jsonRiskFinding, objectResponseSchema } from "./helpers";

export const ideaDecisionPackJob = defineIdeaJob({
  key: "idea.decision_pack",
  inputSchema: DecisionPackInputSchema,
  outputSchema: IdeaDecisionPackOutputSchema,
  responseJsonSchema: objectResponseSchema({ summary: { type: "string" }, evidence: { type: "array", items: { type: "string" }, maxItems: 30 }, unresolvedQuestions: { type: "array", items: jsonQuestion, maxItems: 20 }, risks: { type: "array", items: jsonRiskFinding, maxItems: 20 }, controls: { type: "array", items: { type: "string" }, maxItems: 20 }, options: { type: "array", items: jsonOption, maxItems: 10 }, recommendation: { type: "string" }, humanChecklist: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["summary", "evidence", "unresolvedQuestions", "risks", "controls", "options", "recommendation", "humanChecklist"]),
});
