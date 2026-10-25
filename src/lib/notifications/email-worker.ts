import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import nodemailer from "nodemailer";
import { db } from "../../db/connection";
import { notificationEmailDeliveries, notifications, users } from "../../db/schema";
import { appendAuditEvent } from "../audit/service";
import { eligibleEmail, readSmtpConfig } from "./smtp-config";

export type EmailSend = (message: { from: string; to: string; subject: string; text: string; messageId: string }) => Promise<unknown>;
const MAX_ATTEMPTS = 5;

function claim(notificationId: number, now: Date) {
  return db.transaction((tx) => {
    tx.insert(notificationEmailDeliveries).values({ notificationId, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
    const [current] = tx.select().from(notificationEmailDeliveries).where(eq(notificationEmailDeliveries.notificationId, notificationId)).limit(1).all();
    if (!current || current.status === "sent" || current.status === "skipped" || current.attempts >= MAX_ATTEMPTS) return null;
    if (current.claimedUntil && current.claimedUntil > now) return null;
    if (current.nextAttemptAt && current.nextAttemptAt > now) return null;
    const claimToken = randomUUID();
    tx.update(notificationEmailDeliveries).set({ status: "sending", attempts: current.attempts + 1, claimToken, claimedUntil: new Date(now.getTime() + 60_000), nextAttemptAt: null, updatedAt: now })
      .where(eq(notificationEmailDeliveries.notificationId, notificationId)).run();
    return { claimToken, attempt: current.attempts + 1 };
  });
}

export async function processNotificationEmailBatch(options: { limit?: number; notificationId?: number; send?: EmailSend } = {}) {
  let config;
  try { config = readSmtpConfig(); }
  catch {
    appendAuditEvent({ action: "notification.email.config_failed", targetType: "email_delivery", metadata: { reasonCode: "invalid_smtp_config" } });
    return { status: "configuration_error" as const, processed: 0 };
  }
  if (!config) {
    appendAuditEvent({ action: "notification.email.disabled", targetType: "email_delivery", metadata: { reasonCode: "smtp_not_configured" } });
    return { status: "disabled" as const, processed: 0 };
  }
  const transport = options.send ? null : nodemailer.createTransport({
    host: config.host, port: config.port, secure: config.secure, requireTLS: !config.secure,
    auth: config.user ? { user: config.user, pass: config.password } : undefined,
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    tls: { rejectUnauthorized: true, servername: config.host },
  });
  const send: EmailSend = options.send ?? ((message) => transport!.sendMail(message));
  const now = new Date();
  const candidates = db.select({ notification: notifications, delivery: notificationEmailDeliveries, email: users.email, active: users.isActive })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .leftJoin(notificationEmailDeliveries, eq(notificationEmailDeliveries.notificationId, notifications.id))
    .where(and(options.notificationId ? eq(notifications.id, options.notificationId) : undefined, or(
      isNull(notificationEmailDeliveries.notificationId),
      and(eq(notificationEmailDeliveries.status, "failed"), lte(notificationEmailDeliveries.nextAttemptAt, now), sql`${notificationEmailDeliveries.attempts} < ${MAX_ATTEMPTS}`),
      and(eq(notificationEmailDeliveries.status, "sending"), lte(notificationEmailDeliveries.claimedUntil, now), sql`${notificationEmailDeliveries.attempts} < ${MAX_ATTEMPTS}`),
    )))
    .orderBy(asc(notifications.id)).limit(Math.min(Math.max(options.limit ?? 25, 1), 100)).all();
  let processed = 0;
  try {
    for (const candidate of candidates) {
      const item = candidate.notification;
      const reserved = claim(item.id, new Date());
      if (!reserved) continue;
      const key = and(eq(notificationEmailDeliveries.notificationId, item.id), eq(notificationEmailDeliveries.claimToken, reserved.claimToken));
      const changedAt = new Date();
      if (!candidate.active || !eligibleEmail(candidate.email)) {
        db.update(notificationEmailDeliveries).set({ status: "skipped", claimToken: null, claimedUntil: null, lastErrorCode: "recipient_unavailable", updatedAt: changedAt }).where(key).run();
        appendAuditEvent({ action: "notification.email.skipped", targetType: "notification", targetId: item.id, metadata: { reasonCode: "recipient_unavailable" } });
        processed++;
        continue;
      }
      try {
        await send({ from: config.from, to: candidate.email, subject: "New AB Ignite notification", text: "You have a new AB Ignite notification. Sign in to view it securely.", messageId: `<ab-ignite-notification-${item.id}@abignite.invalid>` });
        db.update(notificationEmailDeliveries).set({ status: "sent", sentAt: new Date(), claimToken: null, claimedUntil: null, lastErrorCode: null, updatedAt: new Date() }).where(key).run();
        appendAuditEvent({ action: "notification.email.sent", targetType: "notification", targetId: item.id, metadata: { attempt: reserved.attempt } });
      } catch {
        const final = reserved.attempt >= MAX_ATTEMPTS;
        const backoff = Math.min(60 * 60_000, 60_000 * 2 ** (reserved.attempt - 1));
        db.update(notificationEmailDeliveries).set({ status: "failed", claimToken: null, claimedUntil: null, nextAttemptAt: final ? null : new Date(Date.now() + backoff), lastErrorCode: "smtp_send_failed", updatedAt: new Date() }).where(key).run();
        appendAuditEvent({ action: "notification.email.failed", targetType: "notification", targetId: item.id, metadata: { reasonCode: "smtp_send_failed", attempt: reserved.attempt, final } });
      }
      processed++;
    }
  } finally { transport?.close(); }
  return { status: "processed" as const, processed };
}
