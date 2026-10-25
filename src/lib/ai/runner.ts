import { createHash } from "node:crypto";
import { z } from "zod";
import { AiIdempotencyError, AiPolicyError, AiSchemaValidationError, AiTimeoutError } from "./errors";
import { redactAiError } from "./observability";
import { evaluateAiInput, type PolicyBlock } from "./policy";
import { getAiJob } from "./registry";
import type { SafeAiInput } from "./policy";
import type { AiJobDefinition, AiRunnerDependencies, AiRunResult, RunStructuredAiArgs } from "./types";
import type { AiRun } from "../../db/schema";
import {
  appendIdeaEvent,
  claimAiRun,
  completeAiRun,
  createAiRun,
  failAiRun,
} from "../ideas/repository";

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire() {
    if (this.active < this.capacity) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release() {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

const semaphores = new Map<number, Semaphore>();

function semaphoreFor(capacity: number) {
  const existing = semaphores.get(capacity);
  if (existing) return existing;
  const semaphore = new Semaphore(capacity);
  semaphores.set(capacity, semaphore);
  return semaphore;
}

function hashInput(input: unknown) {
  let serialized = "unserializable";
  try { serialized = JSON.stringify(input); } catch { /* policy will reject this input */ }
  return createHash("sha256").update(serialized).digest("hex");
}

function outputError(result: { success: false; error: z.ZodError }) {
  return new AiSchemaValidationError("AI output did not match the registered job schema", { cause: result.error });
}

async function failRun(runId: number, ideaId: number, actor: RunStructuredAiArgs<unknown>["actor"], error: unknown) {
  const safe = redactAiError(error);
  await failAiRun(runId, {
    status: error instanceof AiTimeoutError ? "timed_out" : "failed",
    errorCode: safe.code,
    errorMessage: safe.message,
  });
  await appendIdeaEvent({
    ideaId,
    actorType: actor.kind,
    actorId: actor.id ? Number(actor.id) : null,
    eventType: "ai_failed",
    correlationId: undefined,
    metadataJson: JSON.stringify({ errorCode: safe.code }),
  });
}

export async function executeClaimedAiRun<TInput, TOutput>(
  claimed: AiRun,
  args: RunStructuredAiArgs<TInput>,
  job: AiJobDefinition<TInput, TOutput>,
  safeInput: SafeAiInput,
  dependencies: AiRunnerDependencies,
): Promise<AiRunResult<TOutput>> {
  const semaphore = semaphoreFor(dependencies.concurrency ?? 4);
  await semaphore.acquire();
  const started = Date.now();
  try {
    const response = await dependencies.provider.generateStructured({
      model: claimed.model,
      systemPrompt: job.systemPrompt,
      userContent: job.buildInput(args.input, safeInput),
      responseMimeType: "application/json",
      responseJsonSchema: job.responseJsonSchema,
      maxOutputTokens: dependencies.maxOutputTokens ?? 4_096,
      temperature: dependencies.temperature ?? 0,
      timeoutMs: dependencies.timeoutMs ?? 30_000,
    });
    let decoded: unknown;
    try { decoded = JSON.parse(response.text); } catch (error) { throw new AiSchemaValidationError("AI output was not valid JSON", { cause: error }); }
    const parsedOutput = job.outputSchema.safeParse(decoded);
    if (!parsedOutput.success) throw outputError(parsedOutput);
    await completeAiRun(claimed.id, {
      resultJson: JSON.stringify(parsedOutput.data),
      usageJson: response.usage ? JSON.stringify(response.usage) : undefined,
      finishReason: response.finishReason,
    });
    await appendIdeaEvent({ ideaId: args.ideaId, actorType: "ai", eventType: "ai_completed", correlationId: args.correlationId, metadataJson: JSON.stringify({ jobKey: job.key, runId: claimed.id }) });
    return {
      runId: String(claimed.id), jobKey: job.key, jobVersion: job.version, promptVersion: job.version,
      model: claimed.model, data: parsedOutput.data, attempts: claimed.attemptCount, latencyMs: Date.now() - started,
      usage: response.usage, finishReason: response.finishReason,
    };
  } catch (error) {
    await failRun(claimed.id, args.ideaId, args.actor, error);
    throw error;
  } finally {
    semaphore.release();
  }
}

export async function runStructuredAi<TInput, TOutput>(
  args: RunStructuredAiArgs<TInput>,
  dependencies: AiRunnerDependencies,
): Promise<AiRunResult<TOutput>> {
  const job = getAiJob(args.jobKey) as unknown as AiJobDefinition<TInput, TOutput>;
  const parsedInput = job.inputSchema.safeParse(args.input);
  if (!parsedInput.success) throw new AiSchemaValidationError("AI job input did not match its schema", { cause: parsedInput.error });

  const safeInput = evaluateAiInput(args.input, job.safety);
  const inputHash = safeInput.allowed ? safeInput.contentHash : hashInput(args.input);
  const requestedBy = args.actor.kind === "user" || args.actor.kind === "admin" ? Number(args.actor.id) : null;
  const run = await createAiRun({
    ideaId: args.ideaId,
    ideaVersionId: args.ideaVersionId,
    jobKey: job.key,
    jobVersion: job.version,
    promptVersion: job.version,
    model: job.model ?? dependencies.model ?? "gemini-3.8-flash",
    idempotencyKey: args.idempotencyKey,
    correlationId: args.correlationId,
    requestedBy: Number.isFinite(requestedBy) ? requestedBy : null,
    inputHash,
  });

  if (run.status === "succeeded" && run.resultJson) {
    const cached = job.outputSchema.safeParse(JSON.parse(run.resultJson));
    if (!cached.success) throw outputError(cached);
    return {
      runId: String(run.id), jobKey: run.jobKey, jobVersion: run.jobVersion, promptVersion: run.promptVersion,
      model: run.model, data: cached.data, attempts: run.attemptCount, latencyMs: 0,
      usage: run.usageJson ? JSON.parse(run.usageJson) : undefined, finishReason: run.finishReason ?? undefined,
    };
  }
  if (run.status !== "queued") throw new AiIdempotencyError("An AI run already exists for this idempotency key");

  if (!safeInput.allowed) {
    const block = safeInput as PolicyBlock;
    const error = new AiPolicyError(block.code === "invalid_input" ? "sensitive_data" : block.code, block.reason);
    await failRun(run.id, args.ideaId, args.actor, error);
    throw error;
  }

  const claimed = await claimAiRun(run.id, dependencies.workerId ?? "inline-runner");
  if (!claimed) throw new AiIdempotencyError("AI run could not be claimed");
  return executeClaimedAiRun(claimed, args, job, safeInput, dependencies);
}
