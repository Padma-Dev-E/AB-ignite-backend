import { callApigeeAi } from "./apigee-client";
import type { AiConfig } from "./config-core";
import { AiProviderError, AiProviderOutputError, AiTimeoutError } from "./errors";
import type { AiProvider } from "./provider";
import type { JsonSchema, StructuredGenerationRequest, StructuredGenerationResponse } from "./types";

type ApigeeCall = <T = unknown>(config: AiConfig, body: unknown, diagnostic?: { runId?: number; attempt?: number }) => Promise<T>;

type ApigeePart = { text?: unknown };
type ApigeeCandidate = {
  content?: { parts?: ApigeePart[] };
  finishReason?: string;
};
type ApigeeEnvelope = {
  candidates?: ApigeeCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
};

export type ApigeeProviderDependencies = {
  call?: ApigeeCall;
};

function promptText(request: StructuredGenerationRequest, schema: JsonSchema) {
  return [
    `<system_instructions>\n${request.systemPrompt}\n</system_instructions>`,
    `<response_schema>\n${JSON.stringify(schema)}\n</response_schema>`,
    `<user_data>\n${request.userContent}\n</user_data>`,
    `<task>Use the supplied idea data to complete the task in the system instructions. Match every required field and type in the response schema. Return one JSON object only, with no Markdown, preamble, or additional keys. Keep the response complete and concise enough to fit within ${request.maxOutputTokens} tokens.</task>`,
  ].join("\n\n");
}

function responseEnvelopes(value: unknown): ApigeeEnvelope[] {
  const roots = Array.isArray(value) ? value : [value];
  return roots.filter((root): root is ApigeeEnvelope => Boolean(root) && typeof root === "object" && !Array.isArray(root));
}

function safeReason(value: string) {
  return /^[A-Z_]{1,40}$/.test(value) ? value : "UNKNOWN";
}

function extractText(value: unknown) {
  for (const envelope of responseEnvelopes(value)) {
    if (envelope.promptFeedback?.blockReason) throw new AiProviderOutputError(`APIGEE prompt was blocked (${safeReason(envelope.promptFeedback.blockReason)})`, { code: "provider_prompt_blocked", stage: "candidate_extraction" });
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

function removeJsonFence(text: string) {
  const match = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : text.trim();
}

function isRetryable(error: AiProviderError) {
  return error.category === "rate_limited" || error.category === "transient";
}

function delay(milliseconds: number) {
  return milliseconds > 0 ? new Promise<void>((resolve) => setTimeout(resolve, milliseconds)) : Promise.resolve();
}

async function updateDebugStage(config: AiConfig, request: StructuredGenerationRequest, attempt: number, update: { processingStage: string; errorCode?: string | null; errorMessage?: string | null }) {
  if (!config.aiDebugPayloads || !request.runId) return;
  const { updateAiDebugExchangeStage } = await import("./debug-exchanges");
  await updateAiDebugExchangeStage(config, request.runId, attempt, update);
}

export function createApigeeProvider(config: AiConfig, dependencies: ApigeeProviderDependencies = {}): AiProvider {
  const call = dependencies.call ?? callApigeeAi;

  return {
    async generateStructured(request) {
      let extracted: ReturnType<typeof extractText> | undefined;
      let lastError: AiProviderError | undefined;
      let lastAttempt = 0;

      for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
        lastAttempt = attempt;
        try {
          const response = await call<unknown>(config, {
            contents: {
              role: "user",
              parts: [{ text: promptText(request, request.responseJsonSchema) }],
            },
          }, { runId: request.runId, attempt });
          try { await updateDebugStage(config, request, attempt, { processingStage: "candidate_extraction" }); } catch { /* best effort */ }
          extracted = extractText(response);
          lastError = undefined;
          break;
        } catch (error) {
          if (error instanceof AiProviderOutputError) {
            try { await updateDebugStage(config, request, attempt, { processingStage: error.stage, errorCode: error.code, errorMessage: error.message }); } catch { /* best effort */ }
          }
          if (error instanceof AiTimeoutError) throw error;
          if (error instanceof AiProviderOutputError) throw error;
          const normalized = error instanceof AiProviderError
            ? error
            : new AiProviderError("transient", "APIGEE request failed");
          lastError = normalized;
          if (!isRetryable(normalized) || attempt === config.maxAttempts) throw normalized;
          const backoff = Math.min(config.retryInitialDelayMs * (2 ** (attempt - 1)), config.retryMaxDelayMs);
          await delay(backoff);
        }
      }

      if (!extracted || lastError) throw lastError ?? new AiProviderError("unknown", "APIGEE returned no response");
      const text = removeJsonFence(extracted.text);
      if (Buffer.byteLength(text, "utf8") > config.maxOutputBytes) {
        const attemptNumber = Math.max(1, lastAttempt);
        try { await updateDebugStage(config, request, attemptNumber, { processingStage: "output_size_limit", errorCode: "structured_output_too_large", errorMessage: "APIGEE structured output exceeded the configured size limit" }); } catch { /* best effort */ }
        throw new AiProviderOutputError("APIGEE structured output exceeded the configured size limit", { code: "structured_output_too_large", stage: "output_size_limit" });
      }
      try {
        JSON.parse(text);
      } catch {
        const attemptNumber = Math.max(1, lastAttempt);
        try { await updateDebugStage(config, request, attemptNumber, { processingStage: "model_json_parsing", errorCode: "model_output_not_json", errorMessage: "APIGEE returned malformed JSON" }); } catch { /* best effort */ }
        throw new AiProviderOutputError("APIGEE returned malformed JSON", { code: "model_output_not_json", stage: "model_json_parsing" });
      }
      const attemptNumber = Math.max(1, lastAttempt);
      try { await updateDebugStage(config, request, attemptNumber, { processingStage: "schema_validation" }); } catch { /* best effort */ }

      return {
        text,
        usage: extracted.usageMetadata ? {
          inputTokens: extracted.usageMetadata.promptTokenCount,
          outputTokens: extracted.usageMetadata.candidatesTokenCount,
        } : undefined,
        finishReason: extracted.finishReason,
      } satisfies StructuredGenerationResponse;
    },
  };
}
