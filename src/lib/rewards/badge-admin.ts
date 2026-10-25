import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/connection";
import { auditEvents, badgeAdminOperations, badges, pointRules, refreshTokens, users } from "../../db/schema";
import { isSessionActive } from "../../auth/security-core";
import { AuthorizationError, requirePrivilegedReason } from "../auth/authorization-core";
import { buildRewardsAuditRecord } from "./audit";
import { RewardsError } from "./errors";
import { withRewardsTransaction, type RewardsTx } from "./repository";

export const badgeRuleInputSchema = z.strictObject({
  code: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500),
  eventTypes: z.array(z.string().trim().regex(/^[a-z][a-z0-9_]{0,99}$/)).min(1).max(10),
  minimumCount: z.number().int().min(1).max(1_000_000),
  active: z.boolean(),
}).refine((input) => new Set(input.eventTypes).size === input.eventTypes.length, { message: "Event types must be unique.", path: ["eventTypes"] });

export type BadgeRuleInput = z.infer<typeof badgeRuleInputSchema>;
export type BadgeAdminActor = {
  userId: number;
  sessionId: number;
  reason: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
};
type BadgeAction = "create" | "update";

function assertAdmin(tx: RewardsTx, actor: BadgeAdminActor, now: Date) {
  if (!Number.isSafeInteger(actor.userId) || actor.userId < 1 || !Number.isSafeInteger(actor.sessionId) || actor.sessionId < 1) throw new AuthorizationError("Administrator session is invalid.");
  const user = tx.select().from(users).where(eq(users.id, actor.userId)).get();
  const session = tx.select().from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).get();
  if (!user || user.role !== "back_office" || !user.isActive || !session || session.userId !== user.id || !isSessionActive(session, user, now)) throw new AuthorizationError("Administrator session is no longer valid.");
}

function requestKey(value: string) {
  if (typeof value !== "string" || value.length < 8 || value.length > 200 || !/^[\x21-\x7e]+$/.test(value)) throw new RewardsError("A valid idempotency key is required.", "VALIDATION_ERROR", 400);
  return createHash("sha256").update(value).digest("hex");
}

function fingerprint(action: BadgeAction, actorId: number, badgeId: number | null, input: BadgeRuleInput, reason: string) {
  return createHash("sha256").update(JSON.stringify({ action, actorId, badgeId, input, reason })).digest("hex");
}

function normalize(input: unknown) {
  const parsed = badgeRuleInputSchema.parse(input);
  return { ...parsed, eventTypes: [...parsed.eventTypes].sort() };
}

function validateEventTypes(tx: RewardsTx, eventTypes: string[]) {
  const matching = tx.select({ code: pointRules.code }).from(pointRules).where(inArray(pointRules.code, eventTypes)).all();
  if (matching.length !== eventTypes.length) throw new RewardsError("Badge event types must match configured points events.", "VALIDATION_ERROR", 400);
}

function view(badge: typeof badges.$inferSelect) {
  return { ...badge, createdAt: badge.createdAt.toISOString(), updatedAt: badge.updatedAt.toISOString() };
}

function replay(tx: RewardsTx, keyHash: string, requestHash: string, actorId: number, action: BadgeAction) {
  const prior = tx.select().from(badgeAdminOperations).where(eq(badgeAdminOperations.keyHash, keyHash)).get();
  if (!prior) return null;
  if (prior.requestHash !== requestHash || prior.actorUserId !== actorId || prior.action !== action) throw new RewardsError("Idempotency key was used for a different badge request.", "IDEMPOTENCY_CONFLICT", 409);
  return JSON.parse(prior.responseJson) as ReturnType<typeof view>;
}

function record(tx: RewardsTx, actor: BadgeAdminActor, now: Date, badge: typeof badges.$inferSelect, action: BadgeAction, reason: string, keyHash: string, requestHash: string) {
  const response = view(badge);
  tx.insert(badgeAdminOperations).values({ keyHash, actorUserId: actor.userId, badgeId: badge.id, action, requestHash, responseJson: JSON.stringify(response), createdAt: now }).run();
  tx.insert(auditEvents).values(buildRewardsAuditRecord({
    actorUserId: actor.userId,
    sessionId: actor.sessionId,
    ipAddress: actor.ipAddress,
    userAgent: actor.userAgent,
    action: `badge.rule.${action === "create" ? "created" : "updated"}`,
    targetType: "badge",
    targetId: badge.id,
    reason,
    metadata: { status: action === "create" ? "created" : "updated", resourceType: "badge", resourceId: badge.id },
    requiresReason: true,
  }, now)).run();
  return response;
}

export async function listAdminBadgeRules(page: { limit: number; after: number | null }) {
  if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 100 || (page.after !== null && (!Number.isSafeInteger(page.after) || page.after < 1))) throw new RewardsError("Invalid badge page.", "VALIDATION_ERROR", 400);
  const rows = db.select().from(badges).where(page.after === null ? undefined : gt(badges.id, page.after)).orderBy(asc(badges.id)).limit(page.limit + 1).all();
  const availableEvents = db.select({ code: pointRules.code, name: pointRules.name, active: pointRules.active }).from(pointRules).orderBy(asc(pointRules.code)).all();
  return { items: rows.slice(0, page.limit).map(view), nextAfter: rows.length > page.limit ? rows[page.limit - 1].id : null, availableEvents };
}

export async function createAdminBadgeRule(actor: BadgeAdminActor, rawInput: unknown, idempotencyKey: string) {
  const input = normalize(rawInput);
  const reason = requirePrivilegedReason(actor.reason);
  const keyHash = requestKey(idempotencyKey);
  const requestHash = fingerprint("create", actor.userId, null, input, reason);
  return withRewardsTransaction((tx) => {
    const now = new Date();
    assertAdmin(tx, actor, now);
    const prior = replay(tx, keyHash, requestHash, actor.userId, "create");
    if (prior) return prior;
    validateEventTypes(tx, input.eventTypes);
    if (tx.select({ id: badges.id }).from(badges).where(eq(badges.code, input.code)).get()) throw new RewardsError("Badge code already exists.", "BADGE_CODE_EXISTS", 409);
    const [badge] = tx.insert(badges).values({ code: input.code, name: input.name, description: input.description, ruleJson: JSON.stringify({ eventTypes: input.eventTypes, minimumCount: input.minimumCount }), active: input.active, createdAt: now, updatedAt: now }).returning().all();
    if (!badge) throw new RewardsError("Badge rule was not created.", "BADGE_WRITE_FAILED", 500);
    return record(tx, actor, now, badge, "create", reason, keyHash, requestHash);
  });
}

export async function updateAdminBadgeRule(actor: BadgeAdminActor, badgeId: number, rawInput: unknown, idempotencyKey: string) {
  if (!Number.isSafeInteger(badgeId) || badgeId < 1) throw new RewardsError("Invalid badge ID.", "VALIDATION_ERROR", 400);
  const input = normalize(rawInput);
  const reason = requirePrivilegedReason(actor.reason);
  const keyHash = requestKey(idempotencyKey);
  const requestHash = fingerprint("update", actor.userId, badgeId, input, reason);
  return withRewardsTransaction((tx) => {
    const now = new Date();
    assertAdmin(tx, actor, now);
    const prior = replay(tx, keyHash, requestHash, actor.userId, "update");
    if (prior) return prior;
    const current = tx.select().from(badges).where(eq(badges.id, badgeId)).get();
    if (!current) throw new RewardsError("Badge rule not found.", "BADGE_NOT_FOUND", 404);
    validateEventTypes(tx, input.eventTypes);
    const codeOwner = tx.select({ id: badges.id }).from(badges).where(eq(badges.code, input.code)).get();
    if (codeOwner && codeOwner.id !== badgeId) throw new RewardsError("Badge code already exists.", "BADGE_CODE_EXISTS", 409);
    const [badge] = tx.update(badges).set({ code: input.code, name: input.name, description: input.description, ruleJson: JSON.stringify({ eventTypes: input.eventTypes, minimumCount: input.minimumCount }), active: input.active, updatedAt: now }).where(and(eq(badges.id, badgeId), eq(badges.updatedAt, current.updatedAt))).returning().all();
    if (!badge) throw new RewardsError("Badge rule changed during update.", "BADGE_CONFLICT", 409);
    return record(tx, actor, now, badge, "update", reason, keyHash, requestHash);
  });
}
