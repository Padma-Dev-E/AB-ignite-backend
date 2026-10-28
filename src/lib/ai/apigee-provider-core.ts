import { callApigeeAi } from "./apigee-client";
import type { AiConfig } from "./config-core";
import { AiProviderError, AiProviderOutputError, AiTimeoutError } from "./errors";
import { extractJsonOutput, unwrapJsonStringLayers } from "./json-output";
import type { AiProvider } from "./provider";
import type { JsonSchema, StructuredGenerationRequest, StructuredGenerationResponse } from "./types";

type ApigeeCall = <T = unknown>(config: AiConfig, body: unknown, diagnostic?: { runId?: number; attempt?: number }) => Promise<T>;

type ApigeePart = { text?: unknown };
type ApigeeCandidate = {
  content?: { parts?: ApigeePart[] };
  finishReason?: string;
};
type ApigeeEnvelope = {
  candidates?: unknown;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  promptFeedback?: { blockReason?: string };
};

type CandidateText = {
  text: string;
  finishReason?: string;
  usageMetadata?: ApigeeEnvelope["usageMetadata"];
};

const MAX_RESPONSE_NODES = 128;
const RESPONSE_WRAPPER_KEYS = ["data", "response", "result", "body", "output", "payload"] as const;

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
  const pending = [value];
  const envelopes: ApigeeEnvelope[] = [];
  let inspected = 0;
  const visited = new Set<object>();
  while (pending.length > 0 && inspected < MAX_RESPONSE_NODES) {
    const root = unwrapJsonStringLayers(pending.shift());
    inspected += 1;
    if (Array.isArray(root)) {
      pending.push(...root.slice(0, MAX_RESPONSE_NODES - inspected));
    } else if (root && typeof root === "object") {
      if (visited.has(root)) continue;
      visited.add(root);
      const envelope = root as ApigeeEnvelope;
      if (Array.isArray(envelope.candidates) || envelope.promptFeedback) envelopes.push(envelope);
      else {
        for (const key of RESPONSE_WRAPPER_KEYS) {
          const wrapped = (root as Record<string, unknown>)[key];
          if (wrapped !== undefined) pending.push(wrapped);
        }
      }
    }
  }
  return envelopes;
}

function safeReason(value: string) {
  return /^[A-Z_]{1,40}$/.test(value) ? value : "UNKNOWN";
}

function extractTexts(value: unknown): CandidateText[] {
  const texts: CandidateText[] = [];
  for (const envelope of responseEnvelopes(value)) {
    if (envelope.promptFeedback?.blockReason) throw new AiProviderOutputError(`APIGEE prompt was blocked (${safeReason(envelope.promptFeedback.blockReason)})`, { code: "provider_prompt_blocked", stage: "candidate_extraction" });
    if (!Array.isArray(envelope.candidates)) continue;
    for (const valueCandidate of envelope.candidates) {
      if (!valueCandidate || typeof valueCandidate !== "object") continue;
      const candidate = valueCandidate as ApigeeCandidate;
      const parts = candidate.content?.parts;
      if (!Array.isArray(parts)) continue;
      const text = parts.map((part) => part && typeof part.text === "string" ? part.text : "").join("").trim();
      if (text) texts.push({ text, finishReason: candidate.finishReason, usageMetadata: envelope.usageMetadata });
    }
  }
  return texts;
}

function incompleteCandidateError(finishReason: string) {
  return new AiProviderOutputError(`APIGEE candidate did not finish normally (${safeReason(finishReason)})`, { code: "provider_candidate_incomplete", stage: "candidate_extraction" });
}

function candidateWasComplete(candidate: CandidateText) {
  return !candidate.finishReason || ["STOP", "FINISH_REASON_UNSPECIFIED"].includes(candidate.finishReason);
}

function candidateSizeIsAllowed(candidate: CandidateText, maxOutputBytes: number) {
  return Buffer.byteLength(candidate.text.replace(/^\uFEFF/, "").trim(), "utf8") <= maxOutputBytes;
}

function missingCandidateTextError() {
  throw new AiProviderOutputError("APIGEE response did not contain candidate text", { code: "candidate_text_missing", stage: "candidate_extraction" });
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
      // Retry at the durable worker level so every provider call has a bounded
      // timeout and one persisted attempt. Nested retries could outlive the run
      // lease and multiply a single worker attempt into several slow calls.
      const attempt = request.attempt ?? 1;
      let candidates: CandidateText[];
      try {
        const response = await call<unknown>(config, {
          contents: {
            role: "user",
            parts: [{ text: promptText(request, request.responseJsonSchema) }],
          },
        }, { runId: request.runId, attempt });
        try { await updateDebugStage(config, request, attempt, { processingStage: "candidate_extraction" }); } catch { /* best effort */ }
        candidates = extractTexts(response);
        if (candidates.length === 0) missingCandidateTextError();
      } catch (error) {
        if (error instanceof AiProviderOutputError) {
          try { await updateDebugStage(config, request, attempt, { processingStage: error.stage, errorCode: error.code, errorMessage: error.message }); } catch { /* best effort */ }
        }
        if (error instanceof AiTimeoutError || error instanceof AiProviderError || error instanceof AiProviderOutputError) throw error;
        throw new AiProviderError("transient", "APIGEE request failed");
      }
      let extracted: CandidateText | undefined;
      let extractedJson: ReturnType<typeof extractJsonOutput>;
      let oversized = false;
      let incompleteReason: string | undefined;
      for (const candidate of candidates) {
        if (!candidateWasComplete(candidate)) {
          incompleteReason ??= candidate.finishReason;
          continue;
        }
        if (!candidateSizeIsAllowed(candidate, config.maxOutputBytes)) {
          oversized = true;
          continue;
        }
        const normalizedText = candidate.text.replace(/^\uFEFF/, "").trim();
        const parsed = extractJsonOutput(normalizedText);
        if (parsed) {
          extracted = candidate;
          extractedJson = parsed;
          break;
        }
      }
      if (!extracted && oversized && candidates.every((candidate) => !candidateWasComplete(candidate) || !candidateSizeIsAllowed(candidate, config.maxOutputBytes))) {
        try { await updateDebugStage(config, request, attempt, { processingStage: "output_size_limit", errorCode: "structured_output_too_large", errorMessage: "APIGEE structured output exceeded the configured size limit" }); } catch { /* best effort */ }
        throw new AiProviderOutputError("APIGEE structured output exceeded the configured size limit", { code: "structured_output_too_large", stage: "output_size_limit" });
      }
      if (!extractedJson) {
        if (incompleteReason && candidates.every((candidate) => !candidateWasComplete(candidate))) throw incompleteCandidateError(incompleteReason);
        try { await updateDebugStage(config, request, attempt, { processingStage: "model_json_parsing", errorCode: "model_output_not_json", errorMessage: "APIGEE returned malformed JSON" }); } catch { /* best effort */ }
        throw new AiProviderOutputError("APIGEE returned malformed JSON", { code: "model_output_not_json", stage: "model_json_parsing" });
      }
      const text = extractedJson.jsonText;
      try { await updateDebugStage(config, request, attempt, { processingStage: "schema_validation" }); } catch { /* best effort */ }

      return {
        text,
        usage: extracted?.usageMetadata ? {
          inputTokens: extracted.usageMetadata.promptTokenCount,
          outputTokens: extracted.usageMetadata.candidatesTokenCount,
        } : undefined,
        finishReason: extracted?.finishReason,
      } satisfies StructuredGenerationResponse;
    },
  };
}
