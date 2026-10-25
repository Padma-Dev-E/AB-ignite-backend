const DEFAULTS = {
    model: "gemini-3.8-flash",
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
};
function invalidConfiguration(name, value) {
    throw new Error(`Invalid AI configuration for ${name}: ${value ?? "missing"}`);
}
function numberValue(name, fallback, options = {}) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "")
        return fallback;
    const value = Number(raw);
    const isInteger = options.integer !== false && !Number.isInteger(value);
    const outOfRange = (options.min !== undefined && value < options.min) || (options.max !== undefined && value > options.max);
    if (!Number.isFinite(value) || isInteger || outOfRange) {
        if (process.env.NODE_ENV === "production")
            invalidConfiguration(name, raw);
        return fallback;
    }
    return value;
}
function classificationValue() {
    const value = process.env.AI_ALLOWED_DATA_CLASSIFICATION ?? "internal";
    if (["public", "internal", "confidential", "restricted"].includes(value))
        return value;
    if (process.env.NODE_ENV === "production")
        invalidConfiguration("AI_ALLOWED_DATA_CLASSIFICATION", value);
    return "internal";
}
function booleanValue(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "")
        return fallback;
    if (raw === "true")
        return true;
    if (raw === "false")
        return false;
    if (process.env.NODE_ENV === "production")
        invalidConfiguration(name, raw);
    return fallback;
}
export function getAiConfig() {
    return {
        apiKey: process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY,
        model: process.env.GEMINI_MODEL?.trim() || DEFAULTS.model,
        baseUrl: process.env.GEMINI_API_BASE_URL?.trim() || undefined,
        timeoutMs: numberValue("GEMINI_TIMEOUT_MS", DEFAULTS.timeoutMs, { min: 1_000 }),
        maxAttempts: numberValue("GEMINI_MAX_ATTEMPTS", DEFAULTS.maxAttempts, { min: 1, max: 10 }),
        retryInitialDelayMs: numberValue("GEMINI_RETRY_INITIAL_DELAY_MS", DEFAULTS.retryInitialDelayMs, { min: 0 }),
        retryMaxDelayMs: numberValue("GEMINI_RETRY_MAX_DELAY_MS", DEFAULTS.retryMaxDelayMs, { min: 0 }),
        maxOutputTokens: numberValue("GEMINI_MAX_OUTPUT_TOKENS", DEFAULTS.maxOutputTokens, { min: 1, max: 32_768 }),
        temperature: numberValue("GEMINI_TEMPERATURE", DEFAULTS.temperature, { integer: false, min: 0, max: 2 }),
        maxInputChars: numberValue("AI_MAX_INPUT_CHARS", DEFAULTS.maxInputChars, { min: 1_000 }),
        maxOutputBytes: numberValue("AI_MAX_OUTPUT_BYTES", DEFAULTS.maxOutputBytes, { min: 1_024 }),
        allowedDataClassification: classificationValue(),
        logSensitive: booleanValue("AI_LOG_SENSITIVE", false),
        rateLimitPerUser: numberValue("AI_RATE_LIMIT_PER_USER", DEFAULTS.rateLimitPerUser, { min: 1 }),
        globalConcurrency: numberValue("AI_GLOBAL_CONCURRENCY", DEFAULTS.globalConcurrency, { min: 1 }),
        retentionDays: numberValue("AI_RETENTION_DAYS", DEFAULTS.retentionDays, { min: 1 }),
    };
}
