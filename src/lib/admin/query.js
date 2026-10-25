import { redactAuditMetadata } from "../audit/redaction-core";
export class AdminInputError extends Error {
    status = 400;
    code = "validation_error";
}
export class AdminNotFoundError extends Error {
    status = 404;
    code = "not_found";
}
export class AdminConflictError extends Error {
    status = 409;
    code = "conflict";
}
export function positiveId(value) {
    if (!value || !/^[1-9]\d*$/.test(value))
        throw new AdminInputError("A valid positive id is required.");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
        throw new AdminInputError("A valid positive id is required.");
    return parsed;
}
export function parsePage(url, maxLimit) {
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? Math.min(50, maxLimit) : positiveId(rawLimit);
    if (limit > maxLimit)
        throw new AdminInputError(`Limit must be at most ${maxLimit}.`);
    const rawAfter = url.searchParams.get("after");
    return { limit, after: rawAfter === null ? null : positiveId(rawAfter) };
}
export function optionalId(value) {
    return value === null ? null : positiveId(value);
}
export function boundedFilter(value, maxLength) {
    if (value === null)
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength)
        throw new AdminInputError("Invalid filter.");
    return trimmed;
}
export function directoryQuery(url) {
    return boundedFilter(url.searchParams.get("q"), 120);
}
export function safeAuditMetadata(json) {
    if (!json)
        return {};
    try {
        return redactAuditMetadata(JSON.parse(json));
    }
    catch {
        return {};
    }
}
function csvCell(value) {
    const original = value === null || value === undefined ? "" : String(value);
    const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(original) ? `'${original}` : original;
    return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
export function csvForAudit(rows) {
    const header = "id,createdAt,actorUserId,sessionId,action,targetType,targetId,reason,metadata,ipHash\r\n";
    return header + rows.map((row) => [row.id, row.createdAt.toISOString(), row.actorUserId, row.sessionId, row.action, row.targetType, row.targetId, row.reason, JSON.stringify(row.metadata), row.ipHash].map(csvCell).join(",") + "\r\n").join("");
}
export function csvForRecords(headers, rows) {
    return `${headers.map(csvCell).join(",")}\r\n${rows.map((row) => row.map(csvCell).join(",") + "\r\n").join("")}`;
}
