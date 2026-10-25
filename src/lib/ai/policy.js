import { createHash } from "node:crypto";
const classificationRank = { public: 0, internal: 1, confidential: 2, restricted: 3 };
const secretPatterns = [
    /AIza[0-9A-Za-z_-]{20,}/g,
    /-----BEGIN [A-Z ]+PRIVATE KEY-----/g,
    /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s,"']+/gi,
];
const promptInjectionPattern = /(?:ignore|disregard|bypass)\s+(?:all\s+)?(?:previous|prior|system|developer)\s+instructions|reveal\s+(?:the\s+)?(?:system|developer)\s+prompt/i;
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
function classificationOf(input) {
    if (!input || typeof input !== "object")
        return "internal";
    const value = input.dataClassification;
    return value === "public" || value === "internal" || value === "confidential" || value === "restricted" ? value : "internal";
}
export function evaluateAiInput(input, policy) {
    let raw;
    try {
        raw = JSON.stringify(input);
    }
    catch {
        return { allowed: false, code: "invalid_input", reason: "Input could not be serialized safely." };
    }
    if (raw.length > policy.maxInputChars) {
        return { allowed: false, code: "input_too_large", reason: "Input exceeded the configured size limit." };
    }
    const classification = classificationOf(input);
    if (policy.blockRestricted && classificationRank[classification] > classificationRank[policy.allowedDataClassification]) {
        return { allowed: false, code: "restricted_data", reason: "Input classification is not permitted for automated AI processing." };
    }
    if (promptInjectionPattern.test(raw)) {
        return { allowed: false, code: "prompt_injection", reason: "Input resembles an attempt to override model instructions." };
    }
    if (policy.blockSensitive && secretPatterns.some((pattern) => pattern.test(raw))) {
        return { allowed: false, code: "sensitive_data", reason: "Input appears to contain a credential or secret." };
    }
    const redactions = [];
    const serializedBody = raw.replace(emailPattern, () => {
        redactions.push("email");
        return "[REDACTED_EMAIL]";
    });
    const serialized = `<user_data>\n${serializedBody}\n</user_data>`;
    return {
        allowed: true,
        serialized,
        classification,
        contentHash: createHash("sha256").update(serialized).digest("hex"),
        redactions: Array.from(new Set(redactions)),
    };
}
