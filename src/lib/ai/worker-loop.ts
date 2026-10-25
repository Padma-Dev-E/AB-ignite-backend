import { setTimeout as delay } from "node:timers/promises";

/** AI_WORKER_POLL_INTERVAL_MS: default 1s, bounded to 100ms–60s. */
export function getWorkerPollInterval(value?: string): number {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? Math.min(60_000, Math.max(100, Math.round(parsed))) : 1_000;
}

type Outcome = { status: string };

/** SQLite can briefly reject a write while another process owns its lock. */
export async function processNextWithSqliteRetry<T extends Outcome>(processNext: () => Promise<T>): Promise<T | { status: "idle" }> {
  try {
    return await processNext();
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return { status: "idle" };
    throw error;
  }
}
type LoopOptions<T extends Outcome> = {
  processNext: () => Promise<T>;
  once?: boolean;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onOutcome?: (outcome: T) => void;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

async function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (!signal?.aborted || !(error instanceof Error) || error.name !== "AbortError") throw error;
  }
}

/** Stop claims on shutdown, let current work finish, and interrupt idle waits. */
export async function runWorkerLoop<T extends Outcome>(options: LoopOptions<T>): Promise<void> {
  const interval = getWorkerPollInterval(String(options.pollIntervalMs ?? 1_000));
  let wasIdle = false;
  while (!options.signal?.aborted) {
    const outcome = await options.processNext();
    const idle = outcome.status === "idle";
    if (!idle || !wasIdle) options.onOutcome?.(outcome);
    wasIdle = idle;
    if (options.once || options.signal?.aborted) return;
    await (options.wait ?? waitForPoll)(interval, options.signal);
  }
}
