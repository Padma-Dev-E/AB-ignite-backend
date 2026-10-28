import { callApigeeAi } from "./apigee-client";
import { AiProviderError, AiProviderOutputError, AiTimeoutError } from "./errors";
function promptText(request, schema) {
    return [
        `<system_instructions>\n${request.systemPrompt}\n</system_instructions>`,
        `<response_schema>\n${JSON.stringify(schema)}\n</response_schema>`,
        `<user_data>\n${request.userContent}\n</user_data>`,
        `<task>Use the supplied idea data to complete the task in the system instructions. Match every required field and type in the response schema. Return one JSON object only, with no Markdown, preamble, or additional keys. Keep the response complete and concise enough to fit within ${request.maxOutputTokens} tokens.</task>`,
    ].join("\n\n");
}
function responseEnvelopes(value) {
    const roots = Array.isArray(value) ? value : [value];
    return roots.filter((root) => Boolean(root) && typeof root === "object" && !Array.isArray(root));
}
function safeReason(value) {
    return /^[A-Z_]{1,40}$/.test(value) ? value : "UNKNOWN";
}
function extractText(value) {
    for (const envelope of responseEnvelopes(value)) {
        if (envelope.promptFeedback?.blockReason)
            throw new AiProviderOutputError(`APIGEE prompt was blocked (${safeReason(envelope.promptFeedback.blockReason)})`, { code: "provider_prompt_blocked", stage: "candidate_extraction" });
        for (const candidate of envelope.candidates ?? []) {
            const text = candidate.content?.parts?.map((part) => typeof part.text === "string" ? part.text : "").join("").trim();
            if (text) {
                if (candidate.finishReason && !["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason)) {
                    throw new AiProviderOutputError(`APIGEE candidate did not finish normally (${safeReason(candidate.finishReason)})`, { code: "provider_candidate_incomplete", stage: "candidate_extraction" });
                }
                return { text, finishReason: candidate.finishReason, usageMetadata: envelope.usageMetadata };
            }
        }
    }
    throw new AiProviderOutputError("APIGEE response did not contain candidate text", { code: "candidate_text_missing", stage: "candidate_extraction" });
}
function removeJsonFence(text) {
    const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : text.trim();
}
async function updateDebugStage(config, request, attempt, update) {
    if (!config.aiDebugPayloads || !request.runId)
        return;
    const { updateAiDebugExchangeStage } = await import("./debug-exchanges");
    await updateAiDebugExchangeStage(config, request.runId, attempt, update);
}
export function createApigeeProvider(config, dependencies = {}) {
    const call = dependencies.call ?? callApigeeAi;
    return {
        async generateStructured(request) {
            // Retry at the durable worker level so every provider call has a bounded
            // timeout and one persisted attempt. Nested retries could outlive the run
            // lease and multiply a single worker attempt into several slow calls.
            const attempt = request.attempt ?? 1;
            let extracted;
            try {
                const response = await call(config, {
                    contents: {
                        role: "user",
                        parts: [{ text: promptText(request, request.responseJsonSchema) }],
                    },
                }, { runId: request.runId, attempt });
                try {
                    await updateDebugStage(config, request, attempt, { processingStage: "candidate_extraction" });
                }
                catch { /* best effort */ }
                extracted = extractText(response);
            }
            catch (error) {
                if (error instanceof AiProviderOutputError) {
                    try {
                        await updateDebugStage(config, request, attempt, { processingStage: error.stage, errorCode: error.code, errorMessage: error.message });
                    }
                    catch { /* best effort */ }
                }
                if (error instanceof AiTimeoutError || error instanceof AiProviderError || error instanceof AiProviderOutputError)
                    throw error;
                throw new AiProviderError("transient", "APIGEE request failed");
            }
            const text = removeJsonFence(extracted.text);
            if (Buffer.byteLength(text, "utf8") > config.maxOutputBytes) {
                try {
                    await updateDebugStage(config, request, attempt, { processingStage: "output_size_limit", errorCode: "structured_output_too_large", errorMessage: "APIGEE structured output exceeded the configured size limit" });
                }
                catch { /* best effort */ }
                throw new AiProviderOutputError("APIGEE structured output exceeded the configured size limit", { code: "structured_output_too_large", stage: "output_size_limit" });
            }
            try {
                JSON.parse(text);
            }
            catch {
                try {
                    await updateDebugStage(config, request, attempt, { processingStage: "model_json_parsing", errorCode: "model_output_not_json", errorMessage: "APIGEE returned malformed JSON" });
                }
                catch { /* best effort */ }
                throw new AiProviderOutputError("APIGEE returned malformed JSON", { code: "model_output_not_json", stage: "model_json_parsing" });
            }
            try {
                await updateDebugStage(config, request, attempt, { processingStage: "schema_validation" });
            }
            catch { /* best effort */ }
            return {
                text,
                usage: extracted.usageMetadata ? {
                    inputTokens: extracted.usageMetadata.promptTokenCount,
                    outputTokens: extracted.usageMetadata.candidatesTokenCount,
                } : undefined,
                finishReason: extracted.finishReason,
            };
        },
    };
}
