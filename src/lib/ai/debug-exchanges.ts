import { and, desc, eq, gt, lt } from "drizzle-orm";
import { db } from "../../db/connection";
import { aiDebugExchanges, aiRuns } from "../../db/schema";
import type { AiConfig } from "./config-core";
import { decryptAiDebugPayload, encryptAiDebugPayload } from "./debug-crypto";

export type AiDebugExchangeCapture = {
  runId: number;
  attempt: number;
  requestPayload: string;
  responsePayload?: string | null;
  responseStatus?: number | null;
  responseStatusText?: string | null;
  responseTruncated?: boolean;
  durationMs: number;
  processingStage: string;
  errorCode?: string | null;
  errorMessage?: string | null;
};

const MAX_REQUEST_PAYLOAD_BYTES = 512_000;
const MAX_RESPONSE_PAYLOAD_BYTES = 264_000;
const MAX_EXCHANGES_PER_IDEA = 10;

let expirySweep: NodeJS.Timeout | undefined;

function scheduleExpirySweep() {
  if (expirySweep) return;
  expirySweep = setInterval(() => {
    try { db.delete(aiDebugExchanges).where(lt(aiDebugExchanges.expiresAt, new Date())).run(); } catch { /* best effort housekeeping */ }
  }, 60 * 60 * 1000);
  expirySweep.unref();
}

export async function purgeExpiredAiDebugExchanges(now = new Date()) {
  scheduleExpirySweep();
  await db.delete(aiDebugExchanges).where(lt(aiDebugExchanges.expiresAt, now)).run();
}

export async function recordAiDebugExchange(config: AiConfig, input: AiDebugExchangeCapture) {
  if (!config.aiDebugPayloads || !Number.isInteger(input.runId) || input.runId < 1) return false;
  if (input.attempt < 1 || Buffer.byteLength(input.requestPayload, "utf8") > MAX_REQUEST_PAYLOAD_BYTES) return false;
  if (input.responsePayload && Buffer.byteLength(input.responsePayload, "utf8") > MAX_RESPONSE_PAYLOAD_BYTES) return false;

  const now = new Date();
  await purgeExpiredAiDebugExchanges(now);
  const expiresAt = new Date(now.getTime() + config.aiDebugRetentionHours * 60 * 60 * 1000);
  await db.insert(aiDebugExchanges).values({
    runId: input.runId,
    attempt: input.attempt,
    requestPayloadEncrypted: encryptAiDebugPayload(input.requestPayload),
    responsePayloadEncrypted: input.responsePayload ? encryptAiDebugPayload(input.responsePayload) : null,
    responseStatus: input.responseStatus ?? null,
    responseStatusText: input.responseStatusText ?? null,
    responseTruncated: input.responseTruncated ?? false,
    durationMs: Math.max(0, Math.floor(input.durationMs)),
    processingStage: input.processingStage,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    createdAt: now,
    expiresAt,
  }).onConflictDoUpdate({
    target: [aiDebugExchanges.runId, aiDebugExchanges.attempt],
    set: {
      requestPayloadEncrypted: encryptAiDebugPayload(input.requestPayload),
      responsePayloadEncrypted: input.responsePayload ? encryptAiDebugPayload(input.responsePayload) : null,
      responseStatus: input.responseStatus ?? null,
      responseStatusText: input.responseStatusText ?? null,
      responseTruncated: input.responseTruncated ?? false,
      durationMs: Math.max(0, Math.floor(input.durationMs)),
      processingStage: input.processingStage,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      createdAt: now,
      expiresAt,
    },
  }).run();
  return true;
}

export async function updateAiDebugExchangeStage(
  config: AiConfig,
  runId: number | undefined,
  attempt: number,
  update: { processingStage: string; errorCode?: string | null; errorMessage?: string | null },
) {
  if (!config.aiDebugPayloads || !runId) return;
  await db.update(aiDebugExchanges).set({
    processingStage: update.processingStage,
    errorCode: update.errorCode ?? null,
    errorMessage: update.errorMessage ?? null,
  }).where(and(eq(aiDebugExchanges.runId, runId), eq(aiDebugExchanges.attempt, attempt))).run();
}

export async function listAiDebugExchangesForIdea(ideaId: number) {
  const now = new Date();
  await purgeExpiredAiDebugExchanges(now);
  const rows = await db.select({
    id: aiDebugExchanges.id,
    runId: aiDebugExchanges.runId,
    jobKey: aiRuns.jobKey,
    runStatus: aiRuns.status,
    attempt: aiDebugExchanges.attempt,
    responseStatus: aiDebugExchanges.responseStatus,
    responseStatusText: aiDebugExchanges.responseStatusText,
    responseTruncated: aiDebugExchanges.responseTruncated,
    durationMs: aiDebugExchanges.durationMs,
    processingStage: aiDebugExchanges.processingStage,
    errorCode: aiDebugExchanges.errorCode,
    errorMessage: aiDebugExchanges.errorMessage,
    requestPayloadEncrypted: aiDebugExchanges.requestPayloadEncrypted,
    responsePayloadEncrypted: aiDebugExchanges.responsePayloadEncrypted,
    createdAt: aiDebugExchanges.createdAt,
    expiresAt: aiDebugExchanges.expiresAt,
  }).from(aiDebugExchanges)
    .innerJoin(aiRuns, eq(aiRuns.id, aiDebugExchanges.runId))
    .where(and(eq(aiRuns.ideaId, ideaId), gt(aiDebugExchanges.expiresAt, now)))
    .orderBy(desc(aiDebugExchanges.createdAt), desc(aiDebugExchanges.attempt))
    .limit(MAX_EXCHANGES_PER_IDEA).all();

  return rows.map((row) => {
    try {
      return {
        id: row.id,
        runId: row.runId,
        jobKey: row.jobKey,
        runStatus: row.runStatus,
        attempt: row.attempt,
        responseStatus: row.responseStatus,
        responseStatusText: row.responseStatusText,
        responseTruncated: row.responseTruncated,
        durationMs: row.durationMs,
        processingStage: row.processingStage,
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
        requestPayload: decryptAiDebugPayload(row.requestPayloadEncrypted),
        responsePayload: row.responsePayloadEncrypted ? decryptAiDebugPayload(row.responsePayloadEncrypted) : null,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      };
    } catch {
      return {
        id: row.id,
        runId: row.runId,
        jobKey: row.jobKey,
        runStatus: row.runStatus,
        attempt: row.attempt,
        responseStatus: row.responseStatus,
        responseStatusText: row.responseStatusText,
        responseTruncated: row.responseTruncated,
        durationMs: row.durationMs,
        processingStage: "diagnostic_decryption_failed",
        errorCode: "diagnostic_decryption_failed",
        errorMessage: "Diagnostic payload is unavailable; the encryption key may have changed.",
        requestPayload: null,
        responsePayload: null,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      };
    }
  });
}
