import { and, eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { ideas, notifications, users } from "../../db/schema";
import { getAiJob } from "../ai/registry";
import { getAiConfig } from "../ai/config-core";
import "../ai/jobs";
import { appendIdeaEvent, createAiRun, getAuthorizedIdeaSnapshot } from "./repository";
const transitions = {
    screening: ["returned", "business_review", "control_review", "poc"],
    returned: ["screening", "business_review"],
    business_review: ["returned", "control_review", "decision"],
    control_review: ["returned", "decision"],
    decision: ["poc", "rejected", "deferred"],
    poc: ["implementation", "decision", "deferred"],
    implementation: ["implemented", "decision"],
    implemented: [],
    rejected: [],
    deferred: ["screening", "decision"],
};
export function canTransitionIdeaStatus(actor, from, to) {
    if (["ai", "employee"].includes(actor.kind))
        return false;
    if (!transitions[from]?.includes(to))
        return false;
    if (actor.kind === "system")
        return from === "screening" && ["returned", "business_review", "control_review"].includes(to);
    if (actor.kind === "back_office")
        return ["screening", "control_review", "decision", "poc", "implementation", "deferred"].includes(from);
    if (actor.kind === "business_owner")
        return from === "business_review" && ["returned", "control_review", "decision"].includes(to);
    return false;
}
export async function transitionIdeaStatus(actor, ideaId, to, reason) {
    if (!reason.trim())
        throw new Error("A reason is required for every workflow transition");
    const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).all();
    if (!idea)
        throw new Error("Idea not found");
    const from = idea.status;
    const [user] = actor.id ? await db.select({ role: users.role }).from(users).where(eq(users.id, Number(actor.id))).limit(1).all() : [];
    const effectiveActor = actor.kind === "system" || actor.kind === "ai" ? actor : { ...actor, kind: user?.role ?? "employee" };
    if (!canTransitionIdeaStatus(effectiveActor, from, to))
        throw new Error("Actor is not authorized for this workflow transition");
    if (effectiveActor.kind === "business_owner") {
        const [assigned] = await db.select({ assignedUserId: ideas.assignedUserId }).from(ideas).where(eq(ideas.id, ideaId)).limit(1).all();
        if (assigned?.assignedUserId !== Number(actor.id))
            throw new Error("Idea is not assigned to this governance workspace member");
    }
    const now = new Date();
    const [updated] = await db.update(ideas).set({ status: to, updatedAt: now }).where(and(eq(ideas.id, ideaId), eq(ideas.status, from))).returning().all();
    if (!updated)
        throw new Error("Idea status changed before this transition could be applied");
    await appendIdeaEvent({
        ideaId,
        actorType: actor.kind === "employee" ? "user" : actor.kind === "system" || actor.kind === "ai" ? actor.kind : "admin",
        actorId: actor.id ? Number(actor.id) : null,
        eventType: "status_changed",
        fromStatus: from,
        toStatus: to,
        metadataJson: JSON.stringify({ reason }),
    });
    const accepted = to === "poc";
    const stageLabels = { screening: "Submitted", returned: "Returned for improvement", business_review: "Business review", control_review: "Control review", decision: "Transformation confirmation", poc: "Proof of concept", implementation: "Implementation", implemented: "Impact", rejected: "Rejected", deferred: "Deferred" };
    await db.insert(notifications).values({
        userId: updated.authorId,
        type: accepted ? "idea_accepted" : "idea_status_changed",
        title: accepted ? "Idea accepted for proof of concept" : "Idea workflow updated",
        body: accepted ? `Congratulations, ${updated.reference} has been accepted (${to}).` : `${updated.reference} moved to ${stageLabels[to]} (${to.replaceAll("_", " ")}).`,
        link: `/ideas/${ideaId}`,
    }).onConflictDoNothing().run();
    return updated;
}
export async function runIdeaScreeningWorkflow(ideaId, versionId, actor, idempotencyKey) {
    const snapshot = await getAuthorizedIdeaSnapshot(actor, ideaId);
    const version = snapshot?.versions.find((candidate) => candidate.id === versionId);
    if (!snapshot || !version)
        throw new Error("Idea version not found or not authorized");
    const job = getAiJob("idea.preflight", "1");
    const run = await createAiRun({
        ideaId,
        ideaVersionId: version.id,
        jobKey: job.key,
        jobVersion: job.version,
        promptVersion: job.version,
        model: job.model ?? getAiConfig().model,
        idempotencyKey: idempotencyKey ?? `idea:${ideaId}:version:${version.id}:idea.preflight:v1`,
        correlationId: `idea:${ideaId}:version:${version.id}`,
        requestedBy: actor.id ? Number(actor.id) : null,
        inputHash: version.contentHash,
    });
    await appendIdeaEvent({ ideaId, ideaVersionId: version.id, actorType: actor.kind === "system" || actor.kind === "ai" ? actor.kind : actor.kind === "admin" ? "admin" : "user", actorId: actor.id ? Number(actor.id) : null, eventType: "screening_queued", correlationId: run.correlationId, metadataJson: JSON.stringify({ runId: run.id }) });
}
