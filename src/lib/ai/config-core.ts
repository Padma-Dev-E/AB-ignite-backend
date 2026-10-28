export type AiDataClassification = "public" | "internal" | "confidential" | "restricted";

export type AiConfig = {
  model: string;
  apigeeUrl?: string;
  apigeeClientId?: string;
  skipSslAiCalls: boolean;
  timeoutMs: number;
  maxAttempts: number;
  retryInitialDelayMs: number;
  retryMaxDelayMs: number;
  maxOutputTokens: number;
  temperature: number;
  maxInputChars: number;
  maxOutputBytes: number;
  allowedDataClassification: AiDataClassification;
  logSensitive: boolean;
  rateLimitPerUser: number;
  globalConcurrency: number;
  retentionDays: number;
};

const DEFAULTS = {
  model: "apigee",
  timeoutMs: 30_000,
  maxAttempts: 3,
  retryInitialDelayMs: 250,
  retryMaxDelayMs: 4_000,
  maxOutputTokens: 4_096,
  temperature: 0,
  maxInputChars: 30_000,
  maxOutputBytes: 200_000,
  rateLimitPerUser: 20,
  globalConcurrency: 4,
  retentionDays: 90,
} as const;

function invalidConfiguration(name: string, value: string | undefined): never {
  throw new Error(`Invalid AI configuration for ${name}: ${value ?? "missing"}`);
}

function numberValue(name: string, fallback: number, options: { integer?: boolean; min?: number; max?: number } = {}, legacyName?: string) {
  const raw = process.env[name] ?? (legacyName ? process.env[legacyName] : undefined);
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  const isInteger = options.integer !== false && !Number.isInteger(value);
  const outOfRange = (options.min !== undefined && value < options.min) || (options.max !== undefined && value > options.max);
  if (!Number.isFinite(value) || isInteger || outOfRange) {
    if (process.env.NODE_ENV === "production") invalidConfiguration(name, raw);
    return fallback;
  }
  return value;
}

function classificationValue(): AiDataClassification {
  const value = process.env.AI_ALLOWED_DATA_CLASSIFICATION ?? "internal";
  if (["public", "internal", "confidential", "restricted"].includes(value)) return value as AiDataClassification;
  if (process.env.NODE_ENV === "production") invalidConfiguration("AI_ALLOWED_DATA_CLASSIFICATION", value);
  return "internal";
}

function booleanValue(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (process.env.NODE_ENV === "production") invalidConfiguration(name, raw);
  return fallback;
}

export function getAiConfig(): AiConfig {
  return {
    model: DEFAULTS.model,
    apigeeUrl: process.env.APIGEE_URL?.trim() || undefined,
    apigeeClientId: process.env.APIGEE_CLIENT_ID?.trim() || undefined,
    skipSslAiCalls: booleanValue("SKIP_SSL_AI_CALLS", false),
    timeoutMs: numberValue("AI_TIMEOUT_MS", DEFAULTS.timeoutMs, { min: 1_000 }, "GEMINI_TIMEOUT_MS"),
    maxAttempts: numberValue("AI_MAX_ATTEMPTS", DEFAULTS.maxAttempts, { min: 1, max: 10 }, "GEMINI_MAX_ATTEMPTS"),
    retryInitialDelayMs: numberValue("AI_RETRY_INITIAL_DELAY_MS", DEFAULTS.retryInitialDelayMs, { min: 0 }, "GEMINI_RETRY_INITIAL_DELAY_MS"),
    retryMaxDelayMs: numberValue("AI_RETRY_MAX_DELAY_MS", DEFAULTS.retryMaxDelayMs, { min: 0 }, "GEMINI_RETRY_MAX_DELAY_MS"),
    maxOutputTokens: numberValue("AI_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens, { min: 1, max: 32_768 }, "GEMINI_MAX_OUTPUT_TOKENS"),
    temperature: numberValue("AI_TEMPERATURE", DEFAULTS.temperature, { integer: false, min: 0, max: 2 }, "GEMINI_TEMPERATURE"),
    maxInputChars: numberValue("AI_MAX_INPUT_CHARS", DEFAULTS.maxInputChars, { min: 1_000 }),
    maxOutputBytes: numberValue("AI_MAX_OUTPUT_BYTES", DEFAULTS.maxOutputBytes, { min: 1_024 }),
    allowedDataClassification: classificationValue(),
    logSensitive: booleanValue("AI_LOG_SENSITIVE", false),
    rateLimitPerUser: numberValue("AI_RATE_LIMIT_PER_USER", DEFAULTS.rateLimitPerUser, { min: 1 }),
    globalConcurrency: numberValue("AI_GLOBAL_CONCURRENCY", DEFAULTS.globalConcurrency, { min: 1 }),
    retentionDays: numberValue("AI_RETENTION_DAYS", DEFAULTS.retentionDays, { min: 1 }),
  };
}
