import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../../../db/connection";
import { articles, auditEvents, quizOptions, quizQuestions, quizVersions, quizzes, refreshTokens, users, } from "../../../db/schema";
import { isSessionActive } from "../../../auth/security-core";
import { buildAuditRecord } from "../../audit/service";
import { hashAuditValue } from "../../audit/redaction-core";
import { requirePrivilegedReason, AuthorizationError, } from "../../auth/authorization-core";
import { AdminConflictError, AdminInputError, AdminNotFoundError, } from "../query";
import { questionCreateSchema } from "./authoring";
import { validateArticleLink, ArticleUrlError } from "./url-validation";
function page(rows, limit) {
    const items = rows.slice(0, limit);
    return {
        items,
        nextAfter: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
}
function assertActor(tx, actor, now) {
    const user = tx
        .select()
        .from(users)
        .where(eq(users.id, actor.userId))
        .limit(1)
        .get();
    const session = tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, actor.sessionId))
        .limit(1)
        .get();
    if (!user ||
        user.role !== "back_office" ||
        !user.isActive ||
        !session ||
        session.userId !== user.id ||
        !isSessionActive(session, user, now))
        throw new AuthorizationError("Administrator session is no longer valid.");
}
function writeAudit(tx, actor, reason, action, type, id, now, metadata = {
    status: "updated",
}) {
    tx.insert(auditEvents)
        .values(buildAuditRecord({
        actorUserId: actor.userId,
        sessionId: actor.sessionId,
        action,
        targetType: type,
        targetId: id,
        reason,
        metadata,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
    }, now))
        .run();
}
function requestTarget(actor, key) {
    const trimmed = key.trim();
    if (trimmed.length < 8 ||
        trimmed.length > 200 ||
        !/^[\x21-\x7e]+$/.test(trimmed))
        throw new AdminInputError("A valid idempotency key is required.");
    const hash = hashAuditValue(trimmed);
    if (!hash)
        throw new AdminInputError("A valid idempotency key is required.");
    return `${actor.userId}:${hash}`;
}
function fingerprint(input) {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function replay(tx, _actor, action, target, digest, find) {
    const prior = tx
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, action), eq(auditEvents.targetId, target)))
        .get();
    if (!prior)
        return undefined;
    let metadata;
    try {
        metadata = JSON.parse(prior.metadataJson ?? "{}");
    }
    catch {
        throw new AdminConflictError("Idempotency record is invalid.");
    }
    if (metadata.result !== digest ||
        typeof metadata.resourceId !== "number" ||
        !Number.isSafeInteger(metadata.resourceId))
        throw new AdminConflictError("Idempotency key was used for a different request.");
    const resource = find(metadata.resourceId);
    if (!resource)
        throw new AdminConflictError("Previously updated resource is unavailable.");
    return resource;
}
export async function listAdminQuizzes(pageInfo) {
    const rows = db
        .select({
        id: quizzes.id,
        title: quizzes.title,
        category: quizzes.category,
        difficulty: quizzes.difficulty,
        objective: quizzes.objective,
        versionId: quizVersions.id,
        version: quizVersions.version,
        categoryCode: quizVersions.categoryCode,
        level: quizVersions.level,
        passMark: quizVersions.passMark,
        published: quizVersions.published,
    })
        .from(quizzes)
        .leftJoin(quizVersions, eq(quizVersions.quizId, quizzes.id))
        .orderBy(desc(quizzes.id), desc(quizVersions.version))
        .all();
    const latest = new Map();
    for (const row of rows)
        if (!latest.has(row.id))
            latest.set(row.id, row);
    const selected = Array.from(latest.values())
        .filter((row) => pageInfo.after === null || row.id < pageInfo.after)
        .slice(0, pageInfo.limit + 1)
        .map((row) => ({
        ...row,
        questionCount: row.versionId
            ? Number(db
                .select({ count: sql `count(*)` })
                .from(quizQuestions)
                .where(eq(quizQuestions.quizVersionId, row.versionId))
                .get()?.count ?? 0)
            : 0,
    }));
    return page(selected, pageInfo.limit);
}
export async function getAdminQuizQuestions(versionId) {
    if (!Number.isSafeInteger(versionId) || versionId < 1)
        throw new AdminInputError("Invalid quiz version ID.");
    if (!db
        .select({ id: quizVersions.id })
        .from(quizVersions)
        .where(eq(quizVersions.id, versionId))
        .get())
        throw new AdminNotFoundError("Quiz version not found.");
    return db
        .select()
        .from(quizQuestions)
        .where(eq(quizQuestions.quizVersionId, versionId))
        .orderBy(asc(quizQuestions.sortOrder), asc(quizQuestions.id))
        .all()
        .map((question) => ({
        ...question,
        options: db
            .select({
            id: quizOptions.id,
            optionKey: quizOptions.optionKey,
            label: quizOptions.label,
            sortOrder: quizOptions.sortOrder,
            isCorrect: quizOptions.isCorrect,
        })
            .from(quizOptions)
            .where(eq(quizOptions.questionId, question.id))
            .orderBy(asc(quizOptions.sortOrder))
            .all(),
    }));
}
export async function updateAdminQuestion(actor, questionId, input, key) {
    const reason = requirePrivilegedReason(actor.reason);
    const validated = questionCreateSchema.parse(input);
    const target = requestTarget(actor, key);
    const digest = fingerprint({ questionId, input: validated });
    return db.transaction((tx) => {
        const now = new Date();
        assertActor(tx, actor, now);
        const prior = replay(tx, actor, "admin.learning.question_updated", target, digest, (id) => tx.select().from(quizQuestions).where(eq(quizQuestions.id, id)).get());
        if (prior)
            return { id: prior.id, updated: true };
        const question = tx
            .select()
            .from(quizQuestions)
            .where(eq(quizQuestions.id, questionId))
            .get();
        if (!question)
            throw new AdminNotFoundError("Question not found.");
        const version = tx
            .select()
            .from(quizVersions)
            .where(eq(quizVersions.id, question.quizVersionId))
            .get();
        if (!version || version.published)
            throw new AdminInputError("Published quiz questions are immutable; create a new version first.");
        if (tx
            .select()
            .from(quizQuestions)
            .where(and(eq(quizQuestions.quizVersionId, question.quizVersionId), eq(quizQuestions.sortOrder, validated.sortOrder)))
            .all()
            .some((row) => row.id !== questionId))
            throw new AdminConflictError("Question order is already used.");
        tx.update(quizQuestions)
            .set({
            prompt: validated.prompt,
            topic: validated.topic,
            sortOrder: validated.sortOrder,
            points: validated.points,
            updatedAt: now,
        })
            .where(eq(quizQuestions.id, questionId))
            .run();
        tx.delete(quizOptions).where(eq(quizOptions.questionId, questionId)).run();
        tx.insert(quizOptions)
            .values(validated.options.map((option) => ({ ...option, questionId })))
            .run();
        writeAudit(tx, actor, reason, "admin.learning.question_updated", "admin_learning_request", target, now, {
            result: digest,
            resourceId: questionId,
            resourceType: "question_updated",
        });
        return { id: questionId, updated: true };
    });
}
export async function listAdminArticles(pageInfo) {
    const rows = db
        .select()
        .from(articles)
        .where(pageInfo.after ? lt(articles.id, pageInfo.after) : undefined)
        .orderBy(desc(articles.id))
        .limit(pageInfo.limit + 1)
        .all();
    return page(rows, pageInfo.limit);
}
function validateArticle(input) {
    try {
        validateArticleLink(input.contentType, input.url ?? null);
    }
    catch (error) {
        if (error instanceof ArticleUrlError)
            throw new AdminInputError(error.message);
        throw error;
    }
}
export async function createAdminArticle(actor, input, key) {
    const reason = requirePrivilegedReason(actor.reason);
    validateArticle(input);
    const target = requestTarget(actor, key);
    const digest = fingerprint(input);
    return db.transaction((tx) => {
        const now = new Date();
        assertActor(tx, actor, now);
        const prior = replay(tx, actor, "admin.learning.article_created", target, digest, (id) => tx.select().from(articles).where(eq(articles.id, id)).get());
        if (prior)
            return prior;
        const row = tx
            .insert(articles)
            .values({
            ...input,
            topic: input.topic ?? null,
            publishedLabel: input.publishedLabel ?? null,
            url: input.url ?? null,
            createdAt: now,
            updatedAt: now,
        })
            .returning()
            .get();
        writeAudit(tx, actor, reason, "admin.learning.article_created", "admin_learning_request", target, now, { result: digest, resourceId: row.id, resourceType: "article_created" });
        return row;
    });
}
export async function updateAdminArticle(actor, articleId, input, key) {
    const reason = requirePrivilegedReason(actor.reason);
    validateArticle(input);
    const target = requestTarget(actor, key);
    const digest = fingerprint({ articleId, input });
    return db.transaction((tx) => {
        const now = new Date();
        assertActor(tx, actor, now);
        const prior = replay(tx, actor, "admin.learning.article_updated", target, digest, (id) => tx.select().from(articles).where(eq(articles.id, id)).get());
        if (prior)
            return prior;
        if (!tx
            .select({ id: articles.id })
            .from(articles)
            .where(eq(articles.id, articleId))
            .get())
            throw new AdminNotFoundError("Article not found.");
        const row = tx
            .update(articles)
            .set({
            ...input,
            topic: input.topic ?? null,
            publishedLabel: input.publishedLabel ?? null,
            url: input.url ?? null,
            updatedAt: now,
        })
            .where(eq(articles.id, articleId))
            .returning()
            .get();
        writeAudit(tx, actor, reason, "admin.learning.article_updated", "admin_learning_request", target, now, {
            result: digest,
            resourceId: articleId,
            resourceType: "article_updated",
        });
        return row;
    });
}
