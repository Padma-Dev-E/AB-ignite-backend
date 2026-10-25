import { csvForRecords } from "./query";

export const IDEAS_EXPORT_HEADERS = [
  "id",
  "reference",
  "status",
  "priorityBand",
  "priorityScore",
  "authorId",
  "authorName",
  "department",
  "title",
  "summary",
  "benefits",
  "createdAt",
  "updatedAt",
] as const;

export const BENEFITS_EXPORT_HEADERS = [
  "id",
  "reference",
  "priorityScore",
  "priorityBand",
  "department",
  "benefits",
  "status",
  "updatedAt",
] as const;

export const FEEDBACK_EXPORT_HEADERS = [
  "id",
  "campaignId",
  "userId",
  "userName",
  "department",
  "category",
  "message",
  "response",
  "createdAt",
  "respondedAt",
] as const;

type ExportResponseInput = {
  filename: string;
  headers: readonly string[];
  rows: unknown[][];
  requestId: string;
  nextAfter?: number | null;
};

export function exportCsvResponse({
  filename,
  headers,
  rows,
  requestId,
  nextAfter,
}: ExportResponseInput) {
  const csv = csvForRecords([...headers], rows);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
      "x-request-id": requestId,
      ...(nextAfter ? { "x-next-after": String(nextAfter) } : {}),
    },
  });
}
