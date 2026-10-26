/** An AI development request is an author-only operation on a proposal awaiting submission. */
export function canDevelopIdea(idea: { authorId: number; status: string }, userId: number, hasPreflight: boolean) {
  return idea.authorId === userId && (idea.status === "draft" || idea.status === "screening") && !hasPreflight;
}

export type IdeaDevelopmentAction = "enrich" | "questions" | "validate";

/** Reuse generated questions, but let authors request a fresh enrichment or validation. */
export function shouldReuseCompletedDevelopmentRun(action: IdeaDevelopmentAction) {
  return action === "questions";
}

/** Enrichment is an author-driven rewrite and may be requested repeatedly for the same version. */
export function isAiRetryLimitReached(action: IdeaDevelopmentAction, runCount: number, limit = 3) {
  return action !== "enrich" && runCount >= limit;
}
