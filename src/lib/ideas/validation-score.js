/** Persisted validation runs before the 0–10 change used a 0–100 scale. */
export const IDEA_VALIDATION_PASS_SCORE = 7;
export function normalizeIdeaValidationScore(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
        return null;
    return value > 10 ? value / 10 : value;
}
/** AI review labels are advisory; the successful run's score controls draft progression. */
export function ideaValidationPasses(result) {
    if (!result || typeof result !== "object")
        return false;
    const score = normalizeIdeaValidationScore(result.overallScore);
    return score !== null && score > IDEA_VALIDATION_PASS_SCORE;
}
