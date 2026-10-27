export type JsonPostResponse = {
  status: number;
  statusText: string;
  contentType: string | null;
  requestId: string | null;
  bodyText: string;
  truncated: boolean;
};

async function readTextLimited(response: Response, maxBytes: number) {
  if (!response.body) return { bodyText: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        totalBytes = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bodyText: new TextDecoder().decode(bytes), truncated };
}

/** Server-side JSON POST helper. It returns the upstream body as text so callers can inspect unknown response schemas. */
export async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
): Promise<JsonPostResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { accept: "*/*", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    redirect: "manual",
    cache: "no-store",
  });
  const { bodyText, truncated } = await readTextLimited(response, options.maxResponseBytes ?? 128_000);

  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get("content-type"),
    requestId: response.headers.get("x-request-id") ?? response.headers.get("request-id"),
    bodyText,
    truncated,
  };
}
