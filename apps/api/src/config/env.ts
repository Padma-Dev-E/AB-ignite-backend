import { resolve } from "node:path";
import { REFRESH_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../../../src/auth/config.js";

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function optionalBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

const rawSecret = process.env.AUTH_SECRET ?? "";
if (rawSecret.length < 32) throw new Error("AUTH_SECRET must contain at least 32 characters.");
const internalApiToken = process.env.INTERNAL_API_TOKEN ?? "";
if (internalApiToken.length < 32) throw new Error("INTERNAL_API_TOKEN must contain at least 32 characters.");

const rawDatabaseUrl = process.env.DATABASE_URL ?? "./data/ab-ignite.db";
const databaseUrl = rawDatabaseUrl.startsWith("file:") ? rawDatabaseUrl.slice(5) : rawDatabaseUrl;
function secureAuthCookies(): boolean {
  const configuredUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  if (!configuredUrl) return process.env.NODE_ENV === "production";
  try {
    const url = new URL(configuredUrl);
    const localHost = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    return url.protocol === "https:" || !(url.protocol === "http:" && localHost);
  } catch {
    return process.env.NODE_ENV === "production";
  }
}

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV ?? "development",
  host: process.env.API_HOST ?? "0.0.0.0",
  port: positiveInteger("API_PORT", 4100),
  authSecret: rawSecret,
  internalApiToken,
  sessionCookieName: SESSION_COOKIE_NAME,
  refreshCookieName: REFRESH_COOKIE_NAME,
  secureCookies: secureAuthCookies(),
  databaseUrl: resolve(process.cwd(), databaseUrl),
  trustProxy: process.env.API_TRUST_PROXY ?? "127.0.0.1,::1",
  allowedOrigins: (process.env.API_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  maxBodyBytes: positiveInteger("API_MAX_BODY_BYTES", 1_048_576),
  logRequests: optionalBoolean("API_LOG_REQUESTS", process.env.NODE_ENV !== "production"),
  apigeeUrl: process.env.APIGEE_URL?.trim() || undefined,
  apigeeClientId: process.env.APIGEE_CLIENT_ID?.trim() || undefined,
});
