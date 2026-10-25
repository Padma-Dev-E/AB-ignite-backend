export class AiError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "AiError";
    }
}
export class AiProviderError extends AiError {
    category;
    status;
    constructor(category, message, metadata = {}) {
        super(message);
        this.name = "AiProviderError";
        this.category = category;
        this.status = metadata.status;
    }
}
export class AiProviderOutputError extends AiError {
    constructor(message) {
        super(message);
        this.name = "AiProviderOutputError";
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
