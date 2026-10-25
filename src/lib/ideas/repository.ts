import { and, asc, desc, eq, inArray, like, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import { db } from "../../db/connection";
import {
  aiRuns,
  aiRunEvents,
  ideaAiResults,
  ideaEvents,
  ideaReviews,
  ideaComments,
  ideaSupports,
  ideaSubmissions,
  ideaSettings,
  ideaReferenceSequences,
  notifications,
  auditEvents,
  ideaVersions,
  ideas,
  users,
  type AiRun,
  type AiRunEvent,
  type Idea,
  type IdeaEvent,
  type IdeaReview,
  type IdeaVersion,
  type NewAiRun,
  type NewIdeaVersion,
} from "../../db/schema";
import type { AiActor } from "../ai/types";
import type { IdeaListQuery, IdeaUpdate } from "./schemas";
import { awardPoints } from "../rewards/service";
import { appendAuditEvent } from "../audit/service";
import { defaultPriorityPolicy, resolvePriorityPolicy, scorePriority, type PriorityMetrics } from "./priority-policy";
import { IDEA_VALIDATION_PASS_SCORE, ideaValidationPasses, normalizeIdeaValidationScore } from "./validation-score";

export type CreateIdeaVersionInput = NewIdeaVersion;

export type CreateAiRunInput = NewAiRun;

export const AiRunEventTypeSchema = z.enum(["queued", "running", "succeeded", "failed", "retry"]);
export type AiRunEventType = z.infer<typeof AiRunEventTypeSchema>;

const safeAiRunEventPayloadSchema = z.strictObject({
  attempt: z.number().int().min(0).max(100),
  errorCode: z.enum([
    "provider_error",
    "provider_retry",
    "provider_output_error",
    "schema_validation_error",
    "timeout",
    "unknown",
    "input_too_large",
    "restricted_data",
    "sensitive_data",
    "prompt_injection",
    "invalid_input",
    "worker_provider_missing",
    "unknown_job",
    "idea_version_missing",
  ]).optional(),
  retryAt: z.string().datetime().optional(),
});

export type SafeAiRunEventPayload = z.infer<typeof safeAiRunEventPayloadSchema>;

export type PublicAiRunEvent = Pick<AiRunEvent, "id" | "runId" | "ideaId" | "ideaVersionId" | "eventType" | "createdAt"> & {
  eventType: AiRunEventType;
  payload: SafeAiRunEventPayload;
};

type InsertExecutor = Pick<typeof db, "insert">;

export type AiRunResultInput = {
  resultJson: string;
  usageJson?: string;
  finishReason?: string;
};

export type AiRunFailureInput = {
  status?: "failed" | "timed_out";
  errorCode: string;
  errorMessage: string;
};

type AiRunLease = Pick<AiRun, "id" | "attemptCount" | "workerId" | "startedAt">;
const aiRunLease = new AsyncLocalStorage<AiRunLease>();

export function withAiRunLease<T>(run: AiRun, action: () => Promise<T>): Promise<T> {
  if (run.status !== "running" || !run.workerId || !run.startedAt) throw new Error("AI run lease is not active");
  return aiRunLease.run({ id: run.id, attemptCount: run.attemptCount, workerId: run.workerId, startedAt: run.startedAt }, action);
}

function assertAiRunLease(run: AiRun) {
  const lease = aiRunLease.getStore();
  if (!lease) return;
  if (run.id !== lease.id || run.attemptCount !== lease.attemptCount || run.workerId !== lease.workerId || run.startedAt?.getTime() !== lease.startedAt?.getTime()) {
    throw new Error("AI run lease ownership lost");
  }
}

export type CreateIdeaEventInput = typeof ideaEvents.$inferInsert;
export type CreateIdeaReviewInput = typeof ideaReviews.$inferInsert;

export type IdeaActor = { kind: "user" | "admin"; id: string };

export class IdeaPriorityMinimumError extends Error {
  readonly code = "submission_rejected";
  constructor(
    readonly score: number,
    readonly minimumScore: number,
    readonly priorityBand: "Watch" | "Quality" | "Priority",
    readonly breakdown: ReturnType<typeof scorePriority>["breakdown"],
  ) {
    super(`Priority score ${score.toFixed(2)} is below the minimum ${minimumScore.toFixed(2)}`);
    this.name = "IdeaPriorityMinimumError";
  }
}

export type IdeaPage = {
  items: Array<Idea & { author: Pick<typeof users.$inferSelect, "id" | "name" | "department"> | null; supported: boolean }>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type CommentPage = {
  items: Array<typeof ideaComments.$inferSelect & { author: Pick<typeof users.$inferSelect, "id" | "name" | "department"> | null }>;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export type AuthorizedIdeaSnapshot = {
  idea: Idea;
  versions: IdeaVersion[];
  runs: AiRun[];
  aiRunEvents: PublicAiRunEvent[];
  events: IdeaEvent[];
  reviews: IdeaReview[];
};

function parseSafeAiRunEvent(row: AiRunEvent): PublicAiRunEvent | null {
  const eventType = AiRunEventTypeSchema.safeParse(row.eventType);
  if (!eventType.success) return null;
  try {
    const payload = safeAiRunEventPayloadSchema.safeParse(JSON.parse(row.payloadJson));
    if (!payload.success) return null;
    return {
      id: row.id,
      runId: row.runId,
      ideaId: row.ideaId,
      ideaVersionId: row.ideaVersionId,
      eventType: eventType.data,
      payload: payload.data,
      createdAt: row.createdAt,
    };
  } catch {
    return null;
  }
}

function validateAiRunEvent(eventType: AiRunEventType, payload: unknown): SafeAiRunEventPayload {
  const parsedEventType = AiRunEventTypeSchema.safeParse(eventType);
  if (!parsedEventType.success) throw new Error("Invalid AI run event type");
  const parsed = safeAiRunEventPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new Error("Invalid or unsafe AI run event payload");
  const { attempt, errorCode, retryAt } = parsed.data;
  if (parsedEventType.data === "queued" && attempt !== 0) throw new Error("Queued AI run events must start at attempt zero");
  if (parsedEventType.data === "running" && attempt < 1) throw new Error("Running AI run events require an attempt number");
  if (parsedEventType.data === "succeeded" && errorCode) throw new Error("Succeeded AI run events cannot contain an error code");
  if ((parsedEventType.data === "failed" || parsedEventType.data === "retry") && !errorCode) throw new Error("Failed AI run events require a safe error code");
  if (parsedEventType.data === "retry" && !retryAt) throw new Error("Retry AI run events require a retry time");
  const serialized = JSON.stringify(parsed.data);
  if (Buffer.byteLength(serialized, "utf8") > 512) throw new Error("AI run event payload is too large");
  return parsed.data;
}

function appendAiRunEventRecord(executor: InsertExecutor, run: Pick<AiRun, "id" | "ideaId" | "ideaVersionId">, eventType: AiRunEventType, payload: unknown, createdAt = new Date()) {
  const safePayload = validateAiRunEvent(eventType, payload);
  executor.insert(aiRunEvents).values({
    runId: run.id,
    ideaId: run.ideaId,
    ideaVersionId: run.ideaVersionId,
    eventType,
    payloadJson: JSON.stringify(safePayload),
    createdAt,
  }).run();
}

export async function appendAiRunEvent(run: Pick<AiRun, "id" | "ideaId" | "ideaVersionId">, eventType: AiRunEventType, payload: unknown): Promise<void> {
  appendAiRunEventRecord(db, run, eventType, payload);
}

export async function getAiRunEvents(ideaId: number, runId?: number): Promise<PublicAiRunEvent[]> {
  const where = runId === undefined
    ? eq(aiRunEvents.ideaId, ideaId)
    : and(eq(aiRunEvents.ideaId, ideaId), eq(aiRunEvents.runId, runId));
  const rows = await db.select().from(aiRunEvents).where(where).orderBy(asc(aiRunEvents.id)).all();
  return rows.flatMap((row) => {
    const event = parseSafeAiRunEvent(row);
    return event ? [event] : [];
  });
}

export async function createIdeaVersion(input: CreateIdeaVersionInput): Promise<IdeaVersion> {
  const [version] = await db.insert(ideaVersions).values(input).returning().all();
  if (!version) throw new Error("Idea version was not created");
  return version;
}

export async function createAiRun(input: CreateAiRunInput): Promise<AiRun> {
  const [existing] = await db.select().from(aiRuns).where(eq(aiRuns.idempotencyKey, input.idempotencyKey)).limit(1).all();
  if (existing) return existing;

  try {
    return await db.transaction((tx) => {
      const [created] = tx.insert(aiRuns).values(input).returning().all();
      if (!created) throw new Error("AI run was not created");
      appendAiRunEventRecord(tx, created, "queued", { attempt: 0 }, created.createdAt);
      return created;
    });
  } catch (error) {
    const [raced] = await db.select().from(aiRuns).where(eq(aiRuns.idempotencyKey, input.idempotencyKey)).limit(1).all();
    if (raced) return raced;
    throw error;
  }
}

export async function getIdeaVersionPreflight(ideaId: number, ideaVersionId: number) {
  const [run] = await db.select().from(aiRuns).where(and(
    eq(aiRuns.ideaId, ideaId),
    eq(aiRuns.ideaVersionId, ideaVersionId),
    eq(aiRuns.jobKey, "idea.preflight"),
  )).orderBy(desc(aiRuns.createdAt)).limit(1).all();
  return run ?? null;
}

export async function claimNextAiRun(workerId: string, now = new Date()): Promise<AiRun | null> {
  const result = await db.transaction((tx) => {
    const [candidate] = tx.select().from(aiRuns).where(and(
      eq(aiRuns.status, "queued"),
      lte(aiRuns.availableAt, now),
    )).orderBy(asc(aiRuns.createdAt)).limit(1).all();
    if (!candidate) return null;

    const updated = tx.update(aiRuns).set({
      status: "running",
      workerId,
      attemptCount: candidate.attemptCount + 1,
      startedAt: now,
      updatedAt: now,
    }).where(and(eq(aiRuns.id, candidate.id), eq(aiRuns.status, "queued"))).returning().all();
    const claimed = updated[0] ?? null;
    if (claimed) appendAiRunEventRecord(tx, claimed, "running", { attempt: claimed.attemptCount }, now);
    return claimed;
  });
  return result;
}

// Reclaim only leases well beyond the provider request timeout. A current worker
// excludes its in-flight runs; ownership checks fence late results from other workers.
export async function recoverStaleAiRuns(now = new Date(), staleAfterMs = 120_000, maxAttempts = 3, excludeRunIds: number[] = []): Promise<number> {
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 30_000 || staleAfterMs > 86_400_000) throw new Error("Invalid AI run stale timeout");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Invalid AI run attempt limit");
  const cutoff = new Date(now.getTime() - staleAfterMs);
  return db.transaction((tx) => {
    const condition = and(
      eq(aiRuns.status, "running"),
      lte(aiRuns.startedAt, cutoff),
      ...(excludeRunIds.length ? [notInArray(aiRuns.id, excludeRunIds)] : []),
    );
    const stale = tx.select().from(aiRuns).where(condition).orderBy(asc(aiRuns.startedAt), asc(aiRuns.id)).limit(25).all();
    let recovered = 0;
    for (const run of stale) {
      const exhausted = run.attemptCount >= maxAttempts;
      const [updated] = tx.update(aiRuns).set(exhausted ? {
        status: "timed_out",
        errorCode: "timeout",
        errorMessage: "AI worker lease expired after maximum attempts",
        completedAt: now,
        updatedAt: now,
      } : {
        status: "queued",
        workerId: null,
        startedAt: null,
        availableAt: now,
        errorCode: "timeout",
        errorMessage: "AI worker lease expired; retry scheduled",
        updatedAt: now,
      }).where(and(eq(aiRuns.id, run.id), eq(aiRuns.status, "running"), eq(aiRuns.attemptCount, run.attemptCount), lte(aiRuns.startedAt, cutoff))).returning().all();
      if (!updated) continue;
      appendAiRunEventRecord(tx, run, exhausted ? "failed" : "retry", exhausted
        ? { attempt: run.attemptCount, errorCode: "timeout" }
        : { attempt: run.attemptCount, errorCode: "timeout", retryAt: now.toISOString() }, now);
      recovered++;
    }
    return recovered;
  });
}

export async function claimAiRun(runId: number, workerId: string, now = new Date()): Promise<AiRun | null> {
  return db.transaction((tx) => {
    const [current] = tx.select().from(aiRuns).where(and(eq(aiRuns.id, runId), eq(aiRuns.status, "queued"))).limit(1).all();
    if (!current) return null;
    const [claimed] = tx.update(aiRuns).set({
      status: "running",
      workerId,
      attemptCount: current.attemptCount + 1,
      startedAt: now,
      updatedAt: now,
    }).where(and(eq(aiRuns.id, runId), eq(aiRuns.status, "queued"))).returning().all();
    if (!claimed) return null;
    appendAiRunEventRecord(tx, claimed, "running", { attempt: claimed.attemptCount }, now);
    return claimed;
  });
}

export async function completeAiRun(runId: number, result: AiRunResultInput): Promise<void> {
  await db.transaction((tx) => {
    const [run] = tx.select().from(aiRuns).where(eq(aiRuns.id, runId)).limit(1).all();
    if (!run) return;
    assertAiRunLease(run);
    if (run.status === "succeeded") return;
    if (run.status !== "running") throw new Error("AI run is not running");
    const now = new Date();
    tx.update(aiRuns).set({
      status: "succeeded",
      resultJson: result.resultJson,
      usageJson: result.usageJson,
      finishReason: result.finishReason,
      completedAt: now,
      updatedAt: now,
    }).where(eq(aiRuns.id, runId)).run();
    tx.insert(ideaAiResults).values({
      ideaId: run.ideaId,
      ideaVersionId: run.ideaVersionId,
      runId: run.id,
      jobKey: run.jobKey,
      jobVersion: run.jobVersion,
      resultJson: result.resultJson,
    }).run();
    appendAiRunEventRecord(tx, run, "succeeded", { attempt: run.attemptCount }, now);
  });
}

export async function failAiRun(runId: number, failure: AiRunFailureInput): Promise<void> {
  const now = new Date();
  await db.transaction((tx) => {
    const [run] = tx.select().from(aiRuns).where(eq(aiRuns.id, runId)).limit(1).all();
    if (!run) return;
    assertAiRunLease(run);
    if (run.status !== "queued" && run.status !== "running") return;
    tx.update(aiRuns).set({
      status: failure.status ?? "failed",
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      completedAt: now,
      updatedAt: now,
    }).where(eq(aiRuns.id, runId)).run();
    appendAiRunEventRecord(tx, run, "failed", { attempt: run.attemptCount, errorCode: failure.errorCode }, now);
  });
}

export async function requeueAiRun(runId: number, failure: AiRunFailureInput, availableAt = new Date()): Promise<void> {
  const now = new Date();
  await db.transaction((tx) => {
    const [run] = tx.select().from(aiRuns).where(eq(aiRuns.id, runId)).limit(1).all();
    if (!run) return;
    assertAiRunLease(run);
    if (run.status !== "running" && run.status !== "failed" && run.status !== "timed_out") return;
    tx.update(aiRuns).set({
      status: "queued",
      errorCode: failure.errorCode,
      errorMessage: failure.errorMessage,
      availableAt,
      updatedAt: now,
    }).where(eq(aiRuns.id, runId)).run();
    appendAiRunEventRecord(tx, run, "retry", { attempt: run.attemptCount, errorCode: failure.errorCode, retryAt: availableAt.toISOString() }, now);
  });
}

export async function appendIdeaEvent(input: CreateIdeaEventInput): Promise<IdeaEvent> {
  const [event] = await db.insert(ideaEvents).values(input).returning().all();
  if (!event) throw new Error("Idea event was not created");
  return event;
}

export async function recordHumanReview(input: CreateIdeaReviewInput): Promise<IdeaReview> {
  const [review] = await db.insert(ideaReviews).values(input).returning().all();
  if (!review) throw new Error("Idea review was not created");
  return review;
}

type IdeaSnapshotActor = AiActor | {
  kind: "employee" | "back_office" | "business_owner";
  id: string;
};

export async function getAuthorizedIdeaSnapshot(actor: IdeaSnapshotActor, ideaId: number): Promise<AuthorizedIdeaSnapshot | null> {
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).all();
  if (!idea) return null;
  // Auth sessions carry the account role, while older AI workflow callers use
  // the generic "user" / "admin" actor kinds. Treat regular account roles as
  // user actors here and keep the owner check in force. Back-office and the
  // legacy admin actor retain their operational access.
  const canViewAnyIdea = actor.kind === "admin" || actor.kind === "back_office";
  const isUserActor = actor.kind === "user" || actor.kind === "employee" || actor.kind === "business_owner";
  if (!canViewAnyIdea && !isUserActor) return null;
  if (!canViewAnyIdea && Number(actor.id) !== idea.authorId) return null;

  const [versions, runs, aiRunEvents, events, reviews] = await Promise.all([
    db.select().from(ideaVersions).where(eq(ideaVersions.ideaId, ideaId)).all(),
    db.select().from(aiRuns).where(eq(aiRuns.ideaId, ideaId)).orderBy(asc(aiRuns.createdAt), asc(aiRuns.id)).all(),
    getAiRunEvents(ideaId),
    db.select().from(ideaEvents).where(eq(ideaEvents.ideaId, ideaId)).all(),
    db.select().from(ideaReviews).where(eq(ideaReviews.ideaId, ideaId)).all(),
  ]);
  return { idea, versions, runs, aiRunEvents, events, reviews };
}

function actorUserId(actor: IdeaActor): number {
  const userId = Number(actor.id);
  if (!Number.isInteger(userId) || userId < 1) throw new Error("Invalid actor");
  return userId;
}

function pageBounds(page: number, pageSize: number) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export async function listIdeas(actor: IdeaActor, query: Pick<IdeaListQuery, "page" | "pageSize"> & Partial<Omit<IdeaListQuery, "page" | "pageSize">>): Promise<IdeaPage> {
  const userId = actorUserId(actor);
  const filters = [];
  if (query.mine ?? false) filters.push(eq(ideas.authorId, userId));
  else filters.push(ne(ideas.status, "draft"));
  if (query.status) filters.push(eq(ideas.status, query.status));
  if (query.category) filters.push(eq(ideas.category, query.category));
  if (query.search) {
    const search = `%${query.search}%`;
    filters.push(or(like(ideas.title, search), like(ideas.summary, search), like(ideas.reference, search)));
  }
  const where = filters.length ? and(...filters) : undefined;
  const { limit, offset } = pageBounds(query.page, query.pageSize);
  const [rows, totalRow] = await Promise.all([
    db.select({ idea: ideas, author: { id: users.id, name: users.name, department: users.department },
      supported: sql<number>`exists (select 1 from ${ideaSupports} where ${ideaSupports.ideaId} = ${ideas.id} and ${ideaSupports.userId} = ${userId})`,
    }).from(ideas).leftJoin(users, eq(users.id, ideas.authorId)).where(where)
      .orderBy(desc(ideas.createdAt), desc(ideas.id)).limit(limit).offset(offset).all(),
    db.select({ count: sql<number>`count(*)` }).from(ideas).where(where).all(),
  ]);
  const total = Number(totalRow[0]?.count ?? 0);
  const items = rows.map(({ idea, author, supported }) => ({ ...idea, author, supported: Boolean(supported) }));
  return { items, page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
}

export async function getIdeaById(ideaId: number): Promise<(Idea & { author: Pick<typeof users.$inferSelect, "id" | "name" | "department"> | null }) | null> {
  if (!Number.isInteger(ideaId) || ideaId < 1) return null;
  const [row] = await db.select({ idea: ideas, author: { id: users.id, name: users.name, department: users.department } })
    .from(ideas).leftJoin(users, eq(users.id, ideas.authorId)).where(eq(ideas.id, ideaId)).limit(1).all();
  return row ? { ...row.idea, author: row.author } : null;
}

export async function getIdeaSubmissionDetails(ideaId: number) {
  const [row] = await db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, ideaId)).limit(1).all();
  if (!row) return null;
  return { answers: JSON.parse(row.answersJson) as Record<string, string>, metrics: JSON.parse(row.metricsJson) as Record<string, string | number>, score: row.score, minimumScore: row.minimumScore, validationPassed: row.validationPassed, aiValidationScore: row.aiValidationScore, aiValidationAttempts: row.aiValidationAttempts, submittedWithLowAiScore: row.submittedWithLowAiScore, differentiation: row.differentiation };
}

export async function updateReturnedIdea(actor: IdeaActor, ideaId: number, input: IdeaUpdate) {
  const userId = actorUserId(actor);
  return db.transaction((tx) => {
    const ownership = actor.kind === "admin"
      ? eq(ideas.id, ideaId)
      : and(eq(ideas.id, ideaId), eq(ideas.authorId, userId));
    const [current] = tx.select().from(ideas).where(ownership).limit(1).all();
    if (!current) throw new Error("Idea not found or not authorized");
    if (current.status !== "returned") throw new Error("Only returned ideas can be edited");

    const [latestVersion] = tx.select().from(ideaVersions).where(eq(ideaVersions.ideaId, ideaId)).orderBy(desc(ideaVersions.version)).limit(1).all();
    const version = (latestVersion?.version ?? 0) + 1;
    const next = {
      kind: input.kind ?? current.kind,
      title: input.title ?? current.title,
      summary: input.summary ?? current.summary,
      problem: input.problem === undefined ? current.problem : input.problem,
      solution: input.solution === undefined ? current.solution : input.solution,
      benefits: input.benefits === undefined ? current.benefits : input.benefits,
      risks: input.risks === undefined ? current.risks : input.risks,
      category: input.category ?? current.category,
      dataClassification: input.dataClassification ?? latestVersion?.dataClassification ?? "internal",
    } as const;
    const now = new Date();
    const contentHash = createContentHash(next);
    const [idea] = tx.update(ideas).set({ ...next, updatedAt: now }).where(eq(ideas.id, ideaId)).returning().all();
    const [createdVersion] = tx.insert(ideaVersions).values({ ...next, ideaId, authorId: current.authorId, version, contentHash, createdAt: now, updatedAt: now }).returning().all();
    if (!idea || !createdVersion) throw new Error("Idea update was not created");
    tx.insert(ideaEvents).values({ ideaId, ideaVersionId: createdVersion.id, actorType: actor.kind, actorId: userId, eventType: "returned_edited", correlationId: `idea:${ideaId}:version:${version}` }).run();
    return { idea, version: createdVersion };
  });
}

function createContentHash(input: unknown) {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function supportIdea(actor: IdeaActor, ideaId: number) {
  const userId = actorUserId(actor);
  const result = await db.transaction((tx) => {
    const [idea] = tx.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).all();
    if (!idea || idea.status === "draft") throw new Error("Idea not found");
    if (idea.authorId === userId) throw new Error("You cannot support your own idea");
    const [createdSupport] = tx.insert(ideaSupports).values({ ideaId, userId }).onConflictDoNothing({ target: [ideaSupports.ideaId, ideaSupports.userId] }).returning().all();
    const [{ count }] = tx.select({ count: sql<number>`count(*)` }).from(ideaSupports).where(eq(ideaSupports.ideaId, ideaId)).all();
    const supports = Number(count ?? 0);
    tx.update(ideas).set({ supports, updatedAt: new Date() }).where(eq(ideas.id, ideaId)).run();
    if (createdSupport) {
      tx.insert(notifications).values({ userId: idea.authorId, type: "idea_supported", title: "Your idea received support", body: `${idea.reference} received a new support.`, link: `/ideas/${ideaId}` }).run();
    }
    return { supported: true, supports };
  });
  const [idea] = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1).all();
  const [created] = await db.select().from(ideaSupports).where(and(eq(ideaSupports.ideaId, ideaId), eq(ideaSupports.userId, userId))).limit(1).all();
  if (idea && created) {
    await awardPoints({ userId: idea.authorId, amount: 2, eventType: "idea_support", sourceType: "idea_support", sourceId: `${ideaId}:${userId}`, idempotencyKey: `idea:${ideaId}:support-author:${userId}` });
  }
  return result;
}

export async function listIdeaComments(ideaId: number, query: { page: number; pageSize: number }): Promise<CommentPage> {
  const { limit, offset } = pageBounds(query.page, query.pageSize);
  const [rows, totalRow] = await Promise.all([
    db.select({ comment: ideaComments, author: { id: users.id, name: users.name, department: users.department } })
      .from(ideaComments).leftJoin(users, eq(users.id, ideaComments.authorId)).where(eq(ideaComments.ideaId, ideaId))
      .orderBy(asc(ideaComments.createdAt), asc(ideaComments.id)).limit(limit).offset(offset).all(),
    db.select({ count: sql<number>`count(*)` }).from(ideaComments).where(eq(ideaComments.ideaId, ideaId)).all(),
  ]);
  const total = Number(totalRow[0]?.count ?? 0);
  return { items: rows.map(({ comment, author }) => ({ ...comment, author })), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
}

export async function createIdeaComment(actor: IdeaActor, ideaId: number, body: string) {
  const userId = actorUserId(actor);
  const text = body.trim();
  if (!text || text.length > 2_000) throw new Error("Comment is invalid");
  const result = await db.transaction((tx) => {
    const [idea] = tx.select({ id: ideas.id, authorId: ideas.authorId, status: ideas.status }).from(ideas).where(eq(ideas.id, ideaId)).limit(1).all();
    if (!idea || idea.status === "draft") throw new Error("Idea not found");
    const [comment] = tx.insert(ideaComments).values({ ideaId, authorId: userId, body: text }).returning().all();
    if (!comment) throw new Error("Comment was not created");
    const [author] = tx.select({ id: users.id, name: users.name, department: users.department })
      .from(users).where(eq(users.id, userId)).limit(1).all();
    tx.update(ideas).set({ comments: sql`${ideas.comments} + 1`, updatedAt: new Date() }).where(eq(ideas.id, ideaId)).run();
    if (idea.authorId !== userId) tx.insert(notifications).values({ userId: idea.authorId, type: "idea_comment", title: "Your idea received a comment", body: "A colleague commented on your idea.", link: `/ideas/${ideaId}` }).run();
    return { comment: { ...comment, author: author ?? null }, ideaAuthorId: idea.authorId };
  });
  if (result.ideaAuthorId !== userId) {
    await awardPoints({ userId, amount: 5, eventType: "idea_comment", sourceType: "idea_comment", sourceId: String(result.comment.id), idempotencyKey: `idea:comment:${result.comment.id}:author:${userId}` });
  }
  return result.comment;
}

export async function getIdeaMinimumScore() {
  const [setting] = await db.select().from(ideaSettings).where(eq(ideaSettings.key, "minimum_priority_score")).limit(1).all();
  const configured = Number(setting?.value ?? 2);
  return Number.isFinite(configured) && configured >= 0 && configured <= 3 ? configured : 2;
}

export async function setIdeaMinimumScore(actor: IdeaActor, value: number) {
  const userId = actorUserId(actor);
  if (actor.kind !== "admin") throw new Error("Administrator access required");
  if (!Number.isFinite(value) || value < 0 || value > 3) throw new Error("Minimum priority score must be between 0 and 3");
  await db.insert(ideaSettings).values({ key: "minimum_priority_score", value: String(value), updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: ideaSettings.key, set: { value: String(value), updatedBy: userId, updatedAt: new Date() } }).run();
  await appendAuditEvent({ action: "ideas.minimum_score.updated", targetType: "idea_setting", targetId: "minimum_priority_score", metadata: { status: "updated", result: value } });
  return value;
}

export async function saveIdeaSubmission(actor: IdeaActor, ideaId: number, input: {
  answers: Record<string, string>;
  metrics: { turnaround: number; volume: number; value: number; turnaroundExplanation?: string; volumeExplanation?: string; valueExplanation?: string };
  differentiation?: string;
  buildsOnId?: number;
}) {
  const userId = actorUserId(actor);
  const [idea] = await db.select().from(ideas).where(and(eq(ideas.id, ideaId), eq(ideas.authorId, userId))).limit(1).all();
  if (!idea) throw new Error("Idea not found or not authorized");
  if (idea.status !== "draft" && idea.status !== "screening" && idea.status !== "returned") throw new Error("Submission details cannot be changed at this workflow stage");
  const [existing] = await db.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, ideaId)).limit(1).all();
  if (existing?.submittedAt) throw new Error("Submitted idea details are locked");
  const minimumScore = await getIdeaMinimumScore();
  const policyRows = db.select({ key: ideaSettings.key, value: ideaSettings.value }).from(ideaSettings)
    .where(inArray(ideaSettings.key, ["priority_kpis", "priority_bands"])).all();
  const policy = resolvePriorityPolicy(Object.fromEntries(policyRows.map(({ key, value }) => [key, value])));
  const { score } = scorePriority(input.metrics, policy);
  if (input.buildsOnId) {
    const [original] = await db.select().from(ideas).where(eq(ideas.id, input.buildsOnId)).limit(1).all();
    if (!original || original.authorId === userId || input.buildsOnId === ideaId) throw new Error("Selected original idea is invalid");
    await db.update(ideas).set({ buildsOnId: input.buildsOnId }).where(eq(ideas.id, ideaId)).run();
  }
  const [submission] = await db.insert(ideaSubmissions).values({
    ideaId,
    answersJson: JSON.stringify(input.answers),
    metricsJson: JSON.stringify(input.metrics),
    score,
    minimumScore,
    validationPassed: false,
    differentiation: input.differentiation ?? null,
  }).onConflictDoUpdate({
    target: ideaSubmissions.ideaId,
    set: { answersJson: JSON.stringify(input.answers), metricsJson: JSON.stringify(input.metrics), score, minimumScore, differentiation: input.differentiation ?? null, updatedAt: new Date() },
  }).returning().all();
  if (!submission) throw new Error("Idea submission details were not saved");
  return submission;
}

export async function creditOriginalIdea(actor: IdeaActor, ideaId: number, originalIdeaId: number) {
  const authorId = actorUserId(actor);
  return db.transaction((tx) => {
    const [idea] = tx.select().from(ideas).where(and(eq(ideas.id, ideaId), eq(ideas.authorId, authorId))).limit(1).all();
    const [original] = tx.select().from(ideas).where(eq(ideas.id, originalIdeaId)).limit(1).all();
    if (!idea || !original || original.status === "draft" || original.authorId === authorId || originalIdeaId === ideaId) throw new Error("Selected original idea is invalid");
    if (idea.buildsOnId === originalIdeaId) return { originalAuthorId: original.authorId, credited: true };
    if (idea.buildsOnId) throw new Error("This idea already credits a different original");
    tx.update(ideas).set({ buildsOnId: originalIdeaId, updatedAt: new Date() }).where(eq(ideas.id, ideaId)).run();
    tx.insert(notifications).values({ userId: original.authorId, type: "idea_builds_on", title: "A colleague built on your idea", body: `${original.reference} has been credited as the basis for a related idea.`, link: `/ideas/${ideaId}` }).run();
    return { originalAuthorId: original.authorId, credited: true };
  });
}

export async function submitIdea(actor: IdeaActor, ideaId: number, options: { submitForHumanReview?: boolean } = {}) {
  const userId = actorUserId(actor);
  const result = await db.transaction((tx) => {
    const [idea] = tx.select().from(ideas).where(and(eq(ideas.id, ideaId), eq(ideas.authorId, userId))).limit(1).all();
    if (!idea) throw new Error("Idea not found or not authorized");
    const [submission] = tx.select().from(ideaSubmissions).where(eq(ideaSubmissions.ideaId, ideaId)).limit(1).all();
    if (!submission) throw new Error("Five answers and all three impact metrics are required before submission");
    const metrics = JSON.parse(submission.metricsJson) as PriorityMetrics;
    if (submission.submittedAt) {
      const [event] = tx.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents)
        .where(and(eq(ideaEvents.ideaId, ideaId), eq(ideaEvents.eventType, "submitted"))).orderBy(desc(ideaEvents.id)).limit(1).all();
      let breakdown = scorePriority(metrics, defaultPriorityPolicy).breakdown;
      try {
        const metadata = JSON.parse(event?.metadataJson ?? "{}");
        if (Array.isArray(metadata.breakdown) && metadata.breakdown.length === 3) breakdown = metadata.breakdown;
      } catch { /* Historical submissions predate detailed breakdowns. */ }
      return { idea, reference: idea.reference, score: submission.score, minimumScore: submission.minimumScore, priorityBand: idea.priorityBand, category: idea.category, breakdown, aiValidationScore: submission.aiValidationScore, aiValidationAttempts: submission.aiValidationAttempts, submittedWithLowAiScore: submission.submittedWithLowAiScore, submitted: true as const };
    }
    const policyRows = tx.select({ key: ideaSettings.key, value: ideaSettings.value }).from(ideaSettings)
      .where(inArray(ideaSettings.key, ["priority_kpis", "priority_bands"])).all();
    const policy = resolvePriorityPolicy(Object.fromEntries(policyRows.map(({ key, value }) => [key, value])));
    const priority = scorePriority(metrics, policy);
    const { breakdown } = priority;
    const [latestVersion] = tx.select({ id: ideaVersions.id }).from(ideaVersions).where(eq(ideaVersions.ideaId, ideaId)).orderBy(desc(ideaVersions.version)).limit(1).all();
    const [validationRun] = tx.select().from(aiRuns).where(and(eq(aiRuns.ideaId, ideaId), eq(aiRuns.jobKey, "idea.validate"), eq(aiRuns.ideaVersionId, latestVersion?.id ?? -1))).orderBy(desc(aiRuns.createdAt)).limit(1).all();
    let validationScore: number | null = null;
    let validationPassed = false;
    try {
      const result = JSON.parse(validationRun?.resultJson ?? "{}");
      validationScore = normalizeIdeaValidationScore(result.overallScore);
      validationPassed = validationRun?.status === "succeeded" && ideaValidationPasses(result);
    } catch { /* Invalid or absent AI results fail closed. */ }
    const validationRuns = tx.select({ ideaVersionId: aiRuns.ideaVersionId, resultJson: aiRuns.resultJson }).from(aiRuns)
      .where(and(eq(aiRuns.ideaId, ideaId), eq(aiRuns.jobKey, "idea.validate"), eq(aiRuns.status, "succeeded"))).all();
    const scoredVersions = new Set<number>();
    const lowScoringVersions = new Set<number>();
    for (const run of validationRuns) {
      if (run.ideaVersionId === null) continue;
      try {
        const score = normalizeIdeaValidationScore(JSON.parse(run.resultJson ?? "{}").overallScore);
        if (score === null) continue;
        scoredVersions.add(run.ideaVersionId);
        if (score <= IDEA_VALIDATION_PASS_SCORE) lowScoringVersions.add(run.ideaVersionId);
      } catch { /* Malformed historical results do not qualify for the human review path. */ }
    }
    const submittedWithLowAiScore = !validationPassed && validationScore !== null &&
      validationScore <= IDEA_VALIDATION_PASS_SCORE && options.submitForHumanReview === true && lowScoringVersions.size >= 2;
    if (!validationPassed && !submittedWithLowAiScore) {
      if (validationScore !== null && validationScore <= IDEA_VALIDATION_PASS_SCORE && lowScoringVersions.size >= 2) {
        throw new Error("This idea scored below the AI validation threshold. Choose submit for human review to continue.");
      }
      throw new Error(`Idea validation must pass for the current draft before submission (score ${validationScore === null ? "unavailable" : `${validationScore}/10`}; must be above 7/10). Improve the draft and revalidate. Human review submission becomes available after two below-threshold results on different draft versions.`);
    }
    const [preflight] = tx.select().from(aiRuns).where(and(eq(aiRuns.ideaId, ideaId), eq(aiRuns.ideaVersionId, latestVersion?.id ?? -1), eq(aiRuns.jobKey, "idea.preflight"), eq(aiRuns.status, "succeeded"))).orderBy(desc(aiRuns.createdAt)).limit(1).all();
    let safe = false;
    try { const result = JSON.parse(preflight?.resultJson ?? "{}"); safe = result.decision === "allow" && result.safeToProcess === true; } catch { safe = false; }
    if (!safe) throw new Error("Idea must pass validation before it can be submitted");
    const [minimumSetting] = tx.select().from(ideaSettings).where(eq(ideaSettings.key, "minimum_priority_score")).limit(1).all();
    const minimum = Number(minimumSetting?.value ?? 2);
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 3) throw new Error("Configured minimum priority score is invalid");
    if (priority.score < minimum) throw new IdeaPriorityMinimumError(priority.score, minimum, priority.band, breakdown);
    if (idea.status !== "draft" && idea.status !== "screening" && idea.status !== "returned") throw new Error("Idea cannot be submitted from its current status");
    const year = new Date().getUTCFullYear();
    const [{ count: existingReferences }] = tx.select({ count: sql<number>`count(*)` }).from(ideas).where(like(ideas.reference, `ABI-${year}-%`)).all();
    const [sequence] = tx.insert(ideaReferenceSequences).values({ year, lastValue: Number(existingReferences ?? 0) + 1 }).onConflictDoUpdate({
      target: ideaReferenceSequences.year,
      set: { lastValue: sql`${ideaReferenceSequences.lastValue} + 1` },
    }).returning().all();
    if (!sequence || sequence.lastValue > 99_999) throw new Error("The annual idea reference sequence is exhausted");
    const reference = `ABI-${year}-${String(sequence.lastValue).padStart(5, "0")}`;
    const [updated] = tx.update(ideas).set({ reference, priorityScore: priority.score, priorityBand: priority.band, status: "screening", updatedAt: new Date() }).where(eq(ideas.id, ideaId)).returning().all();
    const validationAttempts = scoredVersions.size;
    tx.update(ideaSubmissions).set({ score: priority.score, validationPassed, aiValidationScore: validationScore, aiValidationAttempts: validationAttempts, submittedWithLowAiScore, submittedAt: new Date(), minimumScore: minimum, updatedAt: new Date() }).where(eq(ideaSubmissions.ideaId, ideaId)).run();
    const validationMetadata = { aiValidationScore: validationScore, aiValidationAttempts: validationAttempts, submittedWithLowAiScore };
    tx.insert(ideaEvents).values({ ideaId, actorType: actor.kind, actorId: userId, eventType: "submitted", toStatus: "screening", metadataJson: JSON.stringify({ score: priority.score, band: priority.band, minimum, breakdown, ...validationMetadata }) }).run();
    tx.insert(notifications).values({ userId, type: "idea_submitted", title: "Idea submitted", body: submittedWithLowAiScore ? `${reference} was submitted for human review after repeated below-threshold AI scores.` : `${reference} has been submitted for review.`, link: `/ideas/${ideaId}` }).run();
    tx.insert(auditEvents).values({ actorUserId: userId, action: "ideas.submitted", targetType: "idea", targetId: String(ideaId), metadataJson: JSON.stringify({ status: "submitted", result: priority.score, ...validationMetadata }), createdAt: new Date() }).run();
    return { idea: updated, reference, score: priority.score, minimumScore: minimum, priorityBand: updated.priorityBand, category: updated.category, breakdown, ...validationMetadata, submitted: true as const };
  });
  const points = await awardPoints({ userId, amount: 50, eventType: "idea_submission", sourceType: "idea", sourceId: String(ideaId), idempotencyKey: `idea:${ideaId}:submission:points` });
  return { ...result, pointsAwarded: points.ledger.amount };
}
