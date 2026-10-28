import { Agent } from "undici";
import { AiProviderError, AiProviderOutputError, AiTimeoutError } from "./errors";
import type { AiConfig } from "./config-core";
import type { AiDebugExchangeCapture } from "./debug-exchanges";

const insecureAiTlsDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const MAX_REQUEST_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 264_000;

async function readLimited(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        size = maxBytes;
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function responseError(status: number) {
  const category = status === 401 || status === 403 ? "auth" : status === 429 ? "rate_limited" : status >= 500 ? "transient" : "invalid_request";
  return new AiProviderError(category, `APIGEE returned HTTP ${status}`, { status, code: "provider_http_error", stage: "http_response" });
}

async function safeRecord(config: AiConfig, input: AiDebugExchangeCapture) {
  if (!config.aiDebugPayloads) return;
  try {
    const { recordAiDebugExchange } = await import("./debug-exchanges");
    await recordAiDebugExchange(config, input);
  } catch {
    // Debug recording is deliberately best effort and cannot interrupt the AI operation.
  }
}

/** Sends a JSON payload to APIGEE. Diagnostics retain body/response only when explicitly enabled. */
export async function callApigeeAi<TResponse = unknown>(
  config: AiConfig,
  body: unknown,
  diagnostic: { runId?: number; attempt?: number } = {},
): Promise<TResponse> {
  if (!config.apigeeUrl) throw new AiProviderError("auth", "APIGEE_URL is not configured", { code: "provider_not_configured" });
  if (!config.apigeeClientId) throw new AiProviderError("auth", "APIGEE_CLIENT_ID is not configured", { code: "provider_not_configured" });

  let url: URL;
  try { url = new URL(config.apigeeUrl); } catch { throw new AiProviderError("invalid_request", "APIGEE_URL must be a valid absolute URL", { code: "provider_configuration_error" }); }
  if (!( ["https:", "http:"].includes(url.protocol)) || url.username || url.password) {
    throw new AiProviderError("invalid_request", "APIGEE_URL must use HTTP or HTTPS and must not contain embedded credentials", { code: "provider_configuration_error" });
  }

  let serializedBody: string;
  try { serializedBody = JSON.stringify(body); } catch { throw new AiProviderError("invalid_request", "AI request body could not be serialized as JSON", { code: "request_serialization_error" }); }
  if (typeof serializedBody !== "string") throw new AiProviderError("invalid_request", "AI request body must be a JSON value", { code: "request_serialization_error" });
  if (Buffer.byteLength(serializedBody, "utf8") > MAX_REQUEST_BYTES) throw new AiProviderError("invalid_request", "AI request body exceeds the 512 KB limit", { code: "request_too_large" });

  const attempt = diagnostic.attempt ?? 1;
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Client_id: config.apigeeClientId },
      body: serializedBody,
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
      cache: "no-store",
      ...(config.skipSslAiCalls ? { dispatcher: insecureAiTlsDispatcher } : {}),
    } as RequestInit & { dispatcher?: Agent });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    await safeRecord(config, {
      runId: diagnostic.runId ?? 0, attempt, requestPayload: serializedBody,
      responsePayload: JSON.stringify({ transport: timedOut ? "timeout" : "connection_failed" }),
      durationMs: Date.now() - started, processingStage: "transport",
      errorCode: timedOut ? "provider_timeout" : "provider_connection_error",
      errorMessage: timedOut ? "APIGEE request timed out" : "Could not connect to the configured APIGEE endpoint",
    });
    if (timedOut) throw new AiTimeoutError();
    throw new AiProviderError("transient", "Could not connect to the configured APIGEE endpoint", { code: "provider_connection_error", stage: "transport" });
  }

  const raw = await readLimited(response, MAX_RESPONSE_BYTES);
  const elapsed = Date.now() - started;
  const stage = raw.truncated ? "response_size_limit" : response.ok ? "response_json_parsing" : "http_response";
  const errorCode = raw.truncated ? "provider_response_too_large" : !response.ok ? "provider_http_error" : null;
  const errorMessage = raw.truncated ? "APIGEE response exceeded the configured size limit" : !response.ok ? `APIGEE returned HTTP ${response.status}` : null;
  await safeRecord(config, {
    runId: diagnostic.runId ?? 0, attempt, requestPayload: serializedBody,
    responsePayload: raw.text, responseStatus: response.status, responseStatusText: response.statusText,
    responseTruncated: raw.truncated, durationMs: elapsed, processingStage: stage,
    errorCode, errorMessage,
  });
  if (diagnostic.runId) {
    try {
      if (config.aiDebugPayloads) {
        const { updateAiDebugExchangeStage } = await import("./debug-exchanges");
        await updateAiDebugExchangeStage(config, diagnostic.runId, attempt, { processingStage: stage, errorCode, errorMessage });
      }
    } catch { /* best effort */ }
  }
  if (raw.truncated) throw new AiProviderOutputError("APIGEE response exceeded the configured size limit", { code: "provider_response_too_large", stage: "response_size_limit" });
  if (!response.ok) throw responseError(response.status);
  try { return JSON.parse(raw.text) as TResponse; }
  catch { throw new AiProviderOutputError("APIGEE returned a successful response that was not valid JSON", { code: "provider_response_not_json", stage: "response_json_parsing" }); }
}
