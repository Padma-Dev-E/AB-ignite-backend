import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../../", import.meta.url);

test("Docker deployment exposes only frontend and backend services", async () => {
  const compose = await readFile(new URL("compose.yaml", root), "utf8");
  const services = compose.match(/^services:\n([\s\S]*?)(?=^volumes:)/m)?.[1] ?? "";
  const names = [...services.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]).sort();

  assert.deepEqual(names, ["api", "web"]);
  assert.doesNotMatch(services, /ai-worker|^  setup:/m);
  assert.match(services, /api:[\s\S]*?command:\s*\["backend"\]/);
  assert.match(services, /web:[\s\S]*?depends_on:[\s\S]*?api:/);
});

test("backend starts its AI worker in-process with the API server", async () => {
  const server = await readFile(new URL("apps/api/src/server.ts", root), "utf8");

  assert.match(server, /runWorkerLoop/);
  assert.match(server, /processNextAiRun/);
  assert.match(server, /SIGTERM/);
});
