import { IdeaSimilarOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonDuplicate, objectResponseSchema, reviewSystemBoundary } from "./helpers";

export const ideaSimilarJob = defineIdeaJob({
  key: "idea.similar",
  inputSchema: ideaInputSchema,
  outputSchema: IdeaSimilarOutputSchema,
  systemPrompt: `${reviewSystemBoundary} Compare the idea with the supplied related-idea references. Return candidate duplicates and themes with transparent reasons. Never claim a match without evidence and never merge or modify ideas.`,
  responseJsonSchema: objectResponseSchema({ duplicates: { type: "array", items: jsonDuplicate, maxItems: 20 }, relatedThemes: { type: "array", items: { type: "string" }, maxItems: 20 }, rationale: { type: "string" } }, ["duplicates", "relatedThemes", "rationale"]),
});
