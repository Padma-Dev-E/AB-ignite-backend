import { redactAuditMetadata } from "../audit/redaction-core";

export class AdminInputError extends Error {
  readonly status = 400;
  readonly code = "validation_error";
}

export class AdminNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
}

export class AdminConflictError extends Error {
  readonly status = 409;
  readonly code = "conflict";
}

export function positiveId(value: string | null | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value)) throw new AdminInputError("A valid positive id is required.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AdminInputError("A valid positive id is required.");
  return parsed;
}

export function parsePage(url: URL, maxLimit: number) {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? Math.min(50, maxLimit) : positiveId(rawLimit);
  if (limit > maxLimit) throw new AdminInputError(`Limit must be at most ${maxLimit}.`);
  const rawAfter = url.searchParams.get("after");
  return { limit, after: rawAfter === null ? null : positiveId(rawAfter) };
}

export function optionalId(value: string | null): number | null {
  return value === null ? null : positiveId(value);
}

export function boundedFilter(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new AdminInputError("Invalid filter.");
  return trimmed;
}

export function directoryQuery(url: URL): string | null {
  return boundedFilter(url.searchParams.get("q"), 120);
}

export function safeAuditMetadata(json: string | null) {
  if (!json) return {};
  try { return redactAuditMetadata(JSON.parse(json)); } catch { return {}; }
}

export type AuditCsvRow = {
  id: number;
  createdAt: Date;
  actorUserId: number | null;
  sessionId: number | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  metadata: Record<string, string | number | boolean | null>;
  ipHash?: string | null;
};

function csvCell(value: unknown) {
  const original = value === null || value === undefined ? "" : String(value);
  const safe = /^[\s\u0000-\u001f]*[=+@-]/.test(original) ? `'${original}` : original;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function csvForAudit(rows: AuditCsvRow[]) {
  const header = "id,createdAt,actorUserId,sessionId,action,targetType,targetId,reason,metadata,ipHash\r\n";
  return header + rows.map((row) => [row.id, row.createdAt.toISOString(), row.actorUserId, row.sessionId, row.action, row.targetType, row.targetId, row.reason, JSON.stringify(row.metadata), row.ipHash].map(csvCell).join(",") + "\r\n").join("");
}

export function csvForRecords(headers: string[], rows: unknown[][]) {
  return `${headers.map(csvCell).join(",")}\r\n${rows.map((row) => row.map(csvCell).join(",") + "\r\n").join("")}`;
}
