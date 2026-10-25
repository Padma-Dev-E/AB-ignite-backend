import { GoogleGenAI } from "@google/genai";
import { AiProviderError, AiProviderOutputError, AiTimeoutError } from "./errors";
function defaultClientFactory(config) {
    if (!config.apiKey)
        throw new AiProviderError("auth", "Gemini API key is not configured");
    return new GoogleGenAI({
        apiKey: config.apiKey,
        httpOptions: {
            ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
            timeout: config.timeoutMs,
            retryOptions: { attempts: 1, initialDelay: 0, maxDelay: 0, jitter: 0 },
        },
    });
}
function providerStatus(error) {
    if (!error || typeof error !== "object")
        return undefined;
    const value = error;
    for (const candidate of [value.status, value.statusCode, value.response?.status]) {
        if (typeof candidate === "number")
            return candidate;
    }
    return undefined;
}
function providerError(error) {
    const status = providerStatus(error);
    const category = status === 401 || status === 403
        ? "auth"
        : status === 429
            ? "rate_limited"
            : status === 400 || status === 422
                ? "invalid_request"
                : status === 408 || status === 409 || (status !== undefined && status >= 500)
                    ? "transient"
                    : "unknown";
    return new AiProviderError(category, "Gemini provider request failed", { status });
}
function isRetryable(error) {
    return error.category === "rate_limited" || error.category === "transient";
}
function delay(milliseconds) {
    return milliseconds > 0 ? new Promise((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}
async function withTimeout(operation, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new AiTimeoutError()), timeoutMs);
    });
    try {
        return await Promise.race([operation, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function requestPayload(request) {
    return {
        model: request.model,
        contents: request.userContent,
        config: {
            systemInstruction: request.systemPrompt,
            responseMimeType: request.responseMimeType,
            responseJsonSchema: request.responseJsonSchema,
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature,
        },
    };
}
export function createGeminiProvider(config, dependencies = {}) {
    const client = (dependencies.clientFactory ?? defaultClientFactory)(config);
    return {
        async generateStructured(request) {
            let response;
            let lastError;
            for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
                try {
                    response = await withTimeout(client.models.generateContent(requestPayload(request)), request.timeoutMs);
                    lastError = undefined;
                    break;
                }
                catch (error) {
                    if (error instanceof AiTimeoutError)
                        throw error;
                    const normalized = error instanceof AiProviderError ? error : providerError(error);
                    lastError = normalized;
                    if (!isRetryable(normalized) || attempt === config.maxAttempts)
                        throw normalized;
                    const backoff = Math.min(config.retryInitialDelayMs * (2 ** (attempt - 1)), config.retryMaxDelayMs);
                    await delay(backoff);
                }
            }
            if (!response || lastError)
                throw lastError ?? new AiProviderError("unknown", "Gemini returned no response");
            if (typeof response.text !== "string" || response.text.trim() === "") {
                throw new AiProviderOutputError("Gemini returned no structured output");
            }
            if (Buffer.byteLength(response.text, "utf8") > config.maxOutputBytes) {
                throw new AiProviderOutputError("Gemini structured output exceeded the configured size limit");
            }
            try {
                JSON.parse(response.text);
            }
            catch {
                throw new AiProviderOutputError("Gemini returned malformed JSON");
            }
            return {
                text: response.text,
                usage: response.usageMetadata ? {
                    inputTokens: response.usageMetadata.promptTokenCount,
                    outputTokens: response.usageMetadata.candidatesTokenCount,
                } : undefined,
                finishReason: response.candidates?.[0]?.finishReason,
            };
        },
    };
}
