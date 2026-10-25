import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { auditEvents, notificationEmailDeliveries, notifications, users } from "../../db/schema";
import { processNotificationEmailBatch } from "./email-worker";
import { eligibleEmail, readSmtpConfig } from "./smtp-config";

test("SMTP config is disabled when empty and rejects partial or unsafe settings", () => {
  assert.equal(readSmtpConfig({}), null);
  assert.throws(() => readSmtpConfig({ SMTP_HOST: "relay.internal" }));
  assert.throws(() => readSmtpConfig({ SMTP_HOST: "relay.internal", SMTP_PORT: "25", SMTP_FROM: "noreply@example.test\nBcc: x" }));
  assert.equal(readSmtpConfig({ SMTP_HOST: "relay.internal", SMTP_PORT: "587", SMTP_FROM: "noreply@example.test" })?.secure, false);
  assert.equal(eligibleEmail("demo-1@demo.abignite.invalid"), false);
});

test("notification email delivery is audited, idempotent and skips demo recipients", async () => {
  const old = { host: process.env.SMTP_HOST, port: process.env.SMTP_PORT, from: process.env.SMTP_FROM };
  process.env.SMTP_HOST = "relay.internal"; process.env.SMTP_PORT = "465"; process.env.SMTP_FROM = "noreply@example.test";
  const stamp = Date.now().toString();
  const person = db.insert(users).values({ name: "Mail test", email: `mail-${stamp}@example.test`, passwordHash: "invalid" }).returning({ id: users.id }).get();
  const note = db.insert(notifications).values({ userId: person.id, type: "test", title: "Sensitive test content", body: "Private message" }).returning({ id: notifications.id }).get();
  const sent: Array<{ to: string; text: string }> = [];
  try {
    const send = async (message: { to: string; text: string }) => { sent.push(message); };
    assert.equal((await processNotificationEmailBatch({ notificationId: note.id, send })).processed, 1);
    assert.equal((await processNotificationEmailBatch({ notificationId: note.id, send })).processed, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text.includes("Private message"), false);
    assert.equal(db.select().from(notificationEmailDeliveries).where(eq(notificationEmailDeliveries.notificationId, note.id)).get()?.status, "sent");
    assert.ok(db.select().from(auditEvents).where(eq(auditEvents.targetId, String(note.id))).all().some((event) => event.action === "notification.email.sent"));
    const demo = db.insert(users).values({ name: "Demo", email: `demo-${stamp}@demo.abignite.invalid`, passwordHash: "invalid" }).returning({ id: users.id }).get();
    const demoNote = db.insert(notifications).values({ userId: demo.id, type: "test", title: "Demo" }).returning({ id: notifications.id }).get();
    assert.equal((await processNotificationEmailBatch({ notificationId: demoNote.id, send })).processed, 1);
    assert.equal(sent.length, 1);
    assert.equal(db.select().from(notificationEmailDeliveries).where(eq(notificationEmailDeliveries.notificationId, demoNote.id)).get()?.status, "skipped");
    const failedNote = db.insert(notifications).values({ userId: person.id, type: "test", title: "Fail" }).returning({ id: notifications.id }).get();
    assert.equal((await processNotificationEmailBatch({ notificationId: failedNote.id, send: async () => { throw new Error("private relay detail"); } })).processed, 1);
    const failed = db.select().from(notificationEmailDeliveries).where(eq(notificationEmailDeliveries.notificationId, failedNote.id)).get();
    assert.equal(failed?.status, "failed");
    assert.equal(failed?.lastErrorCode, "smtp_send_failed");
    assert.ok(failed?.nextAttemptAt && failed.nextAttemptAt > new Date());
    const failedAudit = db.select().from(auditEvents).where(eq(auditEvents.targetId, String(failedNote.id))).all();
    assert.ok(failedAudit.some((event) => event.action === "notification.email.failed"));
    assert.equal(JSON.stringify(failedAudit).includes("private relay detail"), false);
    db.delete(users).where(eq(users.id, demo.id)).run();
  } finally {
    db.delete(users).where(eq(users.id, person.id)).run();
    if (old.host === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = old.host;
    if (old.port === undefined) delete process.env.SMTP_PORT; else process.env.SMTP_PORT = old.port;
    if (old.from === undefined) delete process.env.SMTP_FROM; else process.env.SMTP_FROM = old.from;
  }
});
