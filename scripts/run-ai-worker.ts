import "dotenv/config";

import { createGeminiProvider } from "../src/lib/ai/gemini-provider-core";
import { getAiConfig } from "../src/lib/ai/config-core";
import { processNextAiRun } from "../src/lib/ai/worker";
import { getWorkerPollInterval, processNextWithSqliteRetry, runWorkerLoop } from "../src/lib/ai/worker-loop";

const workerId = process.env.AI_WORKER_ID ?? `local-worker-${process.pid}`;
const runOnce = process.argv.includes("--once");
const config = getAiConfig();
const provider = config.apiKey ? createGeminiProvider(config) : undefined;
const shutdown = new AbortController();

function stop() {
  shutdown.abort();
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function run() {
  try {
    await runWorkerLoop({
      once: runOnce,
      signal: shutdown.signal,
      pollIntervalMs: getWorkerPollInterval(process.env.AI_WORKER_POLL_INTERVAL_MS),
      processNext: () => processNextWithSqliteRetry(() => processNextAiRun(workerId, { provider })),
      onOutcome: (outcome) => console.log(JSON.stringify({ workerId, ...outcome })),
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

run().catch((error) => {
  console.error("AI worker failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
