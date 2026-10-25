import { AiProviderError } from "./errors";
import { getAiJob } from "./registry";
import "./jobs";
import { executeClaimedAiRun } from "./runner";
import { evaluateAiInput } from "./policy";
import { IdeaAnalysisInputSchema } from "../ideas/schemas";
import { appendIdeaEvent, claimNextAiRun, failAiRun, getAuthorizedIdeaSnapshot, recoverStaleAiRuns, requeueAiRun, withAiRunLease } from "../ideas/repository";
import type { AiProvider } from "./provider";

export type WorkerDependencies = {
  provider?: AiProvider;
  maxAttempts?: number;
  staleAfterMs?: number;
};

const activeRunIds = new Set<number>();

export type WorkerOutcome =
  | { status: "idle" }
  | { status: "succeeded"; runId: number }
  | { status: "retry_scheduled"; runId: number }
  | { status: "failed"; runId: number };

function inputFromVersion(version: { kind: "idea" | "problem"; title: string; summary: string; problem: string | null; solution: string | null; benefits: string | null; risks: string | null; category: string; dataClassification: "public" | "internal" | "confidential" | "restricted" }) {
  return IdeaAnalysisInputSchema.parse({
    kind: version.kind,
    title: version.title,
    summary: version.summary,
    problem: version.problem ?? undefined,
    solution: version.solution ?? undefined,
    benefits: version.benefits ?? undefined,
    risks: version.risks ?? undefined,
    category: version.category,
    dataClassification: version.dataClassification,
    evidence: [],
    relatedIdeas: [],
  });
}

export async function processNextAiRun(workerId: string, dependencies: WorkerDependencies = {}): Promise<WorkerOutcome> {
  const maxAttempts = dependencies.maxAttempts ?? 3;
  const configuredStaleAfter = Number(process.env.AI_WORKER_STALE_AFTER_MS);
  const staleAfterMs = dependencies.staleAfterMs ?? (Number.isSafeInteger(configuredStaleAfter) && configuredStaleAfter >= 30_000 ? configuredStaleAfter : 120_000);
  await recoverStaleAiRuns(new Date(), staleAfterMs, maxAttempts, Array.from(activeRunIds));
  const claimed = await claimNextAiRun(workerId, new Date());
  if (!claimed) return { status: "idle" };
  activeRunIds.add(claimed.id);
  try {
    return await withAiRunLease(claimed, () => processClaimedAiRun(workerId, claimed, dependencies, maxAttempts));
  } finally {
    activeRunIds.delete(claimed.id);
  }
}

async function processClaimedAiRun(workerId: string, claimed: NonNullable<Awaited<ReturnType<typeof claimNextAiRun>>>, dependencies: WorkerDependencies, maxAttempts: number): Promise<WorkerOutcome> {
  if (!dependencies.provider) {
    await failAiRun(claimed.id, { errorCode: "worker_provider_missing", errorMessage: "AI worker provider is not configured" });
    return { status: "failed", runId: claimed.id };
  }

  const snapshot = await getAuthorizedIdeaSnapshot({ kind: "admin", id: "system" }, claimed.ideaId);
  const version = snapshot?.versions.find((candidate) => candidate.id === claimed.ideaVersionId);
  let job;
  try {
    job = getAiJob(claimed.jobKey, claimed.jobVersion);
  } catch {
    await failAiRun(claimed.id, { errorCode: "unknown_job", errorMessage: "The persisted AI job is not registered" });
    return { status: "failed", runId: claimed.id };
  }
  if (!version) {
    await failAiRun(claimed.id, { errorCode: "idea_version_missing", errorMessage: "Idea version required by AI run was not found" });
    return { status: "failed", runId: claimed.id };
  }
  try {
    const input = inputFromVersion(version);
    const safeInput = evaluateAiInput(input, job.safety);
    if (!safeInput.allowed) {
      await failAiRun(claimed.id, { errorCode: safeInput.code, errorMessage: safeInput.reason });
      return { status: "failed", runId: claimed.id };
    }
    await executeClaimedAiRun(claimed, {
      jobKey: claimed.jobKey,
      ideaId: claimed.ideaId,
      ideaVersionId: claimed.ideaVersionId ?? undefined,
      input,
      actor: { kind: "system", id: workerId },
      correlationId: claimed.correlationId,
      idempotencyKey: claimed.idempotencyKey,
    }, job as never, safeInput, {
      provider: dependencies.provider,
      workerId,
    });
    return { status: "succeeded", runId: claimed.id };
  } catch (error) {
    const retryable = error instanceof AiProviderError && (error.category === "transient" || error.category === "rate_limited");
    if (retryable && claimed.attemptCount < maxAttempts) {
      await requeueAiRun(claimed.id, { errorCode: "provider_retry", errorMessage: "Transient AI provider failure" }, new Date(Date.now() + 250 * (2 ** (claimed.attemptCount - 1))));
      await appendIdeaEvent({ ideaId: claimed.ideaId, ideaVersionId: claimed.ideaVersionId, actorType: "system", actorId: null, eventType: "ai_retry_scheduled", correlationId: claimed.correlationId, metadataJson: JSON.stringify({ runId: claimed.id, attempt: claimed.attemptCount }) });
      return { status: "retry_scheduled", runId: claimed.id };
    }
    return { status: "failed", runId: claimed.id };
  }
}
