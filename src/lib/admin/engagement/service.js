import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db/connection";
import { announcements, auditEvents, feedbackCampaigns, notifications, refreshTokens, users } from "../../../db/schema";
import { isSessionActive } from "../../../auth/security-core";
import { buildAuditRecord } from "../../audit/service";
import { hashAuditValue } from "../../audit/redaction-core";
import { AuthorizationError, requirePrivilegedReason } from "../../auth/authorization-core";
import { AdminConflictError, AdminInputError, AdminNotFoundError } from "../query";
const idSchema = z.number().int().positive();
const announcementSchema = z.strictObject({ title: z.string().trim().min(1).max(240), body: z.string().trim().min(1).max(4000) });
function verify(tx, actor, now) {
    const user = tx.select().from(users).where(eq(users.id, actor.userId)).get();
    const session = tx.select().from(refreshTokens).where(eq(refreshTokens.id, actor.sessionId)).get();
    if (!user || user.role !== "back_office" || !user.isActive || !session || session.userId !== user.id || !isSessionActive(session, user, now))
        throw new AuthorizationError("Administrator session is no longer valid.");
}
function mutate(actor, action, id, key, data, change) {
    const reason = requirePrivilegedReason(actor.reason);
    if (key.length < 8 || key.length > 200 || !/^[\x21-\x7e]+$/.test(key))
        throw new AdminInputError("A valid idempotency key is required.");
    const targetId = `${actor.userId}:${hashAuditValue(key)}`;
    const fingerprint = createHash("sha256").update(JSON.stringify({ id, data })).digest("hex");
    return db.transaction((tx) => {
        const now = new Date();
        verify(tx, actor, now);
        const actionKey = `admin.engagement.${action}`;
        const replay = tx.select().from(auditEvents).where(and(eq(auditEvents.action, actionKey), eq(auditEvents.targetId, targetId))).get();
        if (replay) {
            let metadata;
            try {
                metadata = JSON.parse(replay.metadataJson ?? "{}");
            }
            catch {
                throw new AdminConflictError("Idempotency record is invalid.");
            }
            if (metadata.result !== fingerprint)
                throw new AdminConflictError("Idempotency key was used for a different request.");
            const found = findResult(tx, action, metadata.resourceId);
            if (!found)
                throw new AdminConflictError("Previously changed resource is unavailable.");
            return found;
        }
        const result = change(tx, now);
        tx.insert(auditEvents).values(buildAuditRecord({ actorUserId: actor.userId, sessionId: actor.sessionId, action: actionKey, targetType: action, targetId: targetId, reason, metadata: { result: fingerprint, resourceId: result.id }, ipAddress: actor.ipAddress, userAgent: actor.userAgent }, now)).run();
        return result;
    }, { behavior: "immediate" });
}
function findResult(tx, action, id) {
    if (!Number.isInteger(id))
        return undefined;
    return action.startsWith("announcement") ? tx.select().from(announcements).where(eq(announcements.id, id)).get() : tx.select().from(feedbackCampaigns).where(eq(feedbackCampaigns.id, id)).get();
}
export function listAnnouncements(limit = 50) { return db.select().from(announcements).orderBy(desc(announcements.pinned), desc(announcements.updatedAt)).limit(Math.min(Math.max(Math.trunc(limit), 1), 100)).all(); }
export function listCampaigns(limit = 50) { return db.select().from(feedbackCampaigns).orderBy(desc(feedbackCampaigns.updatedAt)).limit(Math.min(Math.max(Math.trunc(limit), 1), 100)).all(); }
export function createAnnouncement(actor, raw, key) {
    const input = announcementSchema.parse(raw);
    return mutate(actor, "announcement.create", null, key, input, (tx, now) => tx.insert(announcements).values({ ...input, published: true, createdBy: actor.userId, createdAt: now, updatedAt: now }).returning().get());
}
export function setAnnouncementPinned(actor, announcementId, pinned, key) {
    idSchema.parse(announcementId);
    z.boolean().parse(pinned);
    return mutate(actor, "announcement.pin", announcementId, key, { pinned }, (tx, now) => {
        const row = tx.select().from(announcements).where(eq(announcements.id, announcementId)).get();
        if (!row)
            throw new AdminNotFoundError("Announcement not found.");
        if (row.pinned === pinned)
            return row;
        if (pinned)
            tx.update(announcements).set({ pinned: false, updatedAt: now }).where(and(eq(announcements.pinned, true), sql `${announcements.id} <> ${announcementId}`)).run();
        const changed = tx.update(announcements).set({ pinned, updatedAt: now }).where(eq(announcements.id, announcementId)).returning().get();
        if (pinned)
            for (const user of tx.select({ id: users.id }).from(users).where(and(eq(users.role, "employee"), eq(users.isActive, true))).all())
                tx.insert(notifications).values({ userId: user.id, type: "announcement_published", title: changed.title, body: changed.body, link: `/announcements/${changed.id}`, createdAt: now, updatedAt: now }).run();
        return changed;
    });
}
export function setCampaignActive(actor, campaignId, active, key) {
    idSchema.parse(campaignId);
    z.boolean().parse(active);
    return mutate(actor, "campaign.lifecycle", campaignId, key, { active }, (tx, now) => {
        const row = tx.select().from(feedbackCampaigns).where(eq(feedbackCampaigns.id, campaignId)).get();
        if (!row)
            throw new AdminNotFoundError("Campaign not found.");
        if (active && row.endsAt && row.endsAt <= now)
            throw new AdminConflictError("Expired campaign cannot be opened.");
        if (active)
            tx.update(feedbackCampaigns).set({ pinned: false, updatedAt: now }).where(and(eq(feedbackCampaigns.pinned, true), sql `${feedbackCampaigns.id} <> ${campaignId}`)).run();
        tx.update(feedbackCampaigns).set({ active, pinned: active, updatedAt: now }).where(eq(feedbackCampaigns.id, campaignId)).run();
        const result = tx.select().from(feedbackCampaigns).where(eq(feedbackCampaigns.id, campaignId)).get();
        if (row.active !== active && active)
            for (const user of tx.select({ id: users.id }).from(users).where(and(eq(users.role, "employee"), eq(users.isActive, true))).all())
                tx.insert(notifications).values({ userId: user.id, type: "feedback_campaign_opened", title: "A feedback campaign is open", body: result.title, link: "/private/feedback", createdAt: now, updatedAt: now }).run();
        return result;
    });
}
