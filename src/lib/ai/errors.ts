import type { AiProviderErrorCategory } from "./types";

export class AiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiError";
  }
}

export class AiProviderError extends AiError {
  readonly category: AiProviderErrorCategory;
  readonly status?: number;
  readonly code: string;
  readonly stage: string;

  constructor(category: AiProviderErrorCategory, message: string, metadata: { status?: number; code?: string; stage?: string } = {}) {
    super(message);
    this.name = "AiProviderError";
    this.category = category;
    this.status = metadata.status;
    this.code = metadata.code ?? "provider_error";
    this.stage = metadata.stage ?? "provider_request";
  }
}

export class AiProviderOutputError extends AiError {
  readonly code: string;
  readonly stage: string;

  constructor(message: string, metadata: { code?: string; stage?: string } = {}) {
    super(message);
    this.name = "AiProviderOutputError";
    this.code = metadata.code ?? "provider_output_error";
    this.stage = metadata.stage ?? "response_parsing";
  }
}

export class AiSchemaValidationError extends AiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiSchemaValidationError";
  }
}

export class AiPolicyError extends AiError {
  readonly code: "input_too_large" | "restricted_data" | "sensitive_data" | "prompt_injection";

  constructor(code: AiPolicyError["code"], message: string) {
    super(message);
    this.name = "AiPolicyError";
    this.code = code;
  }
}

export class AiTimeoutError extends AiError {
  constructor(message = "AI provider request timed out") {
    super(message);
    this.name = "AiTimeoutError";
  }
}

export class AiIdempotencyError extends AiError {
  constructor(message: string) {
    super(message);
    this.name = "AiIdempotencyError";
  }
}
