import assert from "node:assert/strict";
import test, { before } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";

let db: typeof import("../../db/connection").db;
let schema: typeof import("../../db/schema");
let service: typeof import("./service");
let ownerId: number;
let otherId: number;

before(async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "ignite-notifications-")), "test.db");
  ({ db } = await import("../../db/connection"));
  schema = await import("../../db/schema");
  migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  service = await import("./service");
  ownerId = db.insert(schema.users).values({ name: "Notification owner", email: "notification-owner@example.test", passwordHash: "test" }).returning({ id: schema.users.id }).get().id;
  otherId = db.insert(schema.users).values({ name: "Other owner", email: "notification-other@example.test", passwordHash: "test" }).returning({ id: schema.users.id }).get().id;
});

function note(userId: number, type: string, link: string | null, createdAt = new Date()) {
  return db.insert(schema.notifications).values({ userId, type, title: type, body: null, link, createdAt, updatedAt: createdAt }).returning().get();
}

test("list maps producer links to safe, available destinations and hides arbitrary links", () => {
  const idea = db.insert(schema.ideas).values({ authorId: ownerId, title: "Idea", summary: "Summary", category: "Ops", reference: "NOTIFICATION-IDEA", status: "screening" }).returning().get();
  const announcement = db.insert(schema.announcements).values({ title: "Notice", body: "Published details", published: true }).returning().get();
  const ideaNote = note(ownerId, "idea_comment", `/ideas/${idea.id}`);
  const announcementNote = note(ownerId, "announcement_published", `/announcements/${announcement.id}`);
  const feedbackNote = note(ownerId, "feedback_received", "/private/feedback");
  const learningNote = note(ownerId, "learning_recommendation", "/private/knowledge?topic=Leadership%20Skills");
  const unsafeNote = note(ownerId, "idea_comment", "javascript:alert(1)");
  const unknownNote = note(ownerId, "legacy", "https://evil.example/steal");
  const forgedType = note(ownerId, "idea_unrecognized", `/ideas/${idea.id}`);
  const items = service.listNotifications(ownerId, { page: 1, pageSize: 20 }).items;
  const find = (id: number) => items.find((item) => item.id === id)!;
  assert.deepEqual(find(ideaNote.id).target, { type: "idea", id: idea.id, path: `/private?ideaId=${idea.id}`, available: true });
  assert.deepEqual(find(announcementNote.id).target, { type: "announcement", id: announcement.id, path: `/private?announcementId=${announcement.id}`, available: true });
  assert.deepEqual(find(feedbackNote.id).target, { type: "feedback", id: null, path: "/private?view=feedback", available: true });
  assert.deepEqual(find(learningNote.id).target, { type: "learning", id: null, path: "/private?view=learn&topic=Leadership%20Skills", available: true });
  assert.deepEqual(find(unsafeNote.id).target, { type: "none", id: null, path: null, available: false });
  assert.equal(find(unsafeNote.id).link, null);
  assert.equal(find(unknownNote.id).link, null);
  assert.deepEqual(find(forgedType.id).target, { type: "none", id: null, path: null, available: false });
  assert.equal(find(ideaNote.id).body, "");
  assert.equal("userId" in find(ideaNote.id), false);
});

test("deleted, unpublished, and private draft targets cannot navigate or expose details", () => {
  const draft = db.insert(schema.ideas).values({ authorId: otherId, title: "Private", summary: "Private", category: "Ops", reference: "NOTIFICATION-DRAFT", status: "draft" }).returning().get();
  const unpublished = db.insert(schema.announcements).values({ title: "Hidden", body: "Secret", published: false }).returning().get();
  const entries = [
    note(ownerId, "idea_status_changed", "/ideas/99999999"),
    note(ownerId, "idea_comment", `/ideas/${draft.id}`),
    note(ownerId, "announcement_published", `/announcements/${unpublished.id}`),
  ];
  const items = service.listNotifications(ownerId, { page: 1, pageSize: 50 }).items;
  for (const entry of entries) {
    const target = items.find((item) => item.id === entry.id)!.target;
    assert.equal(target.available, false);
    assert.equal(target.path, null);
  }
  assert.equal(service.getPublishedAnnouncement(unpublished.id), null);
});

test("cursor pages stay distinct when new notices arrive and reject malformed cursors", () => {
  const base = new Date(Date.now() + 60_000);
  for (let i = 0; i < 4; i++) note(otherId, "feedback_received", "/private/feedback", base);
  const first = service.listNotifications(otherId, { page: 1, pageSize: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  note(otherId, "feedback_received", "/private/feedback", new Date(base.getTime() + 10));
  const second = service.listNotifications(otherId, { page: 2, pageSize: 2, cursor: first.nextCursor! });
  assert.equal(second.items.length, 2);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4);
  assert.equal(second.nextCursor, null);
  assert.throws(() => service.listNotifications(otherId, { page: 2, pageSize: 2, cursor: "invalid" }), /cursor/i);
});

test("unread filter and count remain scoped to one user", () => {
  const mine = note(ownerId, "feedback_received", "/private/feedback");
  note(otherId, "feedback_received", "/private/feedback");
  const before = service.listNotifications(ownerId, { page: 1, pageSize: 50, unreadOnly: true });
  assert.ok(before.items.some((item) => item.id === mine.id));
  assert.ok(before.items.every((item) => item.id !== mine.id || !item.isRead));
  service.setNotificationRead(ownerId, { id: mine.id, read: true });
  const after = service.listNotifications(ownerId, { page: 1, pageSize: 50, unreadOnly: true });
  assert.equal(after.items.some((item) => item.id === mine.id), false);
  assert.equal(after.unreadCount, after.total);
});

test("read mutations belong to the authenticated owner and are idempotent", () => {
  const owned = note(ownerId, "feedback_received", "/private/feedback");
  const foreign = note(otherId, "feedback_received", "/private/feedback");
  assert.equal(service.setNotificationRead(ownerId, { id: foreign.id, read: true }), false);
  assert.equal(service.setNotificationRead(ownerId, { id: owned.id, read: true }), true);
  assert.equal(service.setNotificationRead(ownerId, { id: owned.id, read: true }), true);
  assert.equal(db.select().from(schema.notifications).where(eq(schema.notifications.id, foreign.id)).get()!.isRead, false);
  service.setNotificationRead(ownerId, { all: true, read: false });
  assert.equal(db.select().from(schema.notifications).where(eq(schema.notifications.id, owned.id)).get()!.isRead, false);
  assert.equal(db.select().from(schema.notifications).where(eq(schema.notifications.id, foreign.id)).get()!.isRead, false);
});

test("published announcement detail contains only public fields", () => {
  const published = db.insert(schema.announcements).values({ title: "Public update", body: "Details", published: true, pinned: true }).returning().get();
  assert.deepEqual(service.getPublishedAnnouncement(published.id), { id: published.id, title: "Public update", body: "Details", publishedAt: published.createdAt.toISOString() });
  assert.equal(service.getPublishedAnnouncement(99999999), null);
});

test("notification routes accept only a valid positive authenticated user ID", () => {
  const session = (id: string, isValid?: boolean) => ({ user: { id }, isValid }) as Parameters<typeof service.notificationUserId>[0];
  assert.equal(service.notificationUserId(null), null);
  assert.equal(service.notificationUserId(session(String(ownerId), false)), null);
  assert.equal(service.notificationUserId(session("0", true)), null);
  assert.equal(service.notificationUserId(session("1e2", true)), null);
  assert.equal(service.notificationUserId(session(String(ownerId), true)), ownerId);
});
