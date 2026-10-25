/** Shares one browser refresh across focus handling and protected API calls. */
let inFlight: Promise<boolean> | null = null;

export function activeSessionRefresh(): Promise<boolean> | null {
  return inFlight;
}

export function refreshSession(): Promise<boolean> {
  if (inFlight) return inFlight;
  const performRefresh = () => fetch("/api/auth/refresh", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  }).then((response) => response.ok);
  // A refresh rotates both cookies. Tabs sharing a cookie jar must finish one
  // response before another tab reads and rotates the resulting cookie.
  const request: Promise<boolean> = (async () => {
    if (typeof navigator !== "undefined" && navigator.locks) {
      return await navigator.locks.request("ab-ignite-session-refresh", async () => performRefresh());
    }
    return performRefresh();
  })().catch(() => false);
  inFlight = request;
  void request.finally(() => {
    if (inFlight === request) inFlight = null;
  });
  return request;
}
