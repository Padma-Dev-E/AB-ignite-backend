import type { ZodType } from "zod";
import type { SafeAiInput } from "./policy";
import type { AiProvider } from "./provider";

export type AiRunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
export type AiActorKind = "user" | "admin" | "system" | "ai";
export type AiProviderErrorCategory = "rate_limited" | "transient" | "auth" | "invalid_request" | "unknown";

export type AiActor = {
  kind: AiActorKind;
  id?: string;
};

export type AiUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type JsonSchema = {
  type?: string;
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
};

export type StructuredGenerationRequest = {
  model: string;
  systemPrompt: string;
  userContent: string;
  responseMimeType: "application/json";
  responseJsonSchema: JsonSchema;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
};

export type StructuredGenerationResponse = {
  text: string;
  usage?: AiUsage;
  finishReason?: string;
};

export type AiSafetyPolicy = {
  maxInputChars: number;
  allowedDataClassification: "public" | "internal" | "confidential" | "restricted";
  blockRestricted: boolean;
  blockSensitive: boolean;
};

export type AiJobDefinition<TInput, TOutput> = {
  key: string;
  version: string;
  model?: string;
  systemPrompt: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  responseJsonSchema: JsonSchema;
  buildInput: (input: TInput, safeInput: SafeAiInput) => string;
  safety: AiSafetyPolicy;
};

export type AiRunResult<TOutput> = {
  runId: string;
  jobKey: string;
  jobVersion: string;
  promptVersion: string;
  model: string;
  data: TOutput;
  attempts: number;
  latencyMs: number;
  usage?: AiUsage;
  finishReason?: string;
};

export type RunStructuredAiArgs<TInput> = {
  jobKey: string;
  ideaId: number;
  ideaVersionId?: number;
  input: TInput;
  actor: AiActor;
  correlationId: string;
  idempotencyKey: string;
};

export type AiRunnerDependencies = {
  provider: AiProvider;
  workerId?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  concurrency?: number;
};
