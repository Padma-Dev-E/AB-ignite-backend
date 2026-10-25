import { createHmac } from "node:crypto";
import { authSecret } from "../../auth/config";
const AUDIT_HASH_SECRET = process.env.AUTH_AUDIT_HASH_SECRET ?? authSecret;
const MAX_STRING_LENGTH = 240;
const MAX_METADATA_KEYS = 20;
const ALLOWED_METADATA_KEYS = new Set([
    "status",
    "fromStatus",
    "toStatus",
    "attempt",
    "attempts",
    "result",
    "reasonCode",
    "resourceType",
    "resourceId",
    "controlName",
    "permission",
    "provider",
    "requestId",
]);
export function hashAuditValue(value) {
    if (!value)
        return null;
    return createHmac("sha256", AUDIT_HASH_SECRET || "local-audit-secret")
        .update(value.trim())
        .digest("hex");
}
function safeValue(value) {
    if (typeof value === "string")
        return value.slice(0, MAX_STRING_LENGTH);
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "boolean")
        return value;
    return null;
}
export function redactAuditMetadata(metadata) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
        return {};
    const result = {};
    for (const [key, value] of Object.entries(metadata).slice(0, MAX_METADATA_KEYS)) {
        if (!ALLOWED_METADATA_KEYS.has(key))
            continue;
        const safe = safeValue(value);
        if (safe !== null)
            result[key] = safe;
    }
    return result;
}
export function serializeAuditMetadata(metadata) {
    const redacted = redactAuditMetadata(metadata);
    return Object.keys(redacted).length ? JSON.stringify(redacted) : null;
}
