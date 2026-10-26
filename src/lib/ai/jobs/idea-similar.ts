import { IdeaSimilarOutputSchema } from "../../ideas/schemas";
import { defineIdeaJob, ideaInputSchema, jsonDuplicate, objectResponseSchema } from "./helpers";

export const ideaSimilarJob = defineIdeaJob({
  key: "idea.similar",
  inputSchema: ideaInputSchema,
  outputSchema: IdeaSimilarOutputSchema,
  responseJsonSchema: objectResponseSchema({ duplicates: { type: "array", items: jsonDuplicate, maxItems: 20 }, relatedThemes: { type: "array", items: { type: "string" }, maxItems: 20 }, rationale: { type: "string" } }, ["duplicates", "relatedThemes", "rationale"]),
});
