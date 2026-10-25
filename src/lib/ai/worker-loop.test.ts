import assert from "node:assert/strict";
import test from "node:test";
import { getWorkerPollInterval, processNextWithSqliteRetry, runWorkerLoop } from "./worker-loop";

test("poll interval defaults and clamps environment values to 100–60000ms", () => {
  for (const value of [undefined, "", "bad", "Infinity"]) assert.equal(getWorkerPollInterval(value), 1000);
  assert.equal(getWorkerPollInterval("0"), 100);
  assert.equal(getWorkerPollInterval("-5"), 100);
  assert.equal(getWorkerPollInterval("90000"), 60000);
  assert.equal(getWorkerPollInterval("2500"), 2500);
});

test("idle polls continue, process later work, and suppress repeated idle logs", async () => {
  const controller = new AbortController();
  const statuses = ["idle", "idle", "succeeded", "idle"] as const;
  const logged: string[] = [];
  const waits: number[] = [];
  let calls = 0;
  await runWorkerLoop({
    signal: controller.signal, pollIntervalMs: 250,
    processNext: async () => ({ status: statuses[calls++] }),
    onOutcome: (outcome) => logged.push(outcome.status),
    wait: async (ms) => { waits.push(ms); if (calls === 4) controller.abort(); },
  });
  assert.equal(calls, 4);
  assert.deepEqual(logged, ["idle", "succeeded", "idle"]);
  assert.deepEqual(waits, [250, 250, 250, 250]);
});

for (const status of ["idle", "succeeded"] as const) {
  test(`once processes exactly one ${status} outcome without waiting`, async () => {
    let calls = 0;
    await runWorkerLoop({ once: true, processNext: async () => { calls++; return { status }; },
      wait: async () => { assert.fail("once must not wait"); } });
    assert.equal(calls, 1);
  });
}

test("stop during in-flight work finishes it without another claim or delay", async () => {
  const controller = new AbortController();
  const logged: string[] = [];
  await runWorkerLoop({ signal: controller.signal,
    processNext: async () => { controller.abort(); return { status: "succeeded" }; },
    onOutcome: (outcome) => logged.push(outcome.status),
    wait: async () => { assert.fail("must not wait after stopping"); },
  });
  assert.deepEqual(logged, ["succeeded"]);
});

test("pre-aborted worker never claims work", async () => {
  await runWorkerLoop({ signal: AbortSignal.abort(), processNext: async () => { assert.fail("must not claim"); } });
});

test("stop interrupts a long idle timer", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const stopTimer = setTimeout(() => controller.abort(), 10);
  try {
    await runWorkerLoop({ signal: controller.signal, pollIntervalMs: 60000,
      processNext: async () => ({ status: "idle" }), });
  } finally { clearTimeout(stopTimer); }
});

test("unexpected processing errors propagate to the script error handler", async () => {
  await assert.rejects(runWorkerLoop({ processNext: async () => { throw new Error("database unavailable"); } }), /database unavailable/);
});

test("a transient SQLite lock leaves the worker polling, while other failures still surface", async () => {
  let calls = 0;
  const outcome = await processNextWithSqliteRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return { status: "succeeded" };
  });
  assert.deepEqual(outcome, { status: "idle" });
  assert.deepEqual(await processNextWithSqliteRetry(async () => ({ status: "succeeded" })), { status: "succeeded" });
  await assert.rejects(processNextWithSqliteRetry(async () => { throw new Error("unavailable"); }), /unavailable/);
});

test("Next development output is separate from build and start output", async () => {
  const { default: config } = await import("../../../next.config.mjs");
  assert.equal(config("phase-development-server").distDir, ".next-dev");
  assert.equal(config("phase-production-build").distDir, ".next");
  assert.equal(config("phase-production-server").distDir, ".next");
});
