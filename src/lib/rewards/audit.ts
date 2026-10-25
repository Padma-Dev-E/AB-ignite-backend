import { auditEvents } from "../../db/schema";
import { requirePrivilegedReason } from "../auth/authorization-core";
import { hashAuditValue, serializeAuditMetadata } from "../audit/redaction-core";

export type RewardsAuditInput = {
  actorUserId?: number | null;
  sessionId?: number | null;
  action: string;
  targetType?: string | null;
  targetId?: number | string | null;
  reason?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requiresReason?: boolean;
};

export function buildRewardsAuditRecord(input: RewardsAuditInput, now = new Date()) {
  const reason = input.requiresReason ? requirePrivilegedReason(input.reason) : input.reason?.trim() || null;
  const action = input.action.trim();
  if (!action || action.length > 120) throw new Error("Audit action is invalid.");
  return {
    actorUserId: input.actorUserId ?? null,
    sessionId: input.sessionId ?? null,
    action,
    targetType: input.targetType?.trim().slice(0, 80) || null,
    targetId: input.targetId === undefined || input.targetId === null ? null : String(input.targetId).slice(0, 120),
    reason: reason ? reason.slice(0, 500) : null,
    metadataJson: serializeAuditMetadata(input.metadata),
    ipHash: hashAuditValue(input.ipAddress),
    userAgentHash: hashAuditValue(input.userAgent),
    createdAt: now,
  };
}

export { auditEvents };
