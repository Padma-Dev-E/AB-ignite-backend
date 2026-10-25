import assert from "node:assert/strict";
import test from "node:test";

test("refreshes in separate tabs serialize before sending rotating cookies", async () => {
  const first = await import(new URL("./client-refresh.ts?tab=first", import.meta.url).href) as typeof import("./client-refresh");
  const second = await import(new URL("./client-refresh.ts?tab=second", import.meta.url).href) as typeof import("./client-refresh");
  assert.notEqual(first.refreshSession, second.refreshSession);

  const previousFetch = globalThis.fetch;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let queue = Promise.resolve();
  let active = 0;
  let maximumActive = 0;
  let requests = 0;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: { request: async (_name: string, callback: () => Promise<boolean>) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try { return await callback(); } finally { release(); }
    } } },
  });
  globalThis.fetch = async () => {
    requests++;
    active++;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return new Response(null, { status: 200 });
  };

  try {
    assert.deepEqual(await Promise.all([first.refreshSession(), second.refreshSession()]), [true, true]);
    assert.equal(requests, 2);
    assert.equal(maximumActive, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousNavigator) Object.defineProperty(globalThis, "navigator", previousNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
