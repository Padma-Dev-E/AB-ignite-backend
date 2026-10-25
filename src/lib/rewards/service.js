import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { auditEvents, badges, pointsLedger, rewardVersions, rewards, userBadges, } from "../../db/schema";
import { buildRewardsAuditRecord } from "./audit";
import { appendLedgerEntry, getBalance as getBalanceRecord, getActivePointRule, getCurrentRewardVersion, getLevelForPoints as getLevelRecord, listAllRewards, listRewardCatalogue, listBadgeProgress, listPointHistory, withRewardsTransaction, } from "./repository";
import { RewardsError } from "./errors";
import { parseBadgeRule, REWARD_KINDS } from "./rules";
function validId(value, label) {
    if (!Number.isInteger(value) || value < 1)
        throw new RewardsError(`Invalid ${label}.`, "VALIDATION_ERROR", 400);
    return value;
}
function requiredText(value, label, max = 200) {
    const text = value.trim();
    if (!text || text.length > max)
        throw new RewardsError(`${label} is invalid.`, "VALIDATION_ERROR", 400);
    return text;
}
function positiveInteger(value, label) {
    if (!Number.isInteger(value) || value < 1)
        throw new RewardsError(`${label} must be a positive integer.`, "VALIDATION_ERROR", 400);
    return value;
}
export function evaluateBadgeAwards(tx, userId, actorUserId = userId, now = new Date()) {
    const definitions = tx.select().from(badges).where(eq(badges.active, true)).orderBy(asc(badges.id)).all();
    const existing = new Set(tx.select({ badgeId: userBadges.badgeId }).from(userBadges).where(eq(userBadges.userId, userId)).all().map((row) => row.badgeId));
    const awarded = [];
    for (const badge of definitions) {
        if (existing.has(badge.id))
            continue;
        const rule = parseBadgeRule(badge.ruleJson);
        const eventTypes = (rule.eventTypes ?? []).flatMap((eventType) => eventType === "idea_submitted" ? ["idea_submitted", "idea_submission"] : [eventType]);
        const [{ count }] = tx.select({ count: sql `count(*)` })
            .from(pointsLedger)
            .where(and(eq(pointsLedger.userId, userId), inArray(pointsLedger.eventType, eventTypes)))
            .all();
        if (Number(count ?? 0) < rule.minimumCount)
            continue;
        const [userBadge] = tx.insert(userBadges).values({ userId, badgeId: badge.id, awardedAt: now }).onConflictDoNothing({ target: [userBadges.userId, userBadges.badgeId] }).returning().all();
        if (!userBadge)
            continue;
        tx.insert(auditEvents).values(buildRewardsAuditRecord({
            actorUserId,
            action: "badge.awarded",
            targetType: "user_badge",
            targetId: userBadge.id,
            metadata: { status: "awarded", reasonCode: badge.code },
        }, now)).run();
        awarded.push(userBadge);
    }
    return awarded;
}
export async function awardPoints(input) {
    validId(input.userId, "user ID");
    const eventType = requiredText(input.eventType, "Event type", 100);
    const sourceType = requiredText(input.sourceType, "Source type", 100);
    const idempotencyKey = requiredText(input.idempotencyKey, "Idempotency key", 200);
    const result = withRewardsTransaction((tx) => {
        if (input.amount > 0) {
            const rule = getActivePointRule(tx, eventType);
            if (!rule)
                throw new RewardsError("No active points rule exists for this event.", "POINT_RULE_NOT_FOUND", 409);
            if (input.amount !== rule.points)
                throw new RewardsError("The points amount does not match the active rule.", "POINT_RULE_MISMATCH", 409);
        }
        const entry = appendLedgerEntry(tx, { ...input, eventType, sourceType, idempotencyKey });
        const awarded = evaluateBadgeAwards(tx, input.userId, input.actorUserId ?? input.userId);
        return { ...entry, awarded };
    });
    const level = await getLevelRecord(result.balance.balance);
    return { ...result, level };
}
export async function getBalance(userId) {
    validId(userId, "user ID");
    return getBalanceRecord(userId);
}
export async function getPointsHistory(userId, page = 1, pageSize = 20) {
    validId(userId, "user ID");
    return listPointHistory(userId, page, pageSize);
}
export async function getLevelForPoints(points) {
    if (!Number.isFinite(points) || points < 0)
        throw new RewardsError("Points value is invalid.", "VALIDATION_ERROR", 400);
    return getLevelRecord(Math.floor(points));
}
export async function getBadgeProgress(userId) {
    validId(userId, "user ID");
    withRewardsTransaction((tx) => evaluateBadgeAwards(tx, userId));
    return listBadgeProgress(userId);
}
function validateRewardInput(input) {
    const name = requiredText(input.name, "Reward name", 160);
    const reason = requiredText(input.reason, "Reason", 500);
    if (!REWARD_KINDS.includes(input.kind))
        throw new RewardsError("Reward kind is invalid.", "VALIDATION_ERROR", 400);
    if (!Number.isInteger(input.cost) || input.cost < 0)
        throw new RewardsError("Reward cost must be a non-negative integer.", "VALIDATION_ERROR", 400);
    return { name, reason };
}
export async function createReward(input) {
    const { name, reason } = validateRewardInput(input);
    validId(input.actorUserId, "actor user ID");
    return withRewardsTransaction((tx) => {
        const now = new Date();
        const [reward] = tx.insert(rewards).values({ name, description: input.description?.trim() || null, kind: input.kind, cost: input.cost, emoji: input.emoji?.trim() || null, active: input.active ?? true, createdAt: now, updatedAt: now }).returning().all();
        if (!reward)
            throw new RewardsError("Reward was not created.", "REWARD_WRITE_FAILED", 500);
        const [version] = tx.insert(rewardVersions).values({ rewardId: reward.id, version: 1, name: reward.name, description: reward.description, kind: reward.kind, cost: reward.cost, emoji: reward.emoji, active: reward.active, createdBy: input.actorUserId, createdAt: now }).returning().all();
        if (!version)
            throw new RewardsError("Reward version was not created.", "REWARD_VERSION_WRITE_FAILED", 500);
        tx.insert(auditEvents).values(buildRewardsAuditRecord({ actorUserId: input.actorUserId, sessionId: input.sessionId, ipAddress: input.ipAddress, userAgent: input.userAgent, action: "rewards.catalogue.created", targetType: "reward", targetId: reward.id, reason, metadata: { status: "created", resourceType: "reward" }, requiresReason: true }, now)).run();
        return { reward, version };
    });
}
export async function updateReward(input) {
    const { name, reason } = validateRewardInput(input);
    validId(input.rewardId, "reward ID");
    validId(input.actorUserId, "actor user ID");
    return withRewardsTransaction((tx) => {
        const [current] = tx.select().from(rewards).where(eq(rewards.id, input.rewardId)).limit(1).all();
        if (!current)
            throw new RewardsError("Reward not found.", "REWARD_NOT_FOUND", 404);
        const latest = getCurrentRewardVersion(tx, current.id);
        const now = new Date();
        const [reward] = tx.update(rewards).set({ name, description: input.description?.trim() || null, kind: input.kind, cost: input.cost, emoji: input.emoji?.trim() || null, active: input.active ?? current.active, updatedAt: now }).where(eq(rewards.id, current.id)).returning().all();
        const [version] = tx.insert(rewardVersions).values({ rewardId: current.id, version: (latest?.version ?? 0) + 1, name, description: input.description?.trim() || null, kind: input.kind, cost: input.cost, emoji: input.emoji?.trim() || null, active: input.active ?? current.active, createdBy: input.actorUserId, createdAt: now }).returning().all();
        if (!reward || !version)
            throw new RewardsError("Reward update was not created.", "REWARD_WRITE_FAILED", 500);
        tx.insert(auditEvents).values(buildRewardsAuditRecord({ actorUserId: input.actorUserId, sessionId: input.sessionId, ipAddress: input.ipAddress, userAgent: input.userAgent, action: "rewards.catalogue.updated", targetType: "reward", targetId: reward.id, reason, metadata: { status: "updated", resourceType: "reward" }, requiresReason: true }, now)).run();
        return { reward, version };
    });
}
export async function getCatalogue() { return listRewardCatalogue(); }
export async function getAdminCatalogue() { return listAllRewards(); }
export async function getEmployeePointsSummary(userId) {
    const [balance, badges] = await Promise.all([getBalance(userId), getBadgeProgress(userId)]);
    const level = await getLevelForPoints(balance.balance);
    return { balance, level, badges };
}
export async function getEmployeeRewards(userId) {
    const [balance, catalogue, badges] = await Promise.all([getBalance(userId), getCatalogue(), getBadgeProgress(userId)]);
    const level = await getLevelForPoints(balance.balance);
    return { balance, level, catalogue: catalogue.filter((reward) => reward.kind !== "earned"), earned: catalogue.filter((reward) => reward.kind === "earned"), badges };
}
