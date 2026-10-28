export class AiError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AiError";
    }
}
export class AiProviderError extends AiError {
    category;
    status;
    code;
    stage;
    constructor(category, message, metadata = {}) {
        super(message);
        this.name = "AiProviderError";
        this.category = category;
        this.status = metadata.status;
        this.code = metadata.code ?? "provider_error";
        this.stage = metadata.stage ?? "provider_request";
    }
}
export class AiProviderOutputError extends AiError {
    code;
    stage;
    constructor(message, metadata = {}) {
        super(message);
        this.name = "AiProviderOutputError";
        this.code = metadata.code ?? "provider_output_error";
        this.stage = metadata.stage ?? "response_parsing";
    }
}
export class AiSchemaValidationError extends AiError {
    constructor(message, options) {
        super(message, options);
        this.name = "AiSchemaValidationError";
    }
}
export class AiPolicyError extends AiError {
    code;
    constructor(code, message) {
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
    constructor(message) {
        super(message);
        this.name = "AiIdempotencyError";
    }
}
