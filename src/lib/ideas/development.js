/** An AI development request is an author-only operation on a proposal awaiting submission. */
export function canDevelopIdea(idea, userId, hasPreflight) {
    return idea.authorId === userId && (idea.status === "draft" || idea.status === "screening") && !hasPreflight;
}
