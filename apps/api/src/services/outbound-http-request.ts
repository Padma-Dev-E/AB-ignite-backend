import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";

export type OutboundHeader = { name: string; value: string };

export type OutboundHttpResult = {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  bodyText: string;
  truncated: boolean;
};

const MAX_RESPONSE_BYTES = 128_000;
const TIMEOUT_MS = 30_000;
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local"];
const TRANSPORT_HEADERS = new Set([
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function errorWithCode(message: string, name: string, code: string) {
  return Object.assign(new Error(message), { name, code });
}

function isAllowedAddress(address: string) {
  try {
    const range = ipaddr.process(address).range();
    return range === "unicast" || range === "private" || range === "uniqueLocal";
  } catch {
    return false;
  }
}

async function resolvePublicAddresses(url: URL): Promise<LookupAddress[]> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw errorWithCode("Requests to localhost and local multicast hostnames are blocked.", "DestinationBlockedError", "DESTINATION_BLOCKED");
  }

  const literalFamily = ipaddr.isValid(hostname) ? ipaddr.parse(hostname).kind() === "ipv4" ? 4 : 6 : 0;
  const addresses = literalFamily
    ? [{ address: ipaddr.process(hostname).toString(), family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(({ address }) => !isAllowedAddress(address))) {
    throw errorWithCode("Requests to loopback, link-local, or reserved network addresses are blocked.", "DestinationBlockedError", "DESTINATION_BLOCKED");
  }
  return addresses;
}

function responseHeaders(headers: IncomingHttpHeaders) {
  const output: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) output[name] = value;
  }
  return output;
}

export async function sendOutboundHttpRequest(input: {
  url: URL;
  method: string;
  headers: OutboundHeader[];
  body: string;
  skipSslVerification?: boolean;
}): Promise<OutboundHttpResult> {
  const requestHeaders = new Headers();
  for (const header of input.headers) {
    const name = header.name.trim();
    if (!name) continue;
    if (TRANSPORT_HEADERS.has(name.toLowerCase())) {
      throw errorWithCode(`The ${name} header is controlled by the HTTP transport.`, "InvalidHeaderError", "INVALID_HEADER");
    }
    requestHeaders.append(name, header.value);
  }

  const headers = Object.fromEntries(requestHeaders.entries());
  let activeRequest: ReturnType<typeof httpRequest> | undefined;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      const error = errorWithCode(`Request timed out after ${TIMEOUT_MS} ms.`, "TimeoutError", "ETIMEDOUT");
      activeRequest?.destroy(error);
      reject(error);
    }, TIMEOUT_MS);
  });

  try {
    const addresses = await Promise.race([resolvePublicAddresses(input.url), timeout]);
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      if (typeof options === "object" && options !== null && "all" in options && options.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    };
    const options: RequestOptions = {
      hostname: input.url.hostname.replace(/^\[|\]$/g, ""),
      ...(input.url.port ? { port: Number(input.url.port) } : {}),
      path: `${input.url.pathname}${input.url.search}`,
      method: input.method,
      headers,
      lookup: pinnedLookup,
      agent: false,
      ...(input.url.protocol === "https:" ? { rejectUnauthorized: !input.skipSslVerification } : {}),
    };

    const responsePromise = new Promise<OutboundHttpResult>((resolve, reject) => {
      const clientRequest = (input.url.protocol === "https:" ? httpsRequest : httpRequest)(options, (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        let settled = false;
        const result = (): OutboundHttpResult => ({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders(response.headers),
          bodyText: Buffer.concat(chunks).toString("utf8"),
          truncated,
        });
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve(result());
        };

        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const remaining = MAX_RESPONSE_BYTES - bytes;
          if (remaining > 0) {
            const accepted = buffer.subarray(0, remaining);
            chunks.push(accepted);
            bytes += accepted.length;
          }
          if (buffer.length > remaining) {
            truncated = true;
            finish();
            response.destroy();
          }
        });
        response.on("end", finish);
        response.on("error", (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      });

      activeRequest = clientRequest;
      clientRequest.on("error", reject);
      clientRequest.end(input.body.length ? input.body : undefined);
    });

    return await Promise.race([responsePromise, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function outboundErrorDetails(error: unknown) {
  const value = error instanceof Error ? error : new Error(String(error));
  const directCode = "code" in value && typeof value.code === "string" ? value.code : undefined;
  const cause = "cause" in value ? value.cause : undefined;
  const causeCode = typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;
  return { name: value.name, message: value.message, ...(directCode ?? causeCode ? { code: directCode ?? causeCode } : {}) };
}
