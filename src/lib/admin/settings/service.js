import "server-only";
import { createHash } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/connection";
import { auditEvents, ideaSettings, levels, pointRules, quizRecommendationRules, refreshTokens, users } from "../../../db/schema";
import { isSessionActive } from "../../../auth/security-core";
import { buildAuditRecord } from "../../audit/service";
import { requirePrivilegedReason, AuthorizationError } from "../../auth/authorization-core";
import { AdminInputError } from "../query";
import { resolvePriorityPolicy } from "../../ideas/priority-policy";
import { settingKeys, validatePolicySetting } from "./validation";
function auditSettingValue(value) {
    if (value === undefined)
        return "unset";
    return value.length <= 200 ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function auditChange(tx, actor, reason, targetType, targetId, before, after, now) {
    tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: "admin.settings.policy_changed", targetType, targetId, reason, requiresReason: true, metadata: { fromStatus: auditSettingValue(before), toStatus: auditSettingValue(after) }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, now)).run();
}
export async function getAdminSettings() {
    const settings = db.select().from(ideaSettings).where(sql `${ideaSettings.key} IN (${sql.join(settingKeys.map((key) => sql `${key}`), sql `, `)})`).all();
    const priority = Object.fromEntries(settings.map(({ key, value }) => [key, value]));
    const departments = priority.departments === undefined
        ? Array.from(new Set(db.select({ department: users.department }).from(users).all().map(({ department }) => department))).sort()
        : JSON.parse(priority.departments);
    return {
        priority,
        levels: db.select().from(levels).orderBy(asc(levels.sortOrder)).all(),
        departments,
        pointRules: db.select().from(pointRules).orderBy(asc(pointRules.code)).all(),
        recommendationRules: db.select().from(quizRecommendationRules).orderBy(asc(quizRecommendationRules.topic)).all(),
    };
}
function assertActor(tx, actor, now) {
    const user = tx.select().from(users).where(eq(users.id, actor.userId)).limit(1).get();
    const session = tx.select().from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).limit(1).get();
    if (!user || user.role !== "back_office" || !user.isActive || !session || session.userId !== user.id || !isSessionActive(session, user, now))
        throw new AuthorizationError("Back-office session is no longer valid.");
}
export async function updateAdminSettings(actor, input) {
    const reason = requirePrivilegedReason(actor.reason);
    if (!Object.keys(input.priority ?? {}).length && !input.pointRules?.length && !input.recommendationRules?.length && !input.levels?.length)
        throw new AdminInputError("Change at least one setting.");
    for (const [key, value] of Object.entries(input.priority ?? {}))
        validatePolicySetting(key, value);
    if (input.priority?.priority_kpis !== undefined || input.priority?.priority_bands !== undefined) {
        const saved = db.select({ key: ideaSettings.key, value: ideaSettings.value }).from(ideaSettings)
            .where(sql `${ideaSettings.key} IN ('priority_kpis', 'priority_bands')`).all();
        const merged = { ...Object.fromEntries(saved.map(({ key, value }) => [key, value])), ...input.priority };
        try {
            resolvePriorityPolicy(merged);
        }
        catch {
            throw new AdminInputError("Priority KPIs and bands must each be complete and correctly ordered; KPI weights must total 100%.");
        }
    }
    for (const rule of input.pointRules ?? [])
        if (!db.select({ id: pointRules.id }).from(pointRules).where(eq(pointRules.code, rule.code)).get())
            throw new AdminInputError("Unknown point rule code.");
    for (const rule of input.recommendationRules ?? [])
        if (!Number.isInteger(rule.thresholdPercent) || rule.thresholdPercent < 0 || rule.thresholdPercent > 100 || !rule.topic.trim() || !rule.reasonTemplate.trim())
            throw new AdminInputError("Invalid recommendation rule.");
    const levelIds = new Set();
    for (const level of input.levels ?? []) {
        if (!Number.isSafeInteger(level.id) || levelIds.has(level.id) || !level.name.trim() || level.name.length > 120 || (level.description?.length ?? 0) > 500 || !Number.isInteger(level.minimumPoints) || level.minimumPoints < 0 || level.minimumPoints > 10000000 || !Number.isInteger(level.sortOrder) || level.sortOrder < 0 || level.sortOrder > 100 || !db.select({ id: levels.id }).from(levels).where(eq(levels.id, level.id)).get())
            throw new AdminInputError("Invalid level configuration.");
        levelIds.add(level.id);
    }
    const now = new Date();
    return db.transaction((tx) => {
        assertActor(tx, actor, now);
        for (const [key, value] of Object.entries(input.priority ?? {})) {
            const previous = tx.select({ value: ideaSettings.value }).from(ideaSettings).where(eq(ideaSettings.key, key)).get()?.value;
            if (previous === value)
                continue;
            tx.insert(ideaSettings).values({ key, value: value, updatedBy: actor.userId, updatedAt: now }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: value, updatedBy: actor.userId, updatedAt: now } }).run();
            auditChange(tx, actor, reason, "idea_setting", key, previous, value, now);
        }
        for (const rule of input.pointRules ?? []) {
            const previous = tx.select({ points: pointRules.points, active: pointRules.active }).from(pointRules).where(eq(pointRules.code, rule.code)).get();
            if (!previous)
                throw new AdminInputError("Unknown point rule code.");
            if (previous.points === rule.points && previous.active === rule.active)
                continue;
            tx.update(pointRules).set({ points: rule.points, active: rule.active, updatedAt: now }).where(eq(pointRules.code, rule.code)).run();
            auditChange(tx, actor, reason, "point_rule", rule.code, JSON.stringify(previous), JSON.stringify({ points: rule.points, active: rule.active }), now);
        }
        for (const level of input.levels ?? []) {
            const previous = tx.select({ name: levels.name, description: levels.description, minimumPoints: levels.minimumPoints, sortOrder: levels.sortOrder }).from(levels).where(eq(levels.id, level.id)).get();
            if (!previous)
                throw new AdminInputError("Unknown level.");
            const next = { name: level.name.trim(), description: level.description?.trim() || null, minimumPoints: level.minimumPoints, sortOrder: level.sortOrder };
            if (JSON.stringify(previous) === JSON.stringify(next))
                continue;
            tx.update(levels).set({ ...next, updatedAt: now }).where(eq(levels.id, level.id)).run();
            auditChange(tx, actor, reason, "level", String(level.id), JSON.stringify(previous), JSON.stringify(next), now);
        }
        for (const rule of input.recommendationRules ?? []) {
            const existing = tx.select({ id: quizRecommendationRules.id, thresholdPercent: quizRecommendationRules.thresholdPercent, reasonTemplate: quizRecommendationRules.reasonTemplate, active: quizRecommendationRules.active }).from(quizRecommendationRules).where(eq(quizRecommendationRules.topic, rule.topic)).get();
            const next = { thresholdPercent: rule.thresholdPercent, reasonTemplate: rule.reasonTemplate, active: rule.active };
            if (existing && existing.thresholdPercent === next.thresholdPercent && existing.reasonTemplate === next.reasonTemplate && existing.active === next.active)
                continue;
            if (existing)
                tx.update(quizRecommendationRules).set({ ...next, updatedAt: now }).where(eq(quizRecommendationRules.id, existing.id)).run();
            else
                tx.insert(quizRecommendationRules).values({ ...rule, updatedAt: now }).run();
            auditChange(tx, actor, reason, "recommendation_rule", rule.topic, existing ? JSON.stringify({ thresholdPercent: existing.thresholdPercent, reasonTemplate: existing.reasonTemplate, active: existing.active }) : undefined, JSON.stringify(next), now);
        }
        tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: "admin.settings.updated", targetType: "admin_settings", reason, requiresReason: true, metadata: { status: "updated", result: Object.keys(input.priority ?? {}).length + (input.pointRules?.length ?? 0) + (input.recommendationRules?.length ?? 0) + (input.levels?.length ?? 0) }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, now)).run();
        return { updated: true };
    });
}
