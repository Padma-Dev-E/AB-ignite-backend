import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db/connection";
import { auditEvents, pointRules, quizCategories, quizChallengeParticipants, quizChallenges, quizOptions, quizQuestions, quizVersions, quizzes, refreshTokens, users, } from "../../../db/schema";
import { isSessionActive } from "../../../auth/security-core";
import { buildAuditRecord } from "../../audit/service";
import { hashAuditValue } from "../../audit/redaction-core";
import { AuthorizationError, requirePrivilegedReason, } from "../../auth/authorization-core";
import { AdminConflictError, AdminInputError, AdminNotFoundError, } from "../query";
const textField = (max) => z.string().trim().min(1).max(max);
const positive = z.number().int().min(1);
export const quizCreateSchema = z.strictObject({
    title: textField(240),
    categoryCode: textField(80),
    level: textField(60),
    objective: textField(2000),
    passMark: z.number().int().min(1).max(100),
    pointsPerQuestion: z.number().int().min(1).max(10000),
    timeLimitSeconds: z.number().int().min(30).max(86400).nullable(),
    questionCount: z.number().int().min(1).max(100),
});
export const questionCreateSchema = z
    .strictObject({
    prompt: textField(3000),
    topic: textField(120),
    sortOrder: z.number().int().min(0).max(1000),
    points: z.number().int().min(1).max(10000),
    options: z
        .array(z.strictObject({
        optionKey: textField(40),
        label: textField(500),
        sortOrder: z.number().int().min(0).max(100),
        isCorrect: z.boolean(),
    }))
        .min(2)
        .max(10),
})
    .superRefine((value, context) => {
    if (value.options.filter((option) => option.isCorrect).length !== 1)
        context.addIssue({
            code: "custom",
            message: "Exactly one option must be correct.",
        });
    if (new Set(value.options.map((option) => option.optionKey)).size !==
        value.options.length)
        context.addIssue({
            code: "custom",
            message: "Option keys must be unique.",
        });
    if (new Set(value.options.map((option) => option.sortOrder)).size !==
        value.options.length)
        context.addIssue({
            code: "custom",
            message: "Option order must be unique.",
        });
});
export const challengeCreateSchema = z.strictObject({
    title: textField(240),
    question: textField(3000),
    deadlineAt: z.iso.datetime({ offset: true }),
    active: z.boolean(),
});
export const challengeUpdateSchema = z
    .strictObject({
    title: textField(240).optional(),
    question: textField(3000).optional(),
    deadlineAt: z.iso.datetime({ offset: true }).optional(),
    active: z.boolean().optional(),
})
    .refine((value) => Object.keys(value).length > 0);
function authorized(tx, actor, now) {
    const user = tx.select().from(users).where(eq(users.id, actor.userId)).get();
    const session = tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, actor.sessionId))
        .get();
    if (!user ||
        user.role !== "back_office" ||
        !user.isActive ||
        !session ||
        session.userId !== user.id ||
        !isSessionActive(session, user, now))
        throw new AuthorizationError("Administrator session is no longer valid.");
}
function fingerprint(input) {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function requestTarget(actor, key) {
    if (key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key))
        throw new AdminInputError("A valid idempotency key is required.");
    return `${actor.userId}:${hashAuditValue(key)}`;
}
function execute(actor, action, key, input, table, change) {
    const reason = requirePrivilegedReason(actor.reason);
    const target = requestTarget(actor, key);
    const digest = fingerprint(input);
    return db.transaction((tx) => {
        const now = new Date();
        authorized(tx, actor, now);
        const replay = tx
            .select()
            .from(auditEvents)
            .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, target)))
            .get();
        if (replay) {
            let metadata = {};
            try {
                metadata = JSON.parse(replay.metadataJson ?? "{}");
            }
            catch {
                throw new AdminConflictError("Idempotency record is invalid.");
            }
            if (metadata.result !== digest ||
                !Number.isSafeInteger(metadata.resourceId))
                throw new AdminConflictError("Idempotency key was used for a different request.");
            const found = table.find(tx, metadata.resourceId);
            if (!found)
                throw new AdminConflictError("Previously created resource is unavailable.");
            return found;
        }
        const result = change(tx, now);
        tx.insert(auditEvents)
            .values(buildAuditRecord({
            actorUserId: actor.userId,
            sessionId: actor.sessionId,
            action,
            targetType: "admin_learning_request",
            targetId: target,
            reason,
            metadata: {
                result: digest,
                resourceId: result.id,
                resourceType: action.split(".").at(-1),
            },
            ipAddress: actor.ipAddress,
            userAgent: actor.userAgent,
        }, now))
            .run();
        return result;
    }, { behavior: "immediate" });
}
const quizRow = {
    find: (tx, id) => tx.select().from(quizzes).where(eq(quizzes.id, id)).get(),
};
const versionRow = {
    find: (tx, id) => tx.select().from(quizVersions).where(eq(quizVersions.id, id)).get(),
};
const questionRow = {
    find: (tx, id) => tx.select().from(quizQuestions).where(eq(quizQuestions.id, id)).get(),
};
const challengeRow = {
    find: (tx, id) => tx.select().from(quizChallenges).where(eq(quizChallenges.id, id)).get(),
};
function existingCategory(tx, code) {
    if (!tx
        .select()
        .from(quizCategories)
        .where(and(eq(quizCategories.code, code), eq(quizCategories.active, true)))
        .get())
        throw new AdminInputError("Active quiz category is required.");
}
export function createQuiz(actor, raw, key) {
    const input = quizCreateSchema.parse(raw);
    return execute(actor, "admin.learning.quiz_created", key, input, {
        find: (tx, id) => {
            const quiz = quizRow.find(tx, id);
            const version = quiz &&
                tx
                    .select()
                    .from(quizVersions)
                    .where(and(eq(quizVersions.quizId, id), eq(quizVersions.version, 1)))
                    .get();
            return quiz && version ? { ...quiz, versionId: version.id } : undefined;
        },
    }, (tx, now) => {
        existingCategory(tx, input.categoryCode);
        const quiz = tx
            .insert(quizzes)
            .values({
            title: input.title,
            category: input.categoryCode,
            difficulty: input.level,
            objective: input.objective,
            passMark: input.passMark,
            pointsPerQuestion: input.pointsPerQuestion,
            questionCount: input.questionCount,
            timeLimitSeconds: input.timeLimitSeconds,
            createdAt: now,
            updatedAt: now,
        })
            .returning()
            .get();
        const version = tx
            .insert(quizVersions)
            .values({
            quizId: quiz.id,
            version: 1,
            categoryCode: input.categoryCode,
            level: input.level,
            objective: input.objective,
            passMark: input.passMark,
            pointsPerQuestion: input.pointsPerQuestion,
            timeLimitSeconds: input.timeLimitSeconds,
            published: false,
            createdBy: actor.userId,
            createdAt: now,
            updatedAt: now,
        })
            .returning()
            .get();
        return { ...quiz, versionId: version.id };
    });
}
export function createQuizVersion(actor, quizId, key) {
    positive.parse(quizId);
    return execute(actor, "admin.learning.quiz_version_created", key, { quizId }, versionRow, (tx, now) => {
        if (!quizRow.find(tx, quizId))
            throw new AdminNotFoundError("Quiz not found.");
        const previous = tx
            .select()
            .from(quizVersions)
            .where(eq(quizVersions.quizId, quizId))
            .orderBy(desc(quizVersions.version))
            .get();
        if (!previous || !previous.published)
            throw new AdminConflictError("Publish the current version before creating another.");
        const version = tx
            .insert(quizVersions)
            .values({
            quizId,
            version: previous.version + 1,
            categoryCode: previous.categoryCode,
            level: previous.level,
            objective: previous.objective,
            passMark: previous.passMark,
            pointsPerQuestion: previous.pointsPerQuestion,
            timeLimitSeconds: previous.timeLimitSeconds,
            published: false,
            createdBy: actor.userId,
            createdAt: now,
            updatedAt: now,
        })
            .returning()
            .get();
        for (const question of tx
            .select()
            .from(quizQuestions)
            .where(eq(quizQuestions.quizVersionId, previous.id))
            .all()) {
            const copy = tx
                .insert(quizQuestions)
                .values({
                quizVersionId: version.id,
                topic: question.topic,
                prompt: question.prompt,
                sortOrder: question.sortOrder,
                points: question.points,
                createdAt: now,
                updatedAt: now,
            })
                .returning()
                .get();
            const options = tx
                .select()
                .from(quizOptions)
                .where(eq(quizOptions.questionId, question.id))
                .all();
            tx.insert(quizOptions)
                .values(options.map(({ optionKey, label, sortOrder, isCorrect }) => ({
                questionId: copy.id,
                optionKey,
                label,
                sortOrder,
                isCorrect,
            })))
                .run();
        }
        return version;
    });
}
export function addQuestion(actor, versionId, raw, key) {
    positive.parse(versionId);
    const input = questionCreateSchema.parse(raw);
    return execute(actor, "admin.learning.quiz_question_created", key, { versionId, input }, questionRow, (tx, now) => {
        const version = versionRow.find(tx, versionId);
        if (!version)
            throw new AdminNotFoundError("Quiz version not found.");
        if (version.published)
            throw new AdminConflictError("Published quiz questions are immutable.");
        if (tx
            .select()
            .from(quizQuestions)
            .where(and(eq(quizQuestions.quizVersionId, versionId), eq(quizQuestions.sortOrder, input.sortOrder)))
            .get())
            throw new AdminConflictError("Question order is already used.");
        const quiz = quizRow.find(tx, version.quizId);
        if (!quiz)
            throw new AdminNotFoundError("Quiz not found.");
        const count = tx
            .select()
            .from(quizQuestions)
            .where(eq(quizQuestions.quizVersionId, versionId))
            .all().length;
        if (count >= quiz.questionCount) {
            if (count >= 100)
                throw new AdminConflictError("A quiz cannot contain more than 100 questions.");
            // Adding a question is an explicit, audited action. If the author has
            // reached the current plan, grow it with the question so the drawer
            // never strands a draft at its initial (often one-question) default.
            tx.update(quizzes)
                .set({ questionCount: count + 1, updatedAt: now })
                .where(eq(quizzes.id, quiz.id))
                .run();
        }
        const question = tx
            .insert(quizQuestions)
            .values({
            quizVersionId: versionId,
            prompt: input.prompt,
            topic: input.topic,
            sortOrder: input.sortOrder,
            points: input.points,
            createdAt: now,
            updatedAt: now,
        })
            .returning()
            .get();
        tx.insert(quizOptions)
            .values(input.options.map((option) => ({
            ...option,
            questionId: question.id,
        })))
            .run();
        return question;
    });
}
export function publishQuizVersion(actor, versionId, key) {
    positive.parse(versionId);
    return execute(actor, "admin.learning.quiz_version_published", key, { versionId }, versionRow, (tx, now) => {
        const version = versionRow.find(tx, versionId);
        if (!version)
            throw new AdminNotFoundError("Quiz version not found.");
        if (version.published)
            throw new AdminConflictError("Quiz version is already published.");
        const latest = tx
            .select()
            .from(quizVersions)
            .where(eq(quizVersions.quizId, version.quizId))
            .orderBy(desc(quizVersions.version))
            .get();
        if (latest?.id !== versionId)
            throw new AdminConflictError("Only the latest version may be published.");
        existingCategory(tx, version.categoryCode);
        const quiz = quizRow.find(tx, version.quizId);
        const questions = tx
            .select()
            .from(quizQuestions)
            .where(eq(quizQuestions.quizVersionId, versionId))
            .all();
        if (!quiz || questions.length !== quiz.questionCount)
            throw new AdminConflictError("Quiz has an incomplete question set.");
        for (const question of questions) {
            const options = tx
                .select()
                .from(quizOptions)
                .where(eq(quizOptions.questionId, question.id))
                .all();
            if (options.length < 2 ||
                options.filter((option) => option.isCorrect).length !== 1 ||
                new Set(options.map((option) => option.optionKey)).size !==
                    options.length ||
                new Set(options.map((option) => option.sortOrder)).size !==
                    options.length)
                throw new AdminConflictError("Every question needs one correct option, unique option keys, unique option order, and at least two choices.");
        }
        return tx
            .update(quizVersions)
            .set({ published: true, publishedAt: now, updatedAt: now })
            .where(eq(quizVersions.id, versionId))
            .returning()
            .get();
    });
}
function challengeRule(tx) {
    const rule = tx
        .select()
        .from(pointRules)
        .where(and(eq(pointRules.code, "challenge_join"), eq(pointRules.active, true)))
        .get();
    if (!rule || rule.points <= 0)
        throw new AdminConflictError("An active challenge points rule is required.");
    return rule;
}
function futureDeadline(value, now) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()) || date <= now)
        throw new AdminInputError("Challenge deadline must be in the future.");
    return date;
}
export function listAdminChallenges() {
    return db
        .select()
        .from(quizChallenges)
        .orderBy(desc(quizChallenges.id))
        .limit(100)
        .all();
}
export function createChallenge(actor, raw, key) {
    const input = challengeCreateSchema.parse(raw);
    return execute(actor, "admin.learning.challenge_created", key, input, challengeRow, (tx, now) => {
        const rule = challengeRule(tx);
        return tx
            .insert(quizChallenges)
            .values({
            title: input.title,
            question: input.question,
            deadlineAt: futureDeadline(input.deadlineAt, now),
            points: rule.points,
            active: input.active,
            createdAt: now,
            updatedAt: now,
        })
            .returning()
            .get();
    });
}
export function updateChallenge(actor, challengeId, raw, key) {
    positive.parse(challengeId);
    const input = challengeUpdateSchema.parse(raw);
    return execute(actor, "admin.learning.challenge_updated", key, { challengeId, input }, challengeRow, (tx, now) => {
        const challenge = challengeRow.find(tx, challengeId);
        if (!challenge)
            throw new AdminNotFoundError("Challenge not found.");
        if (!challenge.active && input.active === true)
            throw new AdminConflictError("Closed challenges cannot be reopened.");
        if (challenge.active &&
            challenge.deadlineAt <= now &&
            input.active !== false)
            throw new AdminConflictError("Expired challenges can only be closed.");
        if (input.title !== undefined ||
            input.question !== undefined ||
            input.deadlineAt !== undefined) {
            if (!challenge.active)
                throw new AdminConflictError("Closed challenge content is immutable.");
            if (tx
                .select()
                .from(quizChallengeParticipants)
                .where(eq(quizChallengeParticipants.challengeId, challengeId))
                .get())
                throw new AdminConflictError("Challenge content is immutable after participation begins.");
        }
        const deadlineAt = input.deadlineAt === undefined
            ? challenge.deadlineAt
            : futureDeadline(input.deadlineAt, now);
        if (input.active === true && deadlineAt <= now)
            throw new AdminInputError("Cannot open an expired challenge.");
        return tx
            .update(quizChallenges)
            .set({
            title: input.title ?? challenge.title,
            question: input.question ?? challenge.question,
            deadlineAt,
            active: input.active ?? challenge.active,
            updatedAt: now,
        })
            .where(eq(quizChallenges.id, challengeId))
            .returning()
            .get();
    });
}
