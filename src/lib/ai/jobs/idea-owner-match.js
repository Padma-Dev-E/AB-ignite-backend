import { z } from "zod";
import { defineIdeaJob, ideaSafety, objectResponseSchema } from "./helpers";
export const IDEA_OWNER_MATCH_MAX_SUMMARY_CHARS = 8_000;
export const IDEA_OWNER_MATCH_MAX_CANDIDATES = 12;
export const IDEA_OWNER_MATCH_MAX_PROFILE_CHARS = 1_000;
export const IDEA_OWNER_MATCH_MAX_RATIONALE_CHARS = 400;
const ownerCandidateSchema = z.strictObject({
    candidateOwnerId: z.number().int().positive().safe(),
    businessProfile: z.string().trim().min(1).max(IDEA_OWNER_MATCH_MAX_PROFILE_CHARS),
});
export const ideaOwnerMatchInputSchema = z.strictObject({
    ideaSummary: z.string().trim().min(1).max(IDEA_OWNER_MATCH_MAX_SUMMARY_CHARS)
        .describe("Safe, sanitized summary of the idea to match; do not include author identity or sensitive data."),
    candidates: z.array(ownerCandidateSchema).min(1).max(IDEA_OWNER_MATCH_MAX_CANDIDATES)
        .describe("Pre-filtered active business owners only; include each candidate's positive database ID and bounded capability profile."),
}).superRefine(({ candidates }, context) => {
    const seen = new Set();
    for (const [index, candidate] of candidates.entries()) {
        if (seen.has(candidate.candidateOwnerId)) {
            context.addIssue({ code: "custom", path: ["candidates", index, "candidateOwnerId"], message: "Candidate owner IDs must be unique." });
        }
        seen.add(candidate.candidateOwnerId);
    }
});
export const ideaOwnerMatchOutputSchema = z.strictObject({
    candidateOwnerId: z.number().int().positive().safe().nullable(),
    confidence: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(IDEA_OWNER_MATCH_MAX_RATIONALE_CHARS),
});
/** Validate the model's recommendation against the request-scoped candidate allowlist. */
export function validateIdeaOwnerMatchOutput(input, output) {
    const parsed = ideaOwnerMatchOutputSchema.safeParse(output);
    if (!parsed.success || parsed.data.candidateOwnerId === null)
        return parsed;
    if (input.candidates.some((candidate) => candidate.candidateOwnerId === parsed.data.candidateOwnerId))
        return parsed;
    return {
        success: false,
        error: new z.ZodError([{
                code: "custom",
                path: ["candidateOwnerId"],
                message: "Recommended owner ID is not in the supplied candidate set.",
            }]),
    };
}
export const ideaOwnerMatchJob = {
    ...defineIdeaJob({
        key: "idea.owner_match",
        version: "1",
        inputSchema: ideaOwnerMatchInputSchema,
        outputSchema: ideaOwnerMatchOutputSchema,
        responseJsonSchema: objectResponseSchema({
            candidateOwnerId: {
                anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }],
                description: "An exact candidateOwnerId from the supplied candidates, or null when none is supported.",
            },
            confidence: {
                type: "number",
                description: "Confidence in this evidence-based match from 0 (no support) to 1 (strong profile fit).",
                minimum: 0,
                maximum: 1,
            },
            rationale: {
                type: "string",
                description: "Concise explanation citing relevant capability stated in the selected profile, or why no profile fits.",
                minLength: 1,
                maxLength: IDEA_OWNER_MATCH_MAX_RATIONALE_CHARS,
            },
        }, ["candidateOwnerId", "confidence", "rationale"]),
    }),
    safety: { ...ideaSafety, maxInputChars: 24_000 },
};
