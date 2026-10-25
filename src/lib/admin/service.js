import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../../db/connection";
import { announcements, articles, articleCompletions, auditEvents, feedbackCampaigns, feedbackResponses, ideaSettings, ideas, pointsLedger, quizAttempts, quizChallenges, quizQuestions, quizVersions, quizzes, refreshTokens, rewards, users } from "../../db/schema";
import { hashPassword } from "../../auth/password-core";
import { randomBytes } from "node:crypto";
import { isSessionActive } from "../../auth/security-core";
import { buildAuditRecord } from "../audit/service";
import { requirePrivilegedReason, AuthorizationError } from "../auth/authorization-core";
import { AdminConflictError, AdminInputError, AdminNotFoundError, positiveId, safeAuditMetadata } from "./query";
const userFields = {
    id: users.id, name: users.name, email: users.email, role: users.role,
    department: users.department, jobTitle: users.jobTitle, isActive: users.isActive,
    mustChangePassword: users.mustChangePassword,
    failedLoginAttempts: users.failedLoginAttempts, lockedUntil: users.lockedUntil,
    lastLoginAt: users.lastLoginAt, lastSeenAt: users.lastSeenAt,
    deactivatedAt: users.deactivatedAt, createdAt: users.createdAt, updatedAt: users.updatedAt,
};
function pageResult(rows, limit) {
    const items = rows.slice(0, limit);
    return { items, nextAfter: rows.length > limit ? items.at(-1)?.id ?? null : null };
}
export function parseAdminOffsetPage(url) {
    const page = url.searchParams.has("page") ? positiveId(url.searchParams.get("page")) : 1;
    const pageSize = url.searchParams.has("pageSize") ? positiveId(url.searchParams.get("pageSize")) : 10;
    if (pageSize > 10 || !Number.isSafeInteger((page - 1) * pageSize))
        throw new AdminInputError("Page size must be at most 10.");
    return { page, pageSize, offset: (page - 1) * pageSize };
}
function offsetResult(items, page, pageSize, total) {
    return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
export function listAdminAnnouncementPage(page) {
    const total = db.select({ count: sql `count(*)` }).from(announcements).get().count;
    const items = db.select().from(announcements).orderBy(desc(announcements.pinned), desc(announcements.updatedAt), desc(announcements.id)).limit(page.pageSize).offset(page.offset).all();
    return offsetResult(items, page.page, page.pageSize, total);
}
export function listAdminCampaignPage(page) {
    const total = db.select({ count: sql `count(*)` }).from(feedbackCampaigns).get().count;
    const items = db.select().from(feedbackCampaigns).orderBy(desc(feedbackCampaigns.updatedAt), desc(feedbackCampaigns.id)).limit(page.pageSize).offset(page.offset).all();
    return offsetResult(items, page.page, page.pageSize, total);
}
export function listAdminRewardPage(page) {
    const total = db.select({ count: sql `count(*)` }).from(rewards).get().count;
    const items = db.select().from(rewards).orderBy(asc(rewards.kind), asc(rewards.cost), asc(rewards.id)).limit(page.pageSize).offset(page.offset).all();
    return offsetResult(items, page.page, page.pageSize, total);
}
export function listAdminChallengePage(page) {
    const total = db.select({ count: sql `count(*)` }).from(quizChallenges).get().count;
    const rows = db.select().from(quizChallenges).where(page.after ? lt(quizChallenges.id, page.after) : undefined).orderBy(desc(quizChallenges.id)).limit(page.limit + 1).all();
    return { ...pageResult(rows, page.limit), total };
}
export function listAdminQuizPage(page) {
    const total = db.select({ count: sql `count(*)` }).from(quizzes).get().count;
    const rows = db.select().from(quizzes).where(page.after ? lt(quizzes.id, page.after) : undefined).orderBy(desc(quizzes.id)).limit(page.limit + 1).all();
    const items = rows.slice(0, page.limit).map((quiz) => {
        const version = db.select().from(quizVersions).where(eq(quizVersions.quizId, quiz.id)).orderBy(desc(quizVersions.version)).limit(1).get();
        const questionCount = version ? db.select({ count: sql `count(*)` }).from(quizQuestions).where(eq(quizQuestions.quizVersionId, version.id)).get().count : 0;
        return { id: quiz.id, title: quiz.title, category: quiz.category, difficulty: quiz.difficulty, objective: quiz.objective, versionId: version?.id ?? null, version: version?.version ?? null, categoryCode: version?.categoryCode ?? null, level: version?.level ?? null, passMark: version?.passMark ?? null, published: version?.published ?? null, questionCount, plannedQuestionCount: quiz.questionCount };
    });
    return { items, nextAfter: rows.length > page.limit ? items.at(-1)?.id ?? null : null, total };
}
export function listAdminFeedbackPage(page) {
    const total = db.select({ count: sql `count(*)` }).from(feedbackResponses).get().count;
    const rows = db.select({ id: feedbackResponses.id, campaignId: feedbackResponses.campaignId, userId: feedbackResponses.userId, userName: users.name, category: feedbackResponses.category, message: feedbackResponses.message, response: feedbackResponses.response, createdAt: feedbackResponses.createdAt, respondedAt: feedbackResponses.respondedAt }).from(feedbackResponses).innerJoin(users, eq(users.id, feedbackResponses.userId)).where(page.after ? lt(feedbackResponses.id, page.after) : undefined).orderBy(desc(feedbackResponses.id)).limit(page.limit + 1).all();
    return { ...pageResult(rows, page.limit), total };
}
export function adminContentTotals() {
    return {
        quizzes: db.select({ count: sql `count(*)` }).from(quizzes).get().count,
        articles: db.select({ count: sql `count(*)` }).from(articles).get().count,
    };
}
export async function listUsers(page) {
    const search = page.q ? sql `(instr(lower(${users.name}), lower(${page.q})) > 0 OR instr(lower(${users.email}), lower(${page.q})) > 0 OR instr(lower(${users.department}), lower(${page.q})) > 0 OR instr(lower(coalesce(${users.jobTitle}, '')), lower(${page.q})) > 0)` : undefined;
    const rows = db.select(userFields).from(users)
        .where(and(page.after ? lt(users.id, page.after) : undefined, search))
        .orderBy(desc(users.id)).limit(page.limit + 1).all();
    return pageResult(rows, page.limit);
}
export async function getUserDetail(userId) {
    const row = db.select(userFields).from(users).where(eq(users.id, userId)).limit(1).get();
    if (!row)
        throw new AdminNotFoundError("User not found.");
    return row;
}
export async function listUserSessions(userId, page) {
    const user = db.select({ isActive: users.isActive, sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, userId)).limit(1).get();
    if (!user)
        throw new AdminNotFoundError("User not found.");
    const rows = db.select({
        id: refreshTokens.id, createdAt: refreshTokens.createdAt, lastSeenAt: refreshTokens.lastSeenAt,
        expiresAt: refreshTokens.expiresAt, idleExpiresAt: refreshTokens.idleExpiresAt,
        absoluteExpiresAt: refreshTokens.absoluteExpiresAt, revokedAt: refreshTokens.revokedAt,
        revocationReason: refreshTokens.revocationReason, sessionVersion: refreshTokens.sessionVersion,
    }).from(refreshTokens).where(and(eq(refreshTokens.userId, userId), page.after ? lt(refreshTokens.id, page.after) : undefined))
        .orderBy(desc(refreshTokens.id)).limit(page.limit + 1).all();
    return pageResult(rows.map((row) => ({ ...row, isActive: row.expiresAt > new Date() && isSessionActive(row, user) })), page.limit);
}
function assertActor(tx, actor, now) {
    const current = tx.select({ id: users.id, role: users.role, isActive: users.isActive, sessionVersion: users.sessionVersion })
        .from(users).where(eq(users.id, actor.userId)).limit(1).get();
    const session = tx.select({ userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt,
        revokedAt: refreshTokens.revokedAt, idleExpiresAt: refreshTokens.idleExpiresAt,
        absoluteExpiresAt: refreshTokens.absoluteExpiresAt, sessionVersion: refreshTokens.sessionVersion })
        .from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).limit(1).get();
    if (!current || current.role !== "back_office" || !current.isActive || !session || session.userId !== current.id || session.expiresAt <= now || !isSessionActive(session, current, now)) {
        throw new AuthorizationError("Administrator session is no longer valid.");
    }
}
function requireAllowedUserPolicy(tx, key, value) {
    const row = tx.select({ value: ideaSettings.value }).from(ideaSettings).where(eq(ideaSettings.key, key)).get();
    if (!row)
        return;
    let allowed;
    try {
        allowed = JSON.parse(row.value);
    }
    catch {
        throw new AdminConflictError(`${key} policy is invalid.`);
    }
    if (!Array.isArray(allowed) || allowed.some(item => typeof item !== "string"))
        throw new AdminConflictError(`${key} policy is invalid.`);
    if (allowed.length && !allowed.includes(value))
        throw new AdminConflictError(`${value} is not an allowed ${key === "roles" ? "role" : "department"}.`);
}
function mutateUser(actor, userId, reasonInput, action, value, metadata) {
    const reason = requirePrivilegedReason(reasonInput);
    const now = new Date();
    return db.transaction((tx) => {
        assertActor(tx, actor, now);
        const target = tx.select().from(users).where(eq(users.id, userId)).limit(1).get();
        if (!target)
            throw new AdminNotFoundError("User not found.");
        if (action === "role" && !["employee", "back_office", "business_owner"].includes(value))
            throw new AdminConflictError("Invalid role.");
        if (action === "role")
            requireAllowedUserPolicy(tx, "roles", value);
        if (action === "active" && typeof value !== "boolean")
            throw new AdminConflictError("Invalid active state.");
        if (userId === actor.userId && action !== "reset")
            throw new AdminConflictError("Back-office users cannot change their own role or active state.");
        if (action === "role" && target.role === value)
            throw new AdminConflictError("Role is already set.");
        if (action === "active" && target.isActive === value)
            throw new AdminConflictError("Active state is already set.");
        if (action === "role")
            tx.update(users).set({ role: value, sessionVersion: sql `${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, userId)).run();
        if (action === "active")
            tx.update(users).set({ isActive: value, deactivatedAt: value ? null : now, sessionVersion: sql `${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, userId)).run();
        if (action === "reset")
            tx.update(users).set({ failedLoginAttempts: 0, lockedUntil: null, lastFailedLoginAt: null, sessionVersion: sql `${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, userId)).run();
        const auditAction = action === "role" ? "admin.user.role_changed" : action === "reset" ? "admin.user.security_reset" : value ? "admin.user.reactivated" : "admin.user.deactivated";
        tx.update(refreshTokens).set({ revokedAt: now, revocationReason: auditAction, updatedAt: now })
            .where(and(eq(refreshTokens.userId, userId), sql `${refreshTokens.revokedAt} IS NULL`)).run();
        tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId,
            action: auditAction, targetType: "user", targetId: userId, reason, requiresReason: true,
            metadata: action === "role" ? { fromStatus: target.role, toStatus: value } : { status: action === "reset" ? "reset" : value ? "active" : "inactive" },
            ...metadata,
        }, now)).run();
        return tx.select(userFields).from(users).where(eq(users.id, userId)).limit(1).get();
    });
}
export function changeUserRole(actor, userId, role, reason, metadata) {
    return mutateUser(actor, userId, reason, "role", role, metadata);
}
export function setUserActive(actor, userId, active, reason, metadata) {
    return mutateUser(actor, userId, reason, "active", active, metadata);
}
export function resetUserSecurity(actor, userId, reason, metadata) {
    return mutateUser(actor, userId, reason, "reset", undefined, metadata);
}
export async function createUser(actor, input, reasonInput, metadata) {
    const reason = requirePrivilegedReason(reasonInput);
    const now = new Date();
    // Administrators deliver this one-time credential through an approved bank channel.
    const temporaryPassword = randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(temporaryPassword);
    try {
        const user = db.transaction((tx) => {
            assertActor(tx, actor, now);
            requireAllowedUserPolicy(tx, "roles", input.role);
            requireAllowedUserPolicy(tx, "departments", input.department.trim());
            const created = tx.insert(users).values({ name: input.name.trim(), email: input.email.trim().toLowerCase(), department: input.department.trim(), jobTitle: input.jobTitle?.trim() || null, role: input.role, passwordHash, mustChangePassword: true, createdAt: now, updatedAt: now }).returning(userFields).get();
            tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: "admin.user.created", targetType: "user", targetId: created.id, reason, requiresReason: true, metadata: { role: created.role }, ...metadata }, now)).run();
            return created;
        });
        return { user, temporaryPassword };
    }
    catch (error) {
        if (String(error).includes("users_email_unique"))
            throw new AdminConflictError("Email is already registered.");
        throw error;
    }
}
export async function resetUserPassword(actor, userId, reasonInput, metadata) {
    const reason = requirePrivilegedReason(reasonInput);
    const now = new Date();
    const temporaryPassword = randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(temporaryPassword);
    db.transaction((tx) => {
        assertActor(tx, actor, now);
        if (userId === actor.userId)
            throw new AdminConflictError("Administrators cannot reset their own password through this endpoint.");
        const target = tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
        if (!target)
            throw new AdminNotFoundError("User not found.");
        tx.update(users).set({ passwordHash, mustChangePassword: true, failedLoginAttempts: 0, lockedUntil: null, lastFailedLoginAt: null, sessionVersion: sql `${users.sessionVersion} + 1`, updatedAt: now }).where(eq(users.id, userId)).run();
        tx.update(refreshTokens).set({ revokedAt: now, revocationReason: "admin.user.password_reset", updatedAt: now }).where(and(eq(refreshTokens.userId, userId), sql `${refreshTokens.revokedAt} IS NULL`)).run();
        tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: "admin.user.password_reset", targetType: "user", targetId: userId, reason, requiresReason: true, ...metadata }, now)).run();
    });
    return { temporaryPassword };
}
export function revokeUserSession(actor, userId, targetSessionId, reasonInput, metadata) {
    const reason = requirePrivilegedReason(reasonInput);
    const now = new Date();
    return db.transaction((tx) => {
        assertActor(tx, actor, now);
        if (targetSessionId === actor.sessionId)
            throw new AdminConflictError("Administrators cannot revoke their current session here.");
        const target = tx.select({ id: refreshTokens.id, revokedAt: refreshTokens.revokedAt }).from(refreshTokens).where(and(eq(refreshTokens.id, targetSessionId), eq(refreshTokens.userId, userId))).get();
        if (!target)
            throw new AdminNotFoundError("Session not found.");
        if (target.revokedAt)
            throw new AdminConflictError("Session is already revoked.");
        tx.update(refreshTokens).set({ revokedAt: now, revocationReason: "admin.session.revoked", updatedAt: now }).where(eq(refreshTokens.id, targetSessionId)).run();
        tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: "admin.session.revoked", targetType: "session", targetId: targetSessionId, reason, requiresReason: true, metadata: { userId }, ...metadata }, now)).run();
        return { id: targetSessionId, revokedAt: now };
    });
}
export async function listAuditEvents(filters) {
    const conditions = [];
    if (filters.actorUserId)
        conditions.push(eq(auditEvents.actorUserId, filters.actorUserId));
    if (filters.action)
        conditions.push(eq(auditEvents.action, filters.action));
    if (filters.targetType)
        conditions.push(eq(auditEvents.targetType, filters.targetType));
    if (filters.targetId)
        conditions.push(eq(auditEvents.targetId, filters.targetId));
    if (filters.from)
        conditions.push(sql `${auditEvents.createdAt} >= ${filters.from}`);
    if (filters.to)
        conditions.push(sql `${auditEvents.createdAt} < ${filters.to}`);
    if (filters.ipHash)
        conditions.push(eq(auditEvents.ipHash, filters.ipHash));
    const total = db.select({ count: sql `count(*)` }).from(auditEvents).where(conditions.length ? and(...conditions) : undefined).get().count;
    const rows = db.select({ id: auditEvents.id, createdAt: auditEvents.createdAt,
        actorUserId: auditEvents.actorUserId, sessionId: auditEvents.sessionId, action: auditEvents.action,
        targetType: auditEvents.targetType, targetId: auditEvents.targetId, reason: auditEvents.reason, ipHash: auditEvents.ipHash,
        metadataJson: auditEvents.metadataJson,
    }).from(auditEvents).where(and(...conditions, filters.after ? lt(auditEvents.id, filters.after) : undefined))
        .orderBy(desc(auditEvents.id)).limit(filters.limit + 1).all();
    return { ...pageResult(rows.map(({ metadataJson, ...row }) => ({ ...row, metadata: safeAuditMetadata(metadataJson) })), filters.limit), total };
}
export async function getAdminAnalytics() {
    const usersByState = db.select({ state: sql `CASE WHEN ${users.isActive} = 1 THEN 'active' ELSE 'inactive' END`, count: sql `count(*)` }).from(users).groupBy(users.isActive).all();
    const ideasByStatus = db.select({ status: ideas.status, count: sql `count(*)` }).from(ideas).groupBy(ideas.status).orderBy(desc(sql `count(*)`)).limit(30).all();
    const ideasByPriority = db.select({ band: ideas.priorityBand, count: sql `count(*)` }).from(ideas).groupBy(ideas.priorityBand).limit(5).all();
    const ideasByDepartment = db.select({ department: users.department, count: sql `count(*)` }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).groupBy(users.department).orderBy(desc(sql `count(*)`)).limit(100).all();
    const usersByDepartment = db.select({ department: users.department, count: sql `count(*)` }).from(users).groupBy(users.department).orderBy(desc(sql `count(*)`)).limit(100).all();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).getTime();
    const auditByAction = db.select({ action: auditEvents.action, count: sql `count(*)` }).from(auditEvents).where(sql `${auditEvents.createdAt} >= ${thirtyDaysAgo}`).groupBy(auditEvents.action).orderBy(desc(sql `count(*)`)).limit(20).all();
    const points = db.select({ total: sql `coalesce(sum(${pointsLedger.amount}), 0)`, events: sql `count(*)` }).from(pointsLedger).get();
    const learning = {
        quizAttempts: db.select({ count: sql `count(*)` }).from(quizAttempts).get().count,
        publishedArticles: db.select({ count: sql `count(*)` }).from(articles).where(eq(articles.published, true)).get().count,
        articleCompletions: db.select({ count: sql `count(*)` }).from(articleCompletions).get().count,
    };
    return { periodDays: 30, generatedAt: new Date().toISOString(), usersByState, ideasByStatus, ideasByPriority, ideasByDepartment, usersByDepartment, points, learning, auditByAction };
}
export function listIdeaExportRows(page) {
    const rows = db.select({ id: ideas.id, reference: ideas.reference, status: ideas.status, priorityBand: ideas.priorityBand, priorityScore: ideas.priorityScore, authorId: ideas.authorId, authorName: users.name, department: users.department, title: ideas.title, summary: ideas.summary, benefits: ideas.benefits, createdAt: ideas.createdAt, updatedAt: ideas.updatedAt }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).where(page.after ? lt(ideas.id, page.after) : undefined).orderBy(desc(ideas.id)).limit(page.limit + 1).all();
    return pageResult(rows, page.limit);
}
export function listFeedbackExportRows(page) {
    const rows = db.select({ id: feedbackResponses.id, campaignId: feedbackResponses.campaignId, userId: feedbackResponses.userId, userName: users.name, department: users.department, category: feedbackResponses.category, message: feedbackResponses.message, response: feedbackResponses.response, createdAt: feedbackResponses.createdAt, respondedAt: feedbackResponses.respondedAt }).from(feedbackResponses).innerJoin(users, eq(users.id, feedbackResponses.userId)).where(page.after ? lt(feedbackResponses.id, page.after) : undefined).orderBy(desc(feedbackResponses.id)).limit(page.limit + 1).all();
    return pageResult(rows, page.limit);
}
