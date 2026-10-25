import { z } from "zod";
export const quizIdSchema = z.coerce.number().int().positive();
export const attemptIdSchema = z.coerce.number().int().positive();
export const idempotencySchema = z.string().trim().min(8).max(200);
export const submitAnswersSchema = z.strictObject({
    answers: z.array(z.strictObject({
        questionId: z.number().int().positive(),
        optionKey: z.string().trim().min(1).max(40),
    })).max(200),
});
export const rankingScopeSchema = z.enum(["bank", "department"]);
export const challengeJoinSchema = z.strictObject({
    idempotencyKey: idempotencySchema.optional(),
});
