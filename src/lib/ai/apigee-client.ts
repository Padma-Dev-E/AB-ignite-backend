import { Agent } from "undici";
import { AiProviderError, AiProviderOutputError, AiTimeoutError } from "./errors";
import type { AiConfig } from "./config-core";

const insecureAiTlsDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
const MAX_REQUEST_BYTES = 512_000;

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        await reader.cancel();
        throw new AiProviderOutputError("APIGEE response exceeded the configured size limit");
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function responseError(status: number) {
  const category = status === 401 || status === 403
    ? "auth"
    : status === 429
      ? "rate_limited"
      : status >= 500
        ? "transient"
        : "invalid_request";
  return new AiProviderError(category, "APIGEE returned an unsuccessful response", { status });
}

/** Sends a JSON payload to the configured APIGEE endpoint and parses its JSON response. */
export async function callApigeeAi<TResponse = unknown>(config: AiConfig, body: unknown): Promise<TResponse> {
  if (!config.apigeeUrl) throw new AiProviderError("auth", "APIGEE_URL is not configured");
  if (!config.apigeeClientId) throw new AiProviderError("auth", "APIGEE_CLIENT_ID is not configured");

  let url: URL;
  try {
    url = new URL(config.apigeeUrl);
  } catch {
    throw new AiProviderError("invalid_request", "APIGEE_URL must be a valid absolute URL");
  }
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password) {
    throw new AiProviderError("invalid_request", "APIGEE_URL must use HTTP or HTTPS and must not contain embedded credentials");
  }

  let serializedBody: string;
  try {
    serializedBody = JSON.stringify(body);
  } catch {
    throw new AiProviderError("invalid_request", "AI request body could not be serialized as JSON");
  }
  if (typeof serializedBody !== "string") {
    throw new AiProviderError("invalid_request", "AI request body must be a JSON value");
  }
  if (Buffer.byteLength(serializedBody, "utf8") > MAX_REQUEST_BYTES) {
    throw new AiProviderError("invalid_request", "AI request body exceeds the 512 KB limit");
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Client_id: config.apigeeClientId,
      },
      body: serializedBody,
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "error",
      cache: "no-store",
      ...(config.skipSslAiCalls ? { dispatcher: insecureAiTlsDispatcher } : {}),
    } as RequestInit & { dispatcher?: Agent });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AiTimeoutError();
    }
    throw new AiProviderError("transient", "Could not connect to the configured APIGEE endpoint");
  }

  const responseText = await readLimited(response, config.maxOutputBytes + 64_000);
  if (!response.ok) throw responseError(response.status);
  try {
    return JSON.parse(responseText) as TResponse;
  } catch {
    throw new AiProviderOutputError("APIGEE returned a successful response that was not valid JSON");
  }
}
