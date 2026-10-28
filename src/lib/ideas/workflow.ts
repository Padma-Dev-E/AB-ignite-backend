import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { aiRuns, ideaEvents, ideaVersions, ideas, notifications, users } from "../../db/schema";
import { getAiJob } from "../ai/registry";
import { getAiConfig } from "../ai/config-core";
import "../ai/jobs";
import type { AiActor } from "../ai/types";
import type { UserRole } from "../auth/permissions";
import { appendIdeaEvent, createAiRun, getAuthorizedIdeaSnapshot } from "./repository";

export type IdeaStatus = "screening" | "returned" | "owner_matching" | "owner_assignment" | "business_review" | "control_review" | "decision" | "poc" | "implementation" | "implemented" | "rejected" | "deferred";

const transitions: Record<IdeaStatus, IdeaStatus[]> = {
  screening: ["returned", "owner_matching"],
  returned: ["screening"],
  owner_matching: ["owner_assignment", "business_review"],
  owner_assignment: ["business_review"],
  business_review: ["returned", "decision"],
  control_review: ["returned", "decision"],
  decision: ["poc", "rejected", "deferred"],
  poc: ["implementation", "decision", "deferred"],
  implementation: ["implemented", "decision"],
  implemented: [],
  rejected: [],
  deferred: ["screening", "decision"],
};

export type IdeaWorkflowActor = { kind: "system" | "ai" | UserRole; id?: string };

export function canTransitionIdeaStatus(actor: IdeaWorkflowActor, from: IdeaStatus, to: IdeaStatus) {
  if (["ai", "employee"].includes(actor.kind)) return false;
  if (!transitions[from]?.includes(to)) return false;
  if (actor.kind === "system") return from === "screening" && ["returned", "owner_matching"].includes(to);
  if (actor.kind === "admin" || actor.kind === "maintainer") return from === "screening" && ["returned", "owner_matching"].includes(to);
  if (actor.kind === "business_owner") return ["business_review", "control_review", "decision", "poc", "implementation"].includes(from) && transitions[from].includes(to);
  return false;
}

export async function transitionIdeaStatus(actor: IdeaWorkflowActor, ideaId: number, to: IdeaStatus, reason: string) {
  if (!reason.trim()) throw new Error("A reason is required for every workflow transition");
  return db.transaction((tx) => {
    const idea = tx.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).get();
    if (!idea) throw new Error("Idea not found");
    const user = actor.id ? tx.select({ role: users.role }).from(users).where(eq(users.id, Number(actor.id))).limit(1).get() : undefined;
    const from = idea.status as IdeaStatus;
    const effectiveActor: IdeaWorkflowActor = actor.kind === "system" || actor.kind === "ai" ? actor : { ...actor, kind: user?.role ?? "employee" };
    if (!canTransitionIdeaStatus(effectiveActor, from, to)) throw new Error("Actor is not authorized for this workflow transition");
    if (effectiveActor.kind === "business_owner" && idea.assignedUserId !== Number(actor.id)) throw new Error("Idea is not assigned to this governance workspace member");
    const now = new Date();
    const updated = tx.update(ideas).set({ status: to, updatedAt: now }).where(and(eq(ideas.id, ideaId), eq(ideas.status, from))).returning().get();
    if (!updated) throw new Error("Idea status changed before this transition could be applied");
    tx.insert(ideaEvents).values({
      ideaId,
      actorType: effectiveActor.kind === "business_owner" || effectiveActor.kind === "maintainer" ? effectiveActor.kind : actor.kind === "system" || actor.kind === "ai" ? actor.kind : actor.kind === "employee" ? "user" : "admin",
      actorId: actor.id ? Number(actor.id) : null,
      eventType: "status_changed",
      fromStatus: from,
      toStatus: to,
      metadataJson: JSON.stringify({ reason }),
    }).run();
    const accepted = to === "poc";
    const stageLabels: Record<IdeaStatus, string> = { screening: "Submitted", returned: "Returned for improvement", owner_matching: "Business owner matching", owner_assignment: "Business owner assignment", business_review: "Business review", control_review: "Control review", decision: "Transformation confirmation", poc: "Proof of concept", implementation: "Implementation", implemented: "Impact", rejected: "Rejected", deferred: "Deferred" };
    tx.insert(notifications).values({
      userId: updated.authorId,
      type: accepted ? "idea_accepted" : "idea_status_changed",
      title: accepted ? "Idea accepted for proof of concept" : "Idea workflow updated",
      body: accepted ? `Congratulations, ${updated.reference} has been accepted (${to}).` : `${updated.reference} moved to ${stageLabels[to]} (${to.replaceAll("_", " ")}).`,
      link: `/ideas/${ideaId}`,
    }).onConflictDoNothing().run();
    return updated;
  });
}

export async function runIdeaScreeningWorkflow(ideaId: number, versionId: number, actor: AiActor, idempotencyKey?: string): Promise<void> {
  const snapshot = await getAuthorizedIdeaSnapshot(actor, ideaId);
  const version = snapshot?.versions.find((candidate) => candidate.id === versionId);
  if (!snapshot || !version) throw new Error("Idea version not found or not authorized");
  const job = getAiJob("idea.preflight", "1");
  const run = await createAiRun({
    ideaId,
    ideaVersionId: version.id,
    jobKey: job.key,
    jobVersion: job.version,
    model: job.model ?? getAiConfig().model,
    idempotencyKey: idempotencyKey ?? `idea:${ideaId}:version:${version.id}:idea.preflight:v1`,
    correlationId: `idea:${ideaId}:version:${version.id}`,
    requestedBy: actor.id ? Number(actor.id) : null,
    inputHash: version.contentHash,
  });
  await appendIdeaEvent({ ideaId, ideaVersionId: version.id, actorType: actor.kind === "system" || actor.kind === "ai" ? actor.kind : actor.kind === "admin" ? "admin" : "user", actorId: actor.id ? Number(actor.id) : null, eventType: "screening_queued", correlationId: run.correlationId, metadataJson: JSON.stringify({ runId: run.id }) });
}
