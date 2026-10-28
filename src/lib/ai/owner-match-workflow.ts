import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/connection";
import { aiRuns, auditEvents, ideaEvents, ideaSettings, ideaVersions, ideas, notifications, users, type AiRun } from "../../db/schema";
import { buildAuditRecord } from "../audit/service";
import { createAiRun } from "../ideas/repository";
import { getAiConfig } from "./config-core";
import { IDEA_OWNER_MATCH_MAX_CANDIDATES, ideaOwnerMatchJob, ideaOwnerMatchInputSchema, validateIdeaOwnerMatchOutput } from "./jobs/idea-owner-match";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function notifyMaintainers(tx: Tx, ideaId: number, reference: string, now: Date, body: string) {
  const recipients = tx.select({ id: users.id }).from(users).where(and(
    inArray(users.role, ["admin", "maintainer"]),
    eq(users.isActive, true),
  )).all();
  for (const recipient of recipients) tx.insert(notifications).values({
    userId: recipient.id,
    type: "idea_owner_assignment_required",
    title: "Business owner assignment needed",
    body: `${reference}: ${body}`,
    link: `/ideas/${ideaId}`,
    createdAt: now,
    updatedAt: now,
  }).run();
}

function requireManualAssignmentTx(tx: Tx, ideaId: number, reasonCode: string, now = new Date(), details: { confidence?: number; rationale?: string; runId?: number } = {}) {
  const idea = tx.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).get();
  if (!idea || idea.status !== "owner_matching" || idea.assignedUserId !== null) return false;
  tx.update(ideas).set({ status: "owner_assignment", dueAt: null, updatedAt: now })
    .where(and(eq(ideas.id, ideaId), eq(ideas.status, "owner_matching"), isNull(ideas.assignedUserId))).run();
  const metadata = {
    reasonCode: reasonCode.slice(0, 80),
    ...(details.runId ? { runId: details.runId } : {}),
    ...(typeof details.confidence === "number" ? { confidence: details.confidence } : {}),
    ...(details.rationale ? { rationale: details.rationale.slice(0, 400) } : {}),
  };
  tx.insert(ideaEvents).values({
    ideaId,
    actorType: "system",
    actorId: null,
    eventType: "owner_match_manual_required",
    fromStatus: "owner_matching",
    toStatus: "owner_assignment",
    correlationId: details.runId ? `ai-run:${details.runId}` : null,
    metadataJson: JSON.stringify(metadata),
    createdAt: now,
  }).run();
  tx.insert(auditEvents).values(buildAuditRecord({
    action: "ideas.owner_match.manual_assignment_required",
    targetType: "idea",
    targetId: ideaId,
    reason: "AI owner matching did not produce an assignable result.",
    metadata: { fromStatus: "owner_matching", toStatus: "owner_assignment", reasonCode, runId: details.runId ?? null },
  }, now)).run();
  notifyMaintainers(tx, ideaId, idea.reference, now, "AI could not assign a business owner. Please assign one manually.");
  tx.insert(notifications).values({
    userId: idea.authorId,
    type: "idea_status_changed",
    title: "Your idea is awaiting an owner",
    body: `${idea.reference} passed maintainer review and is awaiting business owner assignment.`,
    link: `/ideas/${ideaId}`,
    createdAt: now,
    updatedAt: now,
  }).run();
  return true;
}

/** Queue a single idempotent owner-match run after maintainer acceptance. */
export async function queueOwnerMatchForIdea(ideaId: number, requestedBy: number, correlationId: string) {
  const snapshot = db.transaction((tx) => {
    const idea = tx.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).get();
    if (!idea || idea.status !== "owner_matching" || idea.assignedUserId !== null) return null;
    const version = tx.select().from(ideaVersions).where(eq(ideaVersions.ideaId, ideaId)).orderBy(desc(ideaVersions.version)).limit(1).get();
    const acceptance = tx.select({ id: ideaEvents.id }).from(ideaEvents).where(and(
      eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "screening_accepted"), eq(ideaEvents.toStatus, "owner_matching"),
    )).orderBy(desc(ideaEvents.id)).limit(1).get();
    const candidates = tx.select({ id: users.id, businessProfile: users.businessProfile }).from(users).where(and(
      eq(users.role, "business_owner"), eq(users.isActive, true),
    )).orderBy(users.id).all().filter((owner) => owner.businessProfile?.trim());
    return { idea, version, acceptance, candidates };
  });

  if (!snapshot) return { status: "not_matching" as const };
  if (!snapshot.version) {
    await requireManualOwnerAssignment(ideaId, "idea_version_missing");
    return { status: "manual_assignment_required" as const };
  }
  if (snapshot.candidates.length === 0) {
    await requireManualOwnerAssignment(ideaId, "no_profiled_business_owners");
    return { status: "manual_assignment_required" as const };
  }
  if (snapshot.candidates.length > IDEA_OWNER_MATCH_MAX_CANDIDATES) {
    await requireManualOwnerAssignment(ideaId, "too_many_business_owner_candidates");
    return { status: "manual_assignment_required" as const };
  }

  const input = ideaOwnerMatchInputSchema.safeParse({
    ideaSummary: [snapshot.version.title, snapshot.version.summary, snapshot.version.problem, snapshot.version.solution, snapshot.version.benefits, snapshot.version.risks]
      .filter((value): value is string => Boolean(value?.trim())).join("\n").slice(0, 8_000),
    candidates: snapshot.candidates.map((candidate) => ({ candidateOwnerId: candidate.id, businessProfile: candidate.businessProfile!.trim().slice(0, 1_000) })),
  });
  if (!input.success) {
    await requireManualOwnerAssignment(ideaId, "owner_match_input_invalid");
    return { status: "manual_assignment_required" as const };
  }

  const version = snapshot.version;
  const idempotencyKey = `idea:${ideaId}:owner-match:${snapshot.acceptance?.id ?? version.id}`;
  const run = await createAiRun({
    ideaId,
    ideaVersionId: version.id,
    jobKey: ideaOwnerMatchJob.key,
    jobVersion: ideaOwnerMatchJob.version,
    model: getAiConfig().model,
    idempotencyKey,
    correlationId,
    requestedBy,
    inputHash: createHash("sha256").update(JSON.stringify(input.data)).digest("hex"),
    inputJson: JSON.stringify(input.data),
  });
  if (run.status !== "queued" && run.status !== "running" && run.status !== "succeeded") {
    await requireManualOwnerAssignment(ideaId, run.errorCode ?? "owner_match_run_unavailable", { runId: run.id });
    return { status: "manual_assignment_required" as const, runId: run.id };
  }
  return { status: run.status === "queued" || run.status === "running" ? "queued" as const : run.status, runId: run.id };
}

export async function requireManualOwnerAssignment(ideaId: number, reasonCode: string, details: { confidence?: number; rationale?: string; runId?: number } = {}) {
  return db.transaction((tx) => requireManualAssignmentTx(tx, ideaId, reasonCode, new Date(), details));
}

/** Complete an AI match atomically with its run, status, event, audit, and notifications. */
export function completeOwnerMatchTx(tx: Tx, run: AiRun, resultJson: string, now = new Date()) {
  if (run.jobKey !== ideaOwnerMatchJob.key) return;
  let input: unknown;
  let output: unknown;
  try {
    input = run.inputJson ? JSON.parse(run.inputJson) : null;
    output = JSON.parse(resultJson);
  } catch {
    requireManualAssignmentTx(tx, run.ideaId, "owner_match_output_invalid", now, { runId: run.id });
    return;
  }

  const parsedInput = ideaOwnerMatchInputSchema.safeParse(input);
  const parsedOutput = parsedInput.success ? validateIdeaOwnerMatchOutput(parsedInput.data, output) : null;
  if (!parsedInput.success || !parsedOutput?.success || parsedOutput.data.candidateOwnerId === null) {
    requireManualAssignmentTx(tx, run.ideaId, "owner_match_no_supported_candidate", now, {
      runId: run.id,
      ...(parsedOutput?.success ? { confidence: parsedOutput.data.confidence, rationale: parsedOutput.data.rationale } : {}),
    });
    return;
  }

  const recommendation = parsedOutput.data;
  if (recommendation.confidence < getAiConfig().ownerMatchMinimumConfidence) {
    requireManualAssignmentTx(tx, run.ideaId, "owner_match_confidence_below_threshold", now, { runId: run.id, confidence: recommendation.confidence, rationale: recommendation.rationale });
    return;
  }
  const idea = tx.select().from(ideas).where(eq(ideas.id, run.ideaId)).limit(1).get();
  if (!idea || idea.status !== "owner_matching" || idea.assignedUserId !== null) return;
  const candidateWasSupplied = parsedInput.data.candidates.some((candidate) => candidate.candidateOwnerId === recommendation.candidateOwnerId);
  const candidate = candidateWasSupplied ? tx.select({ id: users.id, role: users.role, isActive: users.isActive }).from(users).where(eq(users.id, recommendation.candidateOwnerId!)).limit(1).get() : null;
  if (!candidate?.isActive || candidate.role !== "business_owner") {
    requireManualAssignmentTx(tx, run.ideaId, "recommended_owner_unavailable", now, { runId: run.id, confidence: recommendation.confidence, rationale: recommendation.rationale });
    return;
  }
  const slaValue = tx.select({ value: ideaSettings.value }).from(ideaSettings).where(eq(ideaSettings.key, "sla_days")).get()?.value;
  let dueDays = 4;
  try {
    const configured = (JSON.parse(slaValue ?? "{}") as Record<string, unknown>).business_review;
    if (typeof configured === "number" && Number.isInteger(configured) && configured >= 1 && configured <= 365) dueDays = configured;
  } catch { /* Use the same four-day default as governance queues when settings are absent or invalid. */ }
  const dueAt = new Date(now.getTime() + dueDays * 86_400_000);
  const update = tx.update(ideas).set({ status: "business_review", assignedUserId: candidate.id, dueAt, updatedAt: now })
    .where(and(eq(ideas.id, run.ideaId), eq(ideas.status, "owner_matching"), isNull(ideas.assignedUserId))).run();
  if (!update.changes) return;
  const metadata = { source: "ai", runId: run.id, businessOwnerId: candidate.id, confidence: recommendation.confidence, rationale: recommendation.rationale };
  tx.insert(ideaEvents).values({ ideaId: run.ideaId, ideaVersionId: run.ideaVersionId, actorType: "ai", actorId: null, eventType: "business_owner_assigned", fromStatus: "owner_matching", toStatus: "business_review", correlationId: run.correlationId, metadataJson: JSON.stringify(metadata), createdAt: now }).run();
  tx.insert(auditEvents).values(buildAuditRecord({ action: "ideas.owner_match.assigned", targetType: "idea", targetId: run.ideaId, reason: "AI recommended a business owner based on the supplied business profiles.", metadata: { runId: run.id, businessOwnerId: candidate.id, confidence: recommendation.confidence }, }, now)).run();
  tx.insert(notifications).values({ userId: candidate.id, type: "idea_routed", title: "Idea assigned for delivery", body: `${idea.reference} is ready for your review.`, link: `/ideas/${idea.id}`, createdAt: now, updatedAt: now }).run();
  tx.insert(notifications).values({ userId: idea.authorId, type: "idea_routed", title: "A business owner was assigned", body: `${idea.reference} has been assigned to a business owner for review.`, link: `/ideas/${idea.id}`, createdAt: now, updatedAt: now }).run();
}

export function failOwnerMatchTx(tx: Tx, run: AiRun, reasonCode: string, now = new Date()) {
  if (run.jobKey !== ideaOwnerMatchJob.key) return;
  requireManualAssignmentTx(tx, run.ideaId, reasonCode, now, { runId: run.id });
}
