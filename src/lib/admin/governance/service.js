import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/connection";
import { aiRuns, auditEvents, ideaEvents, ideaReviews, ideaSettings, ideaSubmissions, ideas, notifications, refreshTokens, users } from "../../../db/schema";
import { isSessionActive } from "../../../auth/security-core";
import { AuthorizationError } from "../../auth/authorization-core";
import { buildAuditRecord } from "../../audit/service";
import { AdminConflictError, AdminNotFoundError } from "../query";
import { resolveRequiredControlsPolicy } from "../settings/validation";
function governanceEventActor(role) {
    return role === "maintainer" || role === "business_owner" ? role : "admin";
}
const safeIdea = { id: ideas.id, reference: ideas.reference, title: ideas.title, summary: ideas.summary, problem: ideas.problem, solution: ideas.solution, benefits: ideas.benefits, risks: ideas.risks, kind: ideas.kind, category: ideas.category, status: ideas.status, assignedUserId: ideas.assignedUserId, dueAt: ideas.dueAt, priorityBand: ideas.priorityBand, priorityScore: ideas.priorityScore, authorId: ideas.authorId, authorName: users.name, department: users.department, createdAt: ideas.createdAt, updatedAt: ideas.updatedAt };
function assertActor(tx, actor, now) {
    const user = tx.select({ id: users.id, role: users.role, isActive: users.isActive, sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, actor.userId)).limit(1).get();
    const session = tx.select({ userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt, revokedAt: refreshTokens.revokedAt, idleExpiresAt: refreshTokens.idleExpiresAt, absoluteExpiresAt: refreshTokens.absoluteExpiresAt, sessionVersion: refreshTokens.sessionVersion }).from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).limit(1).get();
    if (!user || !user.isActive || !session || session.userId !== user.id || session.expiresAt <= now || !isSessionActive(session, user, now))
        throw new AuthorizationError("Session is no longer valid.");
    return user.role;
}
export async function requireGovernanceRole(actor, allowed) {
    const role = db.transaction((tx) => assertActor(tx, actor, new Date()));
    if (!allowed.includes(role))
        throw new AuthorizationError("This role cannot access this queue.");
    return role;
}
function assignedOwner(tx, ideaId) {
    return tx.select({ assignedUserId: ideas.assignedUserId }).from(ideas).where(eq(ideas.id, ideaId)).get()?.assignedUserId ?? null;
}
function stageDays(stage, tx = db) {
    const setting = tx.select({ value: ideaSettings.value }).from(ideaSettings).where(eq(ideaSettings.key, "sla_days")).get();
    const days = parsed(setting?.value ?? null)?.[stage];
    return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 365 ? days : 4;
}
function controlSnapshot(tx, ideaId) {
    const ownerApproval = tx.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents)
        .where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "business_owner_approved"))).orderBy(desc(ideaEvents.id)).limit(1).get();
    return parsed(ownerApproval?.metadataJson ?? null);
}
function approvedControls(tx, ideaId) {
    const events = tx.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents)
        .where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "control_approved"))).all();
    const names = new Set();
    let legacyApproval = false;
    for (const event of events) {
        const name = parsed(event.metadataJson)?.controlName;
        if (typeof name === "string") {
            names.add(name.toLowerCase());
        }
        else
            legacyApproval = true;
    }
    return { names, legacyApproval };
}
function queueDueAt(item, days, startAt = item.createdAt) {
    return { ...item, dueAt: item.dueAt ?? new Date(startAt.getTime() + days * 86_400_000) };
}
function governanceAuditMessage(action, role, reference, from) {
    const actionMessages = {
        route: "routed to business-owner review",
        return: "returned for revision",
        reject: "rejected",
        defer: "deferred",
        accept: from === "screening" ? "accepted for business owner matching" : "accepted",
        approve: from === "control_review" ? "approved at control review" : "approved by the business owner",
        not_recommended: from === "control_review" ? "not recommended at control review" : "not recommended by the business owner",
        confirm: "confirmed for proof of concept",
        start_implementation: "moved into implementation",
        mark_implemented: "marked as implemented",
    };
    const actor = role === "business_owner" ? "Business owner" : role === "maintainer" ? "Maintainer" : "Admin";
    const stage = from.replaceAll("_", " ");
    return `${actor} ${actionMessages[action] ?? "updated"} ${reference} from ${stage}.`;
}
export async function listBusinessOwners(actor, limit = 100, after = null) {
    const role = await requireGovernanceRole(actor, ["admin", "maintainer", "business_owner"]);
    const rows = db.select({ id: users.id, name: users.name, department: users.department, businessProfile: users.businessProfile }).from(users)
        .where(and(eq(users.role, "business_owner"), eq(users.isActive, true), role === "business_owner" ? eq(users.id, actor.userId) : undefined, after ? sql `${users.id} < ${after}` : undefined))
        .orderBy(desc(users.id)).limit(limit + 1).all();
    return { items: rows.slice(0, limit), nextAfter: rows.length > limit ? rows[limit - 1]?.id ?? null : null };
}
function parsed(json) {
    if (!json)
        return null;
    try {
        return JSON.parse(json);
    }
    catch {
        return null;
    }
}
export async function listScreeningQueue(actor, limit = 50, after = null) {
    await requireGovernanceRole(actor, ["admin", "maintainer"]);
    const [count] = await db.select({ value: sql `count(*)` }).from(ideas).where(eq(ideas.status, "screening")).all();
    const rows = await db.select({ ...safeIdea, submittedAt: ideaSubmissions.submittedAt, aiValidationScore: ideaSubmissions.aiValidationScore, aiValidationAttempts: ideaSubmissions.aiValidationAttempts, submittedWithLowAiScore: ideaSubmissions.submittedWithLowAiScore }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).leftJoin(ideaSubmissions, eq(ideaSubmissions.ideaId, ideas.id)).where(and(eq(ideas.status, "screening"), after ? sql `${ideas.id} < ${after}` : undefined)).orderBy(desc(ideas.id)).limit(limit + 1).all();
    return { items: rows.slice(0, limit).map(({ submittedAt, ...row }) => queueDueAt(row, stageDays("screening"), submittedAt ?? row.createdAt)), nextAfter: rows.length > limit ? rows[limit - 1]?.id ?? null : null, total: Number(count?.value ?? 0) };
}
export async function listTransformationQueue(actor, limit = 50, after = null) {
    await requireGovernanceRole(actor, ["admin", "maintainer"]);
    const pageSize = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
    const eligibility = and(eq(ideaReviews.decision, "approved"), eq(ideas.status, "decision"), eq(ideaReviews.id, sql `(select max(latest_review.id) from idea_reviews as latest_review where latest_review."ideaId" = ${ideas.id} and latest_review.decision = 'approved')`));
    const [count] = await db.select({ value: sql `count(*)` }).from(ideaReviews).innerJoin(ideas, eq(ideas.id, ideaReviews.ideaId)).where(eligibility).all();
    const rows = await db.select({ ...safeIdea, approvedAt: ideaReviews.createdAt, approvalReason: ideaReviews.reason, reviewerId: ideaReviews.reviewerId, approvalId: ideaReviews.id, aiValidationScore: ideaSubmissions.aiValidationScore, aiValidationAttempts: ideaSubmissions.aiValidationAttempts, submittedWithLowAiScore: ideaSubmissions.submittedWithLowAiScore })
        .from(ideaReviews).innerJoin(ideas, eq(ideas.id, ideaReviews.ideaId)).innerJoin(users, eq(users.id, ideas.authorId)).leftJoin(ideaSubmissions, eq(ideaSubmissions.ideaId, ideas.id))
        .where(and(eligibility, after ? sql `${ideaReviews.id} < ${after}` : undefined)).orderBy(desc(ideaReviews.id)).limit(pageSize + 1).all();
    const items = rows.slice(0, pageSize);
    return { items: items.map((row) => queueDueAt(row, stageDays("decision"))), nextAfter: rows.length > pageSize ? items.at(-1)?.approvalId ?? null : null, total: Number(count?.value ?? 0) };
}
export async function listRoutedEvaluations(actor, limit = 50, after = null) {
    const role = await requireGovernanceRole(actor, ["business_owner", "admin", "maintainer"]);
    const stage = "control_review";
    const rows = await db.select({ ...safeIdea, aiValidationScore: ideaSubmissions.aiValidationScore, aiValidationAttempts: ideaSubmissions.aiValidationAttempts, submittedWithLowAiScore: ideaSubmissions.submittedWithLowAiScore }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).leftJoin(ideaSubmissions, eq(ideaSubmissions.ideaId, ideas.id))
        .where(and(role === "business_owner" ? and(inArray(ideas.status, ["business_review", "control_review", "decision", "poc", "implementation", "implemented"]), eq(ideas.assignedUserId, actor.userId)) : eq(ideas.status, stage), after ? sql `${ideas.id} < ${after}` : undefined))
        .orderBy(desc(ideas.id)).limit(limit + 1).all();
    const page = rows.slice(0, limit);
    return { items: page.map((row) => queueDueAt(row, stageDays(stage))), nextAfter: rows.length > limit ? page.at(-1)?.id ?? null : null };
}
export async function listDeliveryQueue(actor, limit = 10, after = null) {
    await requireGovernanceRole(actor, ["admin", "maintainer"]);
    const rows = await db.select(safeIdea).from(ideas).innerJoin(users, eq(users.id, ideas.authorId))
        .where(and(inArray(ideas.status, ["owner_matching", "owner_assignment", "business_review", "control_review", "decision", "poc", "implementation", "implemented"]), after ? sql `${ideas.id} < ${after}` : undefined))
        .orderBy(desc(ideas.id)).limit(limit + 1).all();
    const page = rows.slice(0, limit);
    return { items: page, nextAfter: rows.length > limit ? page.at(-1)?.id ?? null : null };
}
export async function getEvaluation(ideaId, actor) {
    const role = await requireGovernanceRole(actor, ["admin", "maintainer", "business_owner"]);
    const [idea] = await db.select(safeIdea).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).where(eq(ideas.id, ideaId)).limit(1).all();
    if (!idea)
        throw new AdminNotFoundError("Idea not found.");
    if (idea.status === "draft" ||
        (role === "business_owner" && idea.assignedUserId !== actor.userId))
        throw new AdminNotFoundError("Idea not found.");
    const [submission] = await db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, ideaId)).limit(1).all();
    const [assessment] = await db.select({ resultJson: aiRuns.resultJson, jobKey: aiRuns.jobKey, completedAt: aiRuns.completedAt }).from(aiRuns).where(and(eq(aiRuns.ideaId, ideaId), eq(aiRuns.status, "succeeded"), inArray(aiRuns.jobKey, ["idea.validate", "idea.decision_pack"]))).orderBy(desc(aiRuns.createdAt)).limit(1).all();
    const [route] = await db.select({ metadataJson: ideaEvents.metadataJson, createdAt: ideaEvents.createdAt }).from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "business_owner_routed"))).orderBy(desc(ideaEvents.id)).limit(1).all();
    const [ownerMatchEvent] = await db.select({ eventType: ideaEvents.eventType, metadataJson: ideaEvents.metadataJson, createdAt: ideaEvents.createdAt }).from(ideaEvents)
        .where(and(eq(ideaEvents.ideaId, ideaId), inArray(ideaEvents.eventType, ["business_owner_assigned", "owner_match_manual_required"])))
        .orderBy(desc(ideaEvents.id)).limit(1).all();
    const [submitted] = await db.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "submitted"))).orderBy(desc(ideaEvents.id)).limit(1).all();
    const metrics = submission ? parsed(submission.metricsJson) : null;
    const submittedBreakdown = parsed(submitted?.metadataJson ?? null)?.breakdown;
    const savedBreakdown = Array.isArray(submittedBreakdown) && submittedBreakdown.length === 3 && submittedBreakdown.every((item) => item && typeof item === "object" && ["turnaround", "volume", "value"].includes(item.key) && typeof item.weight === "number" && typeof item.score === "number") ? submittedBreakdown : null;
    const breakdown = metrics ? (savedBreakdown ?? [
        { key: "turnaround", score: Number(metrics.turnaround), weight: 0.3 },
        { key: "volume", score: Number(metrics.volume), weight: 0.3 },
        { key: "value", score: Number(metrics.value), weight: 0.4 },
    ]).map((entry) => ({ ...entry, explanation: metrics[`${entry.key}Explanation`] ?? null })) : null;
    const required = idea.status === "control_review" ? controlSnapshot(db, ideaId)?.requiredControls ?? [] : [];
    const approved = idea.status === "control_review" ? approvedControls(db, ideaId).names : new Set();
    const ownerMatchMetadata = parsed(ownerMatchEvent?.metadataJson ?? null) ?? null;
    return { idea, submission: submission ? { answers: parsed(submission.answersJson), metrics, breakdown, score: submission.score, minimumScore: submission.minimumScore, validationPassed: submission.validationPassed, aiValidationScore: submission.aiValidationScore, aiValidationAttempts: submission.aiValidationAttempts, submittedWithLowAiScore: submission.submittedWithLowAiScore, differentiation: submission.differentiation, submittedAt: submission.submittedAt } : null, assessment: assessment ? { jobKey: assessment.jobKey, completedAt: assessment.completedAt, result: parsed(assessment.resultJson) } : null, route: route ? { ...parsed(route.metadataJson), createdAt: route.createdAt } : null, ownerMatch: ownerMatchEvent ? { ...ownerMatchMetadata, eventType: ownerMatchEvent.eventType, createdAt: ownerMatchEvent.createdAt } : null, controlReview: idea.status === "control_review" ? { required, approved: required.filter((name) => approved.has(name.toLowerCase())), pending: required.filter((name) => !approved.has(name.toLowerCase())) } : null };
}
export async function listGovernanceIdeas(actor, limit = 50, after = null) {
    await requireGovernanceRole(actor, ["admin", "maintainer"]);
    const rows = await db.select({ ...safeIdea, assignedOwnerName: sql `(select name from users where id = ${ideas.assignedUserId})` })
        .from(ideas).innerJoin(users, eq(users.id, ideas.authorId))
        .where(and(sql `${ideas.status} <> 'draft'`, after ? sql `${ideas.id} < ${after}` : undefined))
        .orderBy(desc(ideas.id)).limit(limit + 1).all();
    const items = rows.slice(0, limit);
    return { items, nextAfter: rows.length > limit ? items.at(-1)?.id ?? null : null };
}
export async function assignBusinessOwner(actor, ideaId, businessOwnerId, idempotencyKey) {
    const now = new Date();
    return db.transaction((tx) => {
        const role = assertActor(tx, actor, now);
        if (role !== "admin" && role !== "maintainer")
            throw new AuthorizationError("Only admins and maintainers can assign business owners.");
        if (idempotencyKey && !/^[\x21-\x7e]{8,200}$/.test(idempotencyKey))
            throw new AdminConflictError("A valid idempotency key is required.");
        const idea = tx.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).get();
        if (!idea || idea.status === "draft")
            throw new AdminNotFoundError("Idea not found.");
        if (idempotencyKey) {
            const prior = tx.select().from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.correlationId, idempotencyKey))).limit(1).get();
            if (prior) {
                const metadata = parsed(prior.metadataJson);
                if (prior.actorId !== actor.userId || !["assign_owner", "reassign_owner"].includes(metadata?.action ?? "") || metadata?.businessOwnerId !== businessOwnerId)
                    throw new AdminConflictError("Idempotency key was used for a different request.");
                return { ideaId, action: metadata.action, fromStatus: prior.fromStatus, toStatus: prior.toStatus, businessOwnerId };
            }
        }
        const owner = tx.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, businessOwnerId)).limit(1).get();
        if (!owner?.isActive || owner.role !== "business_owner")
            throw new AdminConflictError("Active business owner is required.");
        const previousOwnerId = idea.assignedUserId;
        if (previousOwnerId === businessOwnerId)
            throw new AdminConflictError("Idea is already assigned to this business owner.");
        const initialAssignment = previousOwnerId === null;
        if (initialAssignment && !["owner_matching", "owner_assignment"].includes(idea.status))
            throw new AdminConflictError("Only ideas awaiting owner assignment can receive an initial business owner.");
        const from = idea.status;
        const to = initialAssignment ? "business_review" : from;
        const action = initialAssignment ? "assign_owner" : "reassign_owner";
        const dueAt = initialAssignment ? new Date(now.getTime() + stageDays("business_review", tx) * 86_400_000) : idea.dueAt;
        const changed = tx.update(ideas).set({ assignedUserId: businessOwnerId, status: to, dueAt, updatedAt: now })
            .where(and(eq(ideas.id, ideaId), eq(ideas.status, from), previousOwnerId === null ? isNull(ideas.assignedUserId) : eq(ideas.assignedUserId, previousOwnerId))).run();
        if (!changed.changes)
            throw new AdminConflictError("Idea assignment changed; refresh and retry.");
        const eventType = initialAssignment ? "business_owner_assigned" : "business_owner_reassigned";
        tx.insert(ideaEvents).values({ ideaId, actorType: governanceEventActor(role), actorId: actor.userId, eventType, fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ action, previousOwnerId, businessOwnerId }) }).run();
        tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: `admin.governance.owner_${initialAssignment ? "assigned" : "reassigned"}`, targetType: "idea", targetId: ideaId, reason: initialAssignment ? "Business owner assigned" : "Business owner reassigned", requiresReason: false, metadata: { previousOwnerId, businessOwnerId, fromStatus: from, toStatus: to }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, now)).run();
        if (previousOwnerId !== null)
            tx.insert(notifications).values({ userId: previousOwnerId, type: "idea_reassigned", title: "Idea reassigned", body: `${idea.reference} has been reassigned to another business owner.`, link: `/ideas/${ideaId}` }).run();
        tx.insert(notifications).values({ userId: businessOwnerId, type: "idea_routed", title: initialAssignment ? "Idea assigned for delivery" : "Idea reassigned to you", body: `${idea.reference} is ready for your review.`, link: `/ideas/${ideaId}` }).run();
        return { ideaId, action, fromStatus: from, toStatus: to, businessOwnerId };
    });
}
export async function decideGovernance(actor, ideaId, action, reasonInput, idempotencyKey, controlName) {
    const now = new Date();
    return db.transaction((tx) => {
        const role = assertActor(tx, actor, now);
        const idea = tx.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).get();
        if (!idea || idea.status === "draft")
            throw new AdminNotFoundError("Idea not found.");
        const from = idea.status;
        const reason = governanceAuditMessage(action, role, idea.reference, from);
        const controlsSetting = from === "control_review" ? tx.select({ value: ideaSettings.value }).from(ideaSettings).where(eq(ideaSettings.key, "required_controls")).get() : undefined;
        const controlPolicy = from === "control_review" ? resolveRequiredControlsPolicy(controlsSetting?.value) : { configured: false, controls: [], requiresControlApproval: false };
        const requiresControlApproval = controlPolicy.requiresControlApproval;
        const snapshot = from === "control_review" || action === "approve" || action === "confirm" ? controlSnapshot(tx, ideaId) : null;
        const requiredNames = snapshot?.requiredControls ?? [];
        const priorControls = from === "control_review" || action === "confirm" ? approvedControls(tx, ideaId) : null;
        const ownerActions = ["approve", "not_recommended", "confirm", "start_implementation", "mark_implemented"].includes(action);
        const maintainerActions = ["accept", "reject", "defer"].includes(action) || (action === "return" && from === "screening");
        if (ownerActions && role !== "business_owner")
            throw new AuthorizationError("Business owner workflow access required.");
        if (maintainerActions && role !== "admin" && role !== "maintainer")
            throw new AuthorizationError("Maintainer review access required.");
        if (action === "return" && !maintainerActions && role !== "business_owner")
            throw new AuthorizationError("Only the assigned owner can return this idea at this stage.");
        if (ownerActions && assignedOwner(tx, ideaId) !== actor.userId)
            throw new AdminNotFoundError("Idea not found.");
        if (action === "return" && role === "business_owner" && (from !== "business_review" || assignedOwner(tx, ideaId) !== actor.userId))
            throw new AdminNotFoundError("Idea not found.");
        if (idempotencyKey && (!/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)))
            throw new AdminConflictError("A valid idempotency key is required.");
        if (idempotencyKey) {
            const prior = tx.select().from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.correlationId, idempotencyKey))).limit(1).get();
            if (prior) {
                const metadata = parsed(prior.metadataJson);
                if (prior.actorId !== actor.userId || metadata?.action !== action || (action === "approve" && prior.fromStatus === "control_review" && metadata.controlName?.toLowerCase() !== (controlName ?? (requiredNames.length === 1 ? requiredNames[0] : undefined))?.toLowerCase()))
                    throw new AdminConflictError("Idempotency key was used for a different request.");
                return { ideaId, action, fromStatus: prior.fromStatus, toStatus: prior.toStatus };
            }
        }
        let approvedControlName;
        if (action === "approve" && from === "control_review" && requiredNames.length) {
            approvedControlName = requiredNames.find((name) => name.toLowerCase() === (controlName ?? (requiredNames.length === 1 ? requiredNames[0] : "")).toLowerCase());
            if (!approvedControlName)
                throw new AdminConflictError("Select a required control to approve.");
            if (priorControls?.names.has(approvedControlName.toLowerCase()))
                throw new AdminConflictError("This control has already approved the idea.");
        }
        const controlsComplete = !requiredNames.length || requiredNames.every((name) => name === approvedControlName || priorControls?.names.has(name.toLowerCase()));
        const targets = { return: "returned", reject: "rejected", defer: "deferred", accept: "owner_matching", approve: from === "control_review" ? controlsComplete ? "decision" : "control_review" : "decision", not_recommended: "rejected", confirm: "poc", start_implementation: "implementation", mark_implemented: "implemented" };
        if (action === "accept" && from !== "screening")
            throw new AdminConflictError("Only screening ideas can be accepted for owner matching.");
        if (["return", "reject", "defer"].includes(action) && from !== "screening" && !(action === "return" && role === "business_owner" && from === "business_review"))
            throw new AdminConflictError("This action is not available at this stage.");
        if (["approve", "not_recommended"].includes(action) && from !== "business_review" && from !== "control_review")
            throw new AdminConflictError("This action is only available for routed evaluations.");
        if (controlName !== undefined && (action !== "approve" || from !== "control_review"))
            throw new AdminConflictError("A control name is only accepted for control approval.");
        if (controlName !== undefined && from === "control_review" && requiredNames.length === 0)
            throw new AdminConflictError("This control review does not have named controls.");
        if (action === "confirm" && from !== "decision")
            throw new AdminConflictError("Only ideas awaiting transformation confirmation can be accepted.");
        if (action === "start_implementation" && from !== "poc")
            throw new AdminConflictError("Only proof-of-concept ideas can enter implementation.");
        if (action === "mark_implemented" && from !== "implementation")
            throw new AdminConflictError("Only ideas in implementation can be completed.");
        if (action === "confirm") {
            const events = tx.select({ eventType: ideaEvents.eventType, metadataJson: ideaEvents.metadataJson }).from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), inArray(ideaEvents.eventType, ["business_owner_approved", "control_approved"]))).orderBy(desc(ideaEvents.id)).all();
            const types = new Set(events.map(({ eventType }) => eventType));
            if (!types.has("business_owner_approved"))
                throw new AdminConflictError("Business owner approval is required before confirmation.");
        }
        const to = targets[action];
        if (action !== "approve" && action !== "not_recommended") {
            tx.update(ideas).set({
                status: to,
                assignedUserId: action === "return" || action === "reject" || action === "defer" || action === "accept" ? null : idea.assignedUserId,
                dueAt: action === "accept" || action === "confirm" || action === "start_implementation" ? new Date(now.getTime() + stageDays(to, tx) * 86_400_000) : null,
                updatedAt: now,
            }).where(and(eq(ideas.id, ideaId), eq(ideas.status, from))).run();
        }
        if (action === "approve" || action === "not_recommended") {
            tx.insert(ideaReviews).values({ ideaId, reviewerId: actor.userId, decision: action === "approve" ? "approved" : "rejected", reason }).run();
            const eventType = action !== "approve" ? from === "control_review" ? "control_not_recommended" : "business_owner_not_recommended" : from === "control_review" ? "control_approved" : "business_owner_approved";
            tx.insert(ideaEvents).values({ ideaId, actorType: governanceEventActor(role), actorId: actor.userId, eventType, fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ reason, action, ...(eventType === "business_owner_approved" ? { requiresControlApproval, requiredControls: controlPolicy.controls } : {}), ...(approvedControlName ? { controlName: approvedControlName } : {}) }) }).run();
            tx.update(ideas).set({ status: to, assignedUserId: idea.assignedUserId, dueAt: action === "approve" ? to === from ? idea.dueAt : new Date(now.getTime() + stageDays(to, tx) * 86_400_000) : null, updatedAt: now }).where(eq(ideas.id, ideaId)).run();
            if (action === "approve" && to !== from)
                tx.insert(notifications).values({ userId: idea.authorId, type: from === "control_review" ? "idea_control_approved" : "idea_owner_approved", title: from === "control_review" ? "Your idea passed control review" : "Your idea was approved by its business owner", body: `${idea.reference} moved to ${to === "decision" ? "transformation confirmation" : "control review"}.`, link: `/ideas/${ideaId}` }).run();
        }
        if (action === "accept") {
            tx.insert(ideaReviews).values({ ideaId, reviewerId: actor.userId, decision: "approved", reason }).run();
            tx.insert(ideaEvents).values({ ideaId, actorType: governanceEventActor(role), actorId: actor.userId, eventType: "screening_accepted", fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ reason, action, approvalPath: role }) }).run();
        }
        if (["return", "reject", "defer"].includes(action))
            tx.insert(ideaReviews).values({ ideaId, reviewerId: actor.userId, decision: action === "return" ? "returned" : action === "reject" ? "rejected" : "deferred", reason }).run();
        if (["return", "reject", "defer", "confirm", "start_implementation", "mark_implemented"].includes(action)) {
            tx.insert(ideaEvents).values({ ideaId, actorType: governanceEventActor(role), actorId: actor.userId, eventType: action === "confirm" ? "transformation_confirmed" : "status_changed", fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ reason, action }) }).run();
        }
        if (action !== "approve") {
            const accepted = action === "accept" || action === "confirm";
            tx.insert(notifications).values({ userId: idea.authorId, type: accepted ? "idea_accepted" : "idea_status_changed", title: accepted ? action === "accept" ? "Idea accepted for owner matching" : "Idea accepted for proof of concept" : "Idea workflow updated", body: accepted ? action === "accept" ? `${idea.reference} was accepted and is being matched with a business owner.` : `Congratulations, ${idea.reference} has been accepted for proof of concept.` : `${idea.reference} moved from ${from} to ${to}.`, link: `/ideas/${ideaId}` }).run();
        }
        tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: `admin.governance.${action}`, targetType: "idea", targetId: ideaId, reason, requiresReason: false, metadata: { fromStatus: from, toStatus: to, controlName: approvedControlName ?? null }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, now)).run();
        return { ideaId, action, fromStatus: from, toStatus: to };
    });
}
