import { buildApi } from "./app.js";
import { env } from "./config/env.js";
import { setTimeout as delay } from "node:timers/promises";
import { createGeminiProvider } from "../../../src/lib/ai/gemini-provider-core.js";
import { getAiConfig } from "../../../src/lib/ai/config-core.js";
import { processNextAiRun } from "../../../src/lib/ai/worker.js";
import { getWorkerPollInterval, processNextWithSqliteRetry, runWorkerLoop } from "../../../src/lib/ai/worker-loop.js";

function startAiWorker(app: Awaited<ReturnType<typeof buildApi>>, signal: AbortSignal) {
  const config = getAiConfig();
  if (!config.apiKey) {
    app.log.warn("AI worker is not processing jobs because Gemini API credentials are not configured.");
    return Promise.resolve();
  }

  const workerId = process.env.AI_WORKER_ID ?? `backend-worker-${process.pid}`;
  const provider = createGeminiProvider(config);
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

void start().catch((error) => {
  // Avoid printing startup exceptions because config/database errors may carry sensitive values.
  process.stderr.write("Fastify API startup failed. Check the server configuration.\n");
  process.exitCode = 1;
});
