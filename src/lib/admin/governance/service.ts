import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../../db/connection";
import { aiRuns, auditEvents, ideaEvents, ideaReviews, ideaSettings, ideaSubmissions, ideas, notifications, refreshTokens, users } from "../../../db/schema";
import { isSessionActive } from "../../../auth/security-core";
import { AuthorizationError, requirePrivilegedReason } from "../../auth/authorization-core";
import { buildAuditRecord } from "../../audit/service";
import { AdminConflictError, AdminNotFoundError } from "../query";
import { resolveRequiredControlsPolicy } from "../settings/validation";
import type { UserRole } from "../../../db/schema";

export type GovernanceActor = { userId: number; sessionId: number; ipAddress?: string | null; userAgent?: string | null };
const safeIdea = { id: ideas.id, reference: ideas.reference, title: ideas.title, summary: ideas.summary, problem: ideas.problem, solution: ideas.solution, benefits: ideas.benefits, risks: ideas.risks, kind: ideas.kind, category: ideas.category, status: ideas.status, assignedUserId: ideas.assignedUserId, dueAt: ideas.dueAt, priorityBand: ideas.priorityBand, priorityScore: ideas.priorityScore, authorId: ideas.authorId, authorName: users.name, department: users.department, createdAt: ideas.createdAt, updatedAt: ideas.updatedAt };

function assertActor(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], actor: GovernanceActor, now: Date): UserRole {
  const user = tx.select({ id: users.id, role: users.role, isActive: users.isActive, sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, actor.userId)).limit(1).get();
  const session = tx.select({ userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt, revokedAt: refreshTokens.revokedAt, idleExpiresAt: refreshTokens.idleExpiresAt, absoluteExpiresAt: refreshTokens.absoluteExpiresAt, sessionVersion: refreshTokens.sessionVersion }).from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).limit(1).get();
  if (!user || !user.isActive || !session || session.userId !== user.id || session.expiresAt <= now || !isSessionActive(session, user, now)) throw new AuthorizationError("Session is no longer valid.");
  return user.role;
}

export async function requireGovernanceRole(actor: GovernanceActor, allowed: readonly UserRole[]) {
  const role = db.transaction((tx) => assertActor(tx, actor, new Date()));
  if (!allowed.includes(role)) throw new AuthorizationError("This role cannot access this queue.");
  return role;
}

function assignedOwner(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], ideaId: number): number | null {
  return tx.select({ assignedUserId: ideas.assignedUserId }).from(ideas).where(eq(ideas.id, ideaId)).get()?.assignedUserId ?? null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function stageDays(stage: string, tx: Tx | typeof db = db): number {
  const setting = tx.select({ value: ideaSettings.value }).from(ideaSettings).where(eq(ideaSettings.key, "sla_days")).get();
  const days = (parsed(setting?.value ?? null) as Record<string, unknown> | null)?.[stage];
  return typeof days === "number" && Number.isInteger(days) && days >= 1 && days <= 365 ? days : 4;
}

type ControlSnapshot = { requiresControlApproval?: boolean; requiredControls?: string[] };

function controlSnapshot(tx: Tx | typeof db, ideaId: number): ControlSnapshot | null {
  const ownerApproval = tx.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents)
    .where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "business_owner_approved"))).orderBy(desc(ideaEvents.id)).limit(1).get();
  return parsed(ownerApproval?.metadataJson ?? null) as ControlSnapshot | null;
}

function approvedControls(tx: Tx | typeof db, ideaId: number): { names: Set<string>; approvers: Set<number>; legacyApproval: boolean } {
  const events = tx.select({ metadataJson: ideaEvents.metadataJson, actorId: ideaEvents.actorId }).from(ideaEvents)
    .where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "control_approved"))).all();
  const names = new Set<string>();
  const approvers = new Set<number>();
  let legacyApproval = false;
  for (const event of events) {
    const name = (parsed(event.metadataJson) as { controlName?: unknown } | null)?.controlName;
    if (typeof name === "string") {
      names.add(name.toLowerCase());
      if (event.actorId !== null) approvers.add(event.actorId);
    }
    else legacyApproval = true;
  }
  return { names, approvers, legacyApproval };
}

function queueDueAt<T extends { dueAt: Date | null; createdAt: Date }>(item: T, days: number, startAt = item.createdAt): T {
  return { ...item, dueAt: item.dueAt ?? new Date(startAt.getTime() + days * 86_400_000) };
}

export async function listBusinessOwners(actor: GovernanceActor, limit = 100, after: number | null = null) {
  await requireGovernanceRole(actor, ["back_office"]);
  const rows = db.select({ id: users.id, name: users.name, department: users.department }).from(users)
    .where(and(eq(users.role, "business_owner"), eq(users.isActive, true), after ? sql`${users.id} < ${after}` : undefined))
    .orderBy(desc(users.id)).limit(limit + 1).all();
  return { items: rows.slice(0, limit), nextAfter: rows.length > limit ? rows[limit - 1]?.id ?? null : null };
}

function parsed(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

export async function listScreeningQueue(limit = 50, after: number | null = null) {
  const [count] = await db.select({ value: sql<number>`count(*)` }).from(ideas).where(eq(ideas.status, "screening")).all();
  const rows = await db.select({ ...safeIdea, submittedAt: ideaSubmissions.submittedAt, aiValidationScore: ideaSubmissions.aiValidationScore, aiValidationAttempts: ideaSubmissions.aiValidationAttempts, submittedWithLowAiScore: ideaSubmissions.submittedWithLowAiScore }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).leftJoin(ideaSubmissions, eq(ideaSubmissions.ideaId, ideas.id)).where(and(eq(ideas.status, "screening"), after ? sql`${ideas.id} < ${after}` : undefined)).orderBy(desc(ideas.id)).limit(limit + 1).all();
  return { items: rows.slice(0, limit).map(({ submittedAt, ...row }) => queueDueAt(row, stageDays("screening"), submittedAt ?? row.createdAt)), nextAfter: rows.length > limit ? rows[limit - 1]?.id ?? null : null, total: Number(count?.value ?? 0) };
}

export async function listTransformationQueue(limit = 50, after: number | null = null) {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
  const eligibility = and(
    eq(ideaReviews.decision, "approved"),
    eq(ideas.status, "decision"),
    eq(ideaReviews.id, sql`(select max(latest_review.id) from idea_reviews as latest_review where latest_review."ideaId" = ${ideas.id} and latest_review.decision = 'approved')`),
  );
  const [count] = await db.select({ value: sql<number>`count(*)` }).from(ideaReviews).innerJoin(ideas, eq(ideas.id, ideaReviews.ideaId)).where(eligibility).all();
  const rows = await db.select({ ...safeIdea, approvedAt: ideaReviews.createdAt, approvalReason: ideaReviews.reason, reviewerId: ideaReviews.reviewerId, approvalId: ideaReviews.id, aiValidationScore: ideaSubmissions.aiValidationScore, aiValidationAttempts: ideaSubmissions.aiValidationAttempts, submittedWithLowAiScore: ideaSubmissions.submittedWithLowAiScore })
    .from(ideaReviews).innerJoin(ideas, eq(ideas.id, ideaReviews.ideaId)).innerJoin(users, eq(users.id, ideas.authorId)).leftJoin(ideaSubmissions, eq(ideaSubmissions.ideaId, ideas.id))
    .where(and(eligibility, after ? sql`${ideaReviews.id} < ${after}` : undefined)).orderBy(desc(ideaReviews.id)).limit(pageSize + 1).all();
  const items = rows.slice(0, pageSize);
  return { items: items.map((row) => queueDueAt(row, stageDays("decision"))), nextAfter: rows.length > pageSize ? items.at(-1)?.approvalId ?? null : null, total: Number(count?.value ?? 0) };
}

export async function listRoutedEvaluations(actor: GovernanceActor, limit = 50, after: number | null = null) {
  const role = await requireGovernanceRole(actor, ["business_owner", "back_office"]);
  const stage = role === "business_owner" ? "business_review" : "control_review";
  const rows = await db.select({ ...safeIdea, aiValidationScore: ideaSubmissions.aiValidationScore, aiValidationAttempts: ideaSubmissions.aiValidationAttempts, submittedWithLowAiScore: ideaSubmissions.submittedWithLowAiScore }).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).leftJoin(ideaSubmissions, eq(ideaSubmissions.ideaId, ideas.id))
    .where(and(eq(ideas.status, stage), role === "business_owner" ? eq(ideas.assignedUserId, actor.userId) : undefined, after ? sql`${ideas.id} < ${after}` : undefined))
    .orderBy(desc(ideas.id)).limit(limit + 1).all();
  const page = rows.slice(0, limit);
  return { items: page.map((row) => queueDueAt(row, stageDays(stage))), nextAfter: rows.length > limit ? page.at(-1)?.id ?? null : null };
}

export async function listDeliveryQueue(actor: GovernanceActor, limit = 10, after: number | null = null) {
  await requireGovernanceRole(actor, ["back_office"]);
  const rows = await db.select(safeIdea).from(ideas).innerJoin(users, eq(users.id, ideas.authorId))
    .where(and(inArray(ideas.status, ["poc", "implementation", "implemented"]), after ? sql`${ideas.id} < ${after}` : undefined))
    .orderBy(desc(ideas.id)).limit(limit + 1).all();
  const page = rows.slice(0, limit);
  return { items: page, nextAfter: rows.length > limit ? page.at(-1)?.id ?? null : null };
}

export async function getEvaluation(ideaId: number, actor: GovernanceActor) {
  const role = await requireGovernanceRole(actor, ["back_office", "business_owner"]);
  const [idea] = await db.select(safeIdea).from(ideas).innerJoin(users, eq(users.id, ideas.authorId)).where(eq(ideas.id, ideaId)).limit(1).all();
  if (!idea) throw new AdminNotFoundError("Idea not found.");
  if (idea.status === "draft" ||
    (role === "business_owner" && (idea.status !== "business_review" || idea.assignedUserId !== actor.userId)) ||
    (role === "back_office" && !["screening", "control_review", "decision", "poc", "implementation", "implemented"].includes(idea.status))) throw new AdminNotFoundError("Idea not found.");
  const [submission] = await db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, ideaId)).limit(1).all();
  const [assessment] = await db.select({ resultJson: aiRuns.resultJson, jobKey: aiRuns.jobKey, completedAt: aiRuns.completedAt }).from(aiRuns).where(and(eq(aiRuns.ideaId, ideaId), eq(aiRuns.status, "succeeded"), inArray(aiRuns.jobKey, ["idea.validate", "idea.decision_pack"]))).orderBy(desc(aiRuns.createdAt)).limit(1).all();
  const [route] = await db.select({ metadataJson: ideaEvents.metadataJson, createdAt: ideaEvents.createdAt }).from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "business_owner_routed"))).orderBy(desc(ideaEvents.id)).limit(1).all();
  const [submitted] = await db.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "submitted"))).orderBy(desc(ideaEvents.id)).limit(1).all();
  const metrics = submission ? parsed(submission.metricsJson) as Record<string, string | number> : null;
  const submittedBreakdown = (parsed(submitted?.metadataJson ?? null) as { breakdown?: unknown } | null)?.breakdown;
  const savedBreakdown = Array.isArray(submittedBreakdown) && submittedBreakdown.length === 3 && submittedBreakdown.every((item) => item && typeof item === "object" && ["turnaround", "volume", "value"].includes(item.key) && typeof item.weight === "number" && typeof item.score === "number") ? submittedBreakdown as Array<{ key: "turnaround" | "volume" | "value"; score: number; weight: number; contribution?: number; question?: string; hint?: string }> : null;
  const breakdown = metrics ? (savedBreakdown ?? [
    { key: "turnaround" as const, score: Number(metrics.turnaround), weight: 0.3 },
    { key: "volume" as const, score: Number(metrics.volume), weight: 0.3 },
    { key: "value" as const, score: Number(metrics.value), weight: 0.4 },
  ]).map((entry) => ({ ...entry, explanation: metrics[`${entry.key}Explanation`] ?? null })) : null;
  const required = idea.status === "control_review" ? controlSnapshot(db, ideaId)?.requiredControls ?? [] : [];
  const approved = idea.status === "control_review" ? approvedControls(db, ideaId).names : new Set<string>();
  return { idea, submission: submission ? { answers: parsed(submission.answersJson), metrics, breakdown, score: submission.score, minimumScore: submission.minimumScore, validationPassed: submission.validationPassed, aiValidationScore: submission.aiValidationScore, aiValidationAttempts: submission.aiValidationAttempts, submittedWithLowAiScore: submission.submittedWithLowAiScore, differentiation: submission.differentiation, submittedAt: submission.submittedAt } : null, assessment: assessment ? { jobKey: assessment.jobKey, completedAt: assessment.completedAt, result: parsed(assessment.resultJson) } : null, route: route ? { ...parsed(route.metadataJson) as object, createdAt: route.createdAt } : null, controlReview: idea.status === "control_review" ? { required, approved: required.filter((name) => approved.has(name.toLowerCase())), pending: required.filter((name) => !approved.has(name.toLowerCase())) } : null };
}

export async function decideGovernance(actor: GovernanceActor, ideaId: number, action: "route" | "return" | "reject" | "defer" | "accept" | "approve" | "not_recommended" | "confirm" | "start_implementation" | "mark_implemented", reasonInput: unknown, businessOwnerId?: number, dueAt?: Date | null, idempotencyKey?: string, controlName?: string) {
  const reason = requirePrivilegedReason(reasonInput);
  const now = new Date();
  return db.transaction((tx) => {
    const role = assertActor(tx, actor, now);
    const idea = tx.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).get();
    if (!idea || idea.status === "draft") throw new AdminNotFoundError("Idea not found.");
    const from = idea.status;
    const controlsSetting = tx.select({ value: ideaSettings.value }).from(ideaSettings).where(eq(ideaSettings.key, "required_controls")).get();
    const controlPolicy = resolveRequiredControlsPolicy(controlsSetting?.value);
    const requiresControlApproval = controlPolicy.requiresControlApproval;
    const snapshot = from === "control_review" || action === "approve" || action === "confirm" ? controlSnapshot(tx, ideaId) : null;
    const requiredNames = snapshot?.requiredControls ?? [];
    const priorControls = from === "control_review" || action === "confirm" ? approvedControls(tx, ideaId) : null;
    if (["route", "reject", "defer", "accept", "confirm", "start_implementation", "mark_implemented"].includes(action) && role !== "back_office") throw new AuthorizationError("Back-office workflow access required.");
    if (["approve", "not_recommended"].includes(action) && ((from === "business_review" && role !== "business_owner") || (from === "control_review" && role !== "back_office"))) throw new AuthorizationError("Business owner or back-office approval is required.");
    if (action === "return" && role !== "back_office" && role !== "business_owner") throw new AuthorizationError("Back-office or business-owner access required.");
    if (["approve", "not_recommended"].includes(action) && role === "business_owner" && assignedOwner(tx, ideaId) !== actor.userId) throw new AdminNotFoundError("Idea not found.");
    if (action === "return" && role === "business_owner" && (from !== "business_review" || assignedOwner(tx, ideaId) !== actor.userId)) throw new AdminNotFoundError("Idea not found.");
    if (idempotencyKey && (!/^[\x21-\x7e]{8,200}$/.test(idempotencyKey))) throw new AdminConflictError("A valid idempotency key is required.");
    if (idempotencyKey) {
      const prior = tx.select().from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.correlationId, idempotencyKey))).limit(1).get();
      if (prior) {
        const metadata = parsed(prior.metadataJson) as { action?: string; reason?: string; businessOwnerId?: number; dueAt?: string | null; requestedDueAt?: string | null; controlName?: string } | null;
        const requestedDueAt = metadata && Object.hasOwn(metadata, "requestedDueAt") ? metadata.requestedDueAt : metadata?.dueAt;
        if (prior.actorId !== actor.userId || metadata?.action !== action || metadata.reason !== reason || (action === "route" && (metadata.businessOwnerId !== businessOwnerId || requestedDueAt !== (dueAt?.toISOString() ?? null))) || (action === "approve" && prior.fromStatus === "control_review" && metadata.controlName?.toLowerCase() !== (controlName ?? (requiredNames.length === 1 ? requiredNames[0] : undefined))?.toLowerCase())) throw new AdminConflictError("Idempotency key was used for a different request.");
        return { ideaId, action, fromStatus: prior.fromStatus, toStatus: prior.toStatus };
      }
    }
    let approvedControlName: string | undefined;
    if (action === "approve" && from === "control_review" && requiredNames.length) {
      approvedControlName = requiredNames.find((name) => name.toLowerCase() === (controlName ?? (requiredNames.length === 1 ? requiredNames[0] : "")).toLowerCase());
      if (!approvedControlName) throw new AdminConflictError("Select a required control to approve.");
      if (priorControls?.names.has(approvedControlName.toLowerCase())) throw new AdminConflictError("This control has already approved the idea.");
      if (priorControls?.approvers.has(actor.userId)) throw new AdminConflictError("A different control reviewer must approve each required control.");
    }
    const controlsComplete = !requiredNames.length || requiredNames.every((name) => name === approvedControlName || priorControls?.names.has(name.toLowerCase()));
    const targets: Record<typeof action, string> = { route: "business_review", return: "returned", reject: "rejected", defer: "deferred", accept: "poc", approve: from === "control_review" ? controlsComplete ? "decision" : "control_review" : !requiresControlApproval ? "decision" : "control_review", not_recommended: "rejected", confirm: "poc", start_implementation: "implementation", mark_implemented: "implemented" };
    if (action === "route" && (from !== "screening" || !businessOwnerId)) throw new AdminConflictError("Only screening ideas can be routed to a business owner.");
    if (action === "accept" && from !== "screening") throw new AdminConflictError("Direct acceptance is only available for ideas in screening.");
    if (action === "route" && dueAt !== undefined && dueAt !== null && (!Number.isFinite(dueAt.getTime()) || dueAt.getTime() <= now.getTime() || dueAt.getTime() > now.getTime() + stageDays("business_review", tx) * 86_400_000)) throw new AdminConflictError("Owner due date must be within the business review SLA.");
    if (["return", "reject", "defer"].includes(action) && from !== "screening" && !(action === "return" && role === "business_owner" && from === "business_review")) throw new AdminConflictError("This action is not available at this stage.");
    if (["approve", "not_recommended"].includes(action) && from !== "business_review" && from !== "control_review") throw new AdminConflictError("This action is only available for routed evaluations.");
    if (controlName !== undefined && (action !== "approve" || from !== "control_review")) throw new AdminConflictError("A control name is only accepted for control approval.");
    if (controlName !== undefined && from === "control_review" && requiredNames.length === 0) throw new AdminConflictError("This control review does not have named controls.");
    if (action === "confirm" && from !== "decision") throw new AdminConflictError("Only ideas awaiting transformation confirmation can be accepted.");
    if (action === "start_implementation" && from !== "poc") throw new AdminConflictError("Only proof-of-concept ideas can enter implementation.");
    if (action === "mark_implemented" && from !== "implementation") throw new AdminConflictError("Only ideas in implementation can be completed.");
    if (action === "confirm") {
      const events = tx.select({ eventType: ideaEvents.eventType, metadataJson: ideaEvents.metadataJson }).from(ideaEvents).where(and(eq(ideaEvents.ideaId, ideaId), inArray(ideaEvents.eventType, ["business_owner_approved", "control_approved"]))).orderBy(desc(ideaEvents.id)).all();
      const types = new Set(events.map(({ eventType }) => eventType));
      if (!types.has("business_owner_approved")) throw new AdminConflictError("Business owner approval is required before confirmation.");
      const approvalMetadata = parsed(events.find((event) => event.eventType === "business_owner_approved")?.metadataJson ?? null) as { requiresControlApproval?: unknown } | null;
      const controlRequiredForIdea = typeof approvalMetadata?.requiresControlApproval === "boolean" ? approvalMetadata.requiresControlApproval : requiresControlApproval;
      if (controlRequiredForIdea && (!types.has("control_approved") || (requiredNames.length > 0 && !priorControls?.legacyApproval && !requiredNames.every((name) => priorControls?.names.has(name.toLowerCase()))))) throw new AdminConflictError("All required controls must approve before confirmation.");
    }
    if (action === "route") {
      const owner = tx.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, businessOwnerId!)).limit(1).get();
      if (!owner?.isActive || owner.role !== "business_owner") throw new AdminConflictError("Active business owner is required.");
    }
    const to = targets[action] as typeof idea.status;
    if (action !== "approve" && action !== "route" && action !== "not_recommended") tx.update(ideas).set({ status: to, assignedUserId: action === "return" || action === "reject" || action === "defer" || action === "accept" ? null : idea.assignedUserId, dueAt: action === "accept" || action === "confirm" || action === "start_implementation" ? new Date(now.getTime() + stageDays(to) * 86_400_000) : null, updatedAt: now }).where(and(eq(ideas.id, ideaId), eq(ideas.status, from))).run();
    if (action === "route") {
      const effectiveDueAt = dueAt ?? new Date(now.getTime() + stageDays("business_review", tx) * 86_400_000);
      tx.update(ideas).set({ status: to, assignedUserId: businessOwnerId, dueAt: effectiveDueAt, updatedAt: now }).where(and(eq(ideas.id, ideaId), eq(ideas.status, from))).run();
      tx.insert(ideaEvents).values({ ideaId, actorType: "admin", actorId: actor.userId, eventType: "business_owner_routed", fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ businessOwnerId, dueAt: effectiveDueAt.toISOString(), requestedDueAt: dueAt?.toISOString() ?? null, reason, action }) }).run();
      tx.insert(notifications).values({ userId: businessOwnerId!, type: "idea_routed", title: "Idea routed for evaluation", body: `${idea.reference} is ready for your evaluation.`, link: `/ideas/${ideaId}` }).run();
    }
    if (action === "approve" || action === "not_recommended") {
      tx.insert(ideaReviews).values({ ideaId, reviewerId: actor.userId, decision: action === "approve" ? "approved" : "rejected", reason }).run();
      const eventType = action !== "approve" ? from === "control_review" ? "control_not_recommended" : "business_owner_not_recommended" : from === "control_review" ? "control_approved" : "business_owner_approved";
      tx.insert(ideaEvents).values({ ideaId, actorType: "admin", actorId: actor.userId, eventType, fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ reason, action, ...(eventType === "business_owner_approved" ? { requiresControlApproval, requiredControls: controlPolicy.controls } : {}), ...(approvedControlName ? { controlName: approvedControlName } : {}) }) }).run();
      tx.update(ideas).set({ status: to, assignedUserId: null, dueAt: action === "approve" ? to === from ? idea.dueAt : new Date(now.getTime() + stageDays(to, tx) * 86_400_000) : null, updatedAt: now }).where(eq(ideas.id, ideaId)).run();
      if (action === "approve" && to !== from) tx.insert(notifications).values({ userId: idea.authorId, type: from === "control_review" ? "idea_control_approved" : "idea_owner_approved", title: from === "control_review" ? "Your idea passed control review" : "Your idea was approved by its business owner", body: `${idea.reference} moved to ${to === "decision" ? "transformation confirmation" : "control review"}.`, link: `/ideas/${ideaId}` }).run();
    }
    if (action === "accept") {
      tx.insert(ideaReviews).values({ ideaId, reviewerId: actor.userId, decision: "approved", reason }).run();
      tx.insert(ideaEvents).values({ ideaId, actorType: "admin", actorId: actor.userId, eventType: "screening_accepted", fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ reason, action, approvalPath: "back_office_direct" }) }).run();
    }
    if (["return", "reject", "defer"].includes(action)) tx.insert(ideaReviews).values({ ideaId, reviewerId: actor.userId, decision: action === "return" ? "returned" : action === "reject" ? "rejected" : "deferred", reason }).run();
    if (["return", "reject", "defer", "confirm", "start_implementation", "mark_implemented"].includes(action)) {
      tx.insert(ideaEvents).values({ ideaId, actorType: "admin", actorId: actor.userId, eventType: action === "confirm" ? "transformation_confirmed" : "status_changed", fromStatus: from, toStatus: to, correlationId: idempotencyKey ?? null, metadataJson: JSON.stringify({ reason, action }) }).run();
    }
    if (action !== "approve") {
      const accepted = action === "accept" || action === "confirm";
      tx.insert(notifications).values({ userId: idea.authorId, type: accepted ? "idea_accepted" : "idea_status_changed", title: accepted ? "Idea accepted for proof of concept" : "Idea workflow updated", body: accepted ? `Congratulations, ${idea.reference} has been accepted for proof of concept.` : `${idea.reference} moved from ${from} to ${to}.`, link: `/ideas/${ideaId}` }).run();
    }
    tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: `admin.governance.${action}`, targetType: "idea", targetId: ideaId, reason, requiresReason: true, metadata: { fromStatus: from, toStatus: to, businessOwnerId: action === "route" ? businessOwnerId : null, controlName: approvedControlName ?? null, dueAt: action === "route" ? tx.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, ideaId)).get()?.dueAt?.toISOString() ?? null : null }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, now)).run();
    return { ideaId, action, fromStatus: from, toStatus: to };
  });
}
