import { csvForAudit, type AuditCsvRow } from "../admin/query";

const AUDIT_IP_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Export only pseudonymized IP values, even if an audit row is malformed. */
export function csvForSafeAudit(rows: AuditCsvRow[]): string {
  return csvForAudit(rows.map((row) => ({
    ...row,
    ipHash: row.ipHash && AUDIT_IP_HASH_PATTERN.test(row.ipHash) ? row.ipHash : null,
  })));
}
