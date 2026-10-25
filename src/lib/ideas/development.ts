/** An AI development request is an author-only operation on a proposal awaiting submission. */
export function canDevelopIdea(idea: { authorId: number; status: string }, userId: number, hasPreflight: boolean) {
  return idea.authorId === userId && (idea.status === "draft" || idea.status === "screening") && !hasPreflight;
}
