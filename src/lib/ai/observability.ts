import { AiPolicyError, AiProviderError, AiProviderOutputError, AiSchemaValidationError, AiTimeoutError } from "./errors";

export type SafeErrorMetadata = {
  code: string;
  message: string;
  status?: number;
  category?: string;
};

export function redactAiError(error: unknown): SafeErrorMetadata {
  if (error instanceof AiProviderError) {
    return { code: "provider_error", message: "AI provider request failed", status: error.status, category: error.category };
  }
  if (error instanceof AiTimeoutError) return { code: "timeout", message: "AI provider request timed out" };
  if (error instanceof AiProviderOutputError) return { code: "provider_output_error", message: "AI provider returned invalid output" };
  if (error instanceof AiSchemaValidationError) return { code: "schema_validation_error", message: "AI output did not match the expected format" };
  if (error instanceof AiPolicyError) return { code: error.code, message: "AI input was blocked by policy" };
  if (error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number") {
    return { code: "provider_error", message: "AI provider request failed", status: (error as { status: number }).status };
  }
  return { code: "unknown", message: "AI request failed" };
}
