import assert from "node:assert/strict";
import test from "node:test";
import { getWorkerStaleAfterMs } from "./worker-loop";

test("worker lease is longer than one configured provider request timeout", () => {
  assert.equal(getWorkerStaleAfterMs("60000", 30_000), 90_000);
  assert.equal(getWorkerStaleAfterMs("180000", 30_000), 180_000);
  assert.equal(getWorkerStaleAfterMs(undefined, 240_000), 300_000);
});
