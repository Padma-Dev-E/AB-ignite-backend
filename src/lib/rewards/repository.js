import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { db } from "../../db/connection";
import { auditEvents, badges, levels, pointRules, pointsBalances, pointsLedger, rewardVersions, rewards, userBadges, } from "../../db/schema";
import { serializeAuditMetadata } from "../audit/redaction-core";
import { buildRewardsAuditRecord } from "./audit";
import { RewardsError } from "./errors";
export function withRewardsTransaction(callback) {
    return db.transaction(callback);
}
export function ensureBalanceProjection(tx, userId, now = new Date()) {
    tx.insert(pointsBalances).values({ userId, updatedAt: now }).onConflictDoNothing({ target: pointsBalances.userId }).run();
    const [balance] = tx.select().from(pointsBalances).where(eq(pointsBalances.userId, userId)).limit(1).all();
    if (!balance)
        throw new RewardsError("Points balance is unavailable.", "BALANCE_UNAVAILABLE", 500);
    return balance;
}
export function appendLedgerEntry(tx, input) {
    const [existing] = tx.select().from(pointsLedger).where(eq(pointsLedger.idempotencyKey, input.idempotencyKey)).limit(1).all();
    if (existing) {
        if (existing.userId !== input.userId || existing.amount !== input.amount || existing.eventType !== input.eventType || existing.sourceType !== input.sourceType || existing.sourceId !== (input.sourceId ?? null)) {
            throw new RewardsError("The idempotency key is already used for a different points entry.", "IDEMPOTENCY_CONFLICT");
        }
        return { ledger: existing, balance: ensureBalanceProjection(tx, input.userId) };
    }
    if (!Number.isInteger(input.amount) || input.amount <= 0)
        throw new RewardsError("Points awards must be a positive integer.", "INVALID_POINTS_AMOUNT", 400);
    const now = new Date();
    const current = ensureBalanceProjection(tx, input.userId, now);
    const [ledger] = tx.insert(pointsLedger).values({
        userId: input.userId,
        amount: input.amount,
        eventType: input.eventType,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey,
        metadataJson: serializeAuditMetadata(input.metadata),
        createdAt: now,
    }).returning().all();
    if (!ledger)
        throw new RewardsError("Points ledger entry was not created.", "LEDGER_WRITE_FAILED", 500);
    tx.update(pointsBalances).set({
        balance: sql `${pointsBalances.balance} + ${input.amount}`,
        totalEarned: sql `${pointsBalances.totalEarned} + ${input.amount}`,
        updatedAt: now,
    }).where(eq(pointsBalances.userId, input.userId)).run();
    const [balance] = tx.select().from(pointsBalances).where(eq(pointsBalances.userId, input.userId)).limit(1).all();
    if (!balance || balance.balance < 0)
        throw new RewardsError("Points balance cannot be negative.", "BALANCE_INVARIANT_FAILED", 500);
    tx.insert(auditEvents).values(buildRewardsAuditRecord({
        actorUserId: input.actorUserId ?? input.userId,
        sessionId: input.sessionId,
        action: input.auditAction ?? "points.ledger.appended",
        targetType: "points_ledger",
        targetId: ledger.id,
        metadata: { userId: input.userId, amount: input.amount, eventType: input.eventType, sourceType: input.sourceType, sourceId: input.sourceId ?? null },
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
    }, now)).run();
    return { ledger, balance };
}
export function getActivePointRule(tx, eventType) {
    const [rule] = tx.select().from(pointRules).where(and(eq(pointRules.code, eventType), eq(pointRules.active, true))).limit(1).all();
    return rule ?? null;
}
export function getCurrentRewardVersion(tx, rewardId) {
    const [version] = tx.select().from(rewardVersions).where(eq(rewardVersions.rewardId, rewardId)).orderBy(desc(rewardVersions.version)).limit(1).all();
    return version ?? null;
}
export async function getBalance(userId) {
    const [projection] = await db.select().from(pointsBalances).where(eq(pointsBalances.userId, userId)).limit(1).all();
    if (projection)
        return projection;
    const [row] = await db.select({ balance: sql `coalesce(sum(${pointsLedger.amount}), 0)` }).from(pointsLedger).where(eq(pointsLedger.userId, userId)).all();
    return { userId, balance: Number(row?.balance ?? 0), totalEarned: 0, updatedAt: new Date() };
}
export async function listPointHistory(userId, page = 1, pageSize = 20) {
    const limit = Math.min(Math.max(pageSize, 1), 50);
    const offset = (Math.max(page, 1) - 1) * limit;
    const [items, totalRow] = await Promise.all([
        db.select().from(pointsLedger).where(eq(pointsLedger.userId, userId)).orderBy(desc(pointsLedger.createdAt), desc(pointsLedger.id)).limit(limit).offset(offset).all(),
        db.select({ count: sql `count(*)` }).from(pointsLedger).where(eq(pointsLedger.userId, userId)).all(),
    ]);
    const total = Number(totalRow[0]?.count ?? 0);
    return { items, page: Math.max(page, 1), pageSize: limit, total, totalPages: Math.ceil(total / limit) };
}
export async function listRewardCatalogue() {
    return db.select().from(rewards).where(eq(rewards.active, true)).orderBy(asc(rewards.kind), asc(rewards.cost), asc(rewards.id)).all();
}
export async function listAllRewards() {
    return db.select().from(rewards).orderBy(asc(rewards.kind), asc(rewards.cost), asc(rewards.id)).all();
}
export async function getLevelForPoints(points) {
    const [level] = await db.select().from(levels).where(lte(levels.minimumPoints, Math.max(0, points))).orderBy(desc(levels.minimumPoints)).limit(1).all();
    return level ?? null;
}
export async function listBadgeProgress(userId) {
    const [definitions, awarded] = await Promise.all([
        db.select().from(badges).where(eq(badges.active, true)).orderBy(asc(badges.id)).all(),
        db.select().from(userBadges).where(eq(userBadges.userId, userId)).all(),
    ]);
    const awards = new Map(awarded.map((badge) => [badge.badgeId, badge]));
    return definitions.map((badge) => ({ ...badge, awarded: awards.get(badge.id) ?? null }));
}
