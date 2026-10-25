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

  constructor(category: AiProviderErrorCategory, message: string, metadata: { status?: number } = {}) {
    super(message);
    this.name = "AiProviderError";
    this.category = category;
    this.status = metadata.status;
  }
}

export class AiProviderOutputError extends AiError {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderOutputError";
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
