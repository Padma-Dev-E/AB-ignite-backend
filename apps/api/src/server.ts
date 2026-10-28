import { buildApi } from "./app.js";
import { env } from "./config/env.js";
import { setTimeout as delay } from "node:timers/promises";
import { createApigeeProvider } from "../../../src/lib/ai/apigee-provider-core.js";
import { getAiConfig } from "../../../src/lib/ai/config-core.js";
import { processNextAiRun } from "../../../src/lib/ai/worker.js";
import { getWorkerPollInterval, processNextWithSqliteRetry, runWorkerLoop } from "../../../src/lib/ai/worker-loop.js";

function startAiWorker(app: Awaited<ReturnType<typeof buildApi>>, signal: AbortSignal) {
  const config = getAiConfig();
  if (!config.apigeeUrl || !config.apigeeClientId) {
    app.log.warn("AI worker is not processing jobs because APIGEE_URL or APIGEE_CLIENT_ID is not configured.");
    return Promise.resolve();
  }

  const workerId = process.env.AI_WORKER_ID ?? `backend-worker-${process.pid}`;
  const provider = createApigeeProvider(config);
  const pollIntervalMs = getWorkerPollInterval(process.env.AI_WORKER_POLL_INTERVAL_MS);
  app.log.info({ workerId, pollIntervalMs }, "AI worker started within the backend service");

  return (async () => {
    let retryDelayMs = 1_000;
    while (!signal.aborted) {
      try {
        await runWorkerLoop({
          signal,
          pollIntervalMs,
          processNext: () => processNextWithSqliteRetry(() => processNextAiRun(workerId, { provider })),
          onOutcome: (outcome) => {
            if (outcome.status !== "idle") app.log.info({ workerId, ...outcome }, "AI job processed");
          },
        });
        if (signal.aborted) break;
        app.log.error("AI worker loop stopped unexpectedly; restarting it.");
      } catch (error) {
        app.log.error({ err: error }, "AI worker loop failed; restarting it.");
      }

      try {
        await delay(retryDelayMs, undefined, { signal });
      } catch {
        if (!signal.aborted) throw new Error("AI worker restart delay failed.");
      }
      retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
    }
  })();
}

async function start() {
  const app = await buildApi();
  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (error) {
    app.log.error({ err: error }, "Fastify API failed to start");
    process.exitCode = 1;
    await app.close();
    return;
  }

  const shutdown = new AbortController();
  const worker = startAiWorker(app, shutdown.signal);
  let closing: Promise<void> | undefined;
  const stop = () => {
    closing ??= (async () => {
      shutdown.abort();
      await app.close();
      await worker;
      process.exitCode = 0;
    })();
    return closing;
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void stop(); });
  }
}

function safeStartupError(error: unknown) {
  const value = error instanceof Error ? error : new Error("Unknown startup error");
  const candidateCode = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  const code = typeof candidateCode === "string" && /^[A-Z0-9_-]{1,64}$/i.test(candidateCode)
    ? candidateCode
    : undefined;
  const message = value.message
    .replace(/\b(auth[_-]?secret|internal[_-]?api[_-]?token|gemini[_-]?api[_-]?key|apigee[_-]?client[_-]?id|password|token|api[_-]?key)\b(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .slice(0, 500);
  return { name: value.name, ...(code ? { code } : {}), message };
}

void start().catch((error) => {
  // Keep useful startup diagnostics while redacting common secret-bearing values.
  process.stderr.write(`${JSON.stringify({ level: "error", event: "fastify_api_startup_failed", error: safeStartupError(error) })}\n`);
  process.exitCode = 1;
});
