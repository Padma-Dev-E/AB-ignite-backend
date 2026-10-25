import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Session } from "next-auth";
import { db } from "../../db/connection";
import { announcements, ideas, notifications } from "../../db/schema";

export type NotificationTarget = {
  type: "idea" | "announcement" | "feedback" | "learning" | "none";
  id: number | null;
  path: string | null;
  available: boolean;
};

export type NotificationItem = {
  id: number;
  type: string;
  title: string;
  body: string;
  link: string | null;
  target: NotificationTarget;
  isRead: boolean;
  createdAt: string;
};

export type NotificationPage = {
  items: NotificationItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  unreadCount: number;
  nextCursor: string | null;
};

type ListInput = { page: number; pageSize: number; unreadOnly?: boolean; cursor?: string };
type Row = typeof notifications.$inferSelect;
const ideaLink = /^\/ideas\/([1-9]\d*)$/;
const announcementLink = /^\/announcements\/([1-9]\d*)$/;
const ideaTypes = new Set(["idea_builds_on", "idea_supported", "idea_comment", "idea_submitted", "idea_status_changed", "idea_accepted", "idea_routed", "idea_control_approved", "idea_owner_approved"]);
const unavailable = (type: NotificationTarget["type"] = "none", id: number | null = null): NotificationTarget => ({ type, id, path: null, available: false });

export function notificationUserId(session: Session | null): number | null {
  const raw = session?.user?.id;
  if (session?.isValid === false || typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function positiveId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseCursor(value: string) {
  if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid notification cursor.");
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 || !Number.isSafeInteger(decoded[0]) || !Number.isSafeInteger(decoded[1]) || decoded[0] < 0 || decoded[1] < 1) throw new Error();
    const date = new Date(decoded[0]);
    if (!Number.isFinite(date.getTime())) throw new Error();
    return { date, id: decoded[1] as number };
  } catch { throw new Error("Invalid notification cursor."); }
}

function cursorFor(row: Row) {
  return Buffer.from(JSON.stringify([row.createdAt.getTime(), row.id])).toString("base64url");
}

function targetFor(row: Row, visibleIdeas: Set<number>, visibleAnnouncements: Set<number>): NotificationTarget {
  const link = typeof row.link === "string" ? row.link : "";
  if (ideaTypes.has(row.type)) {
    const id = positiveId(ideaLink.exec(link)?.[1] ?? "");
    return id === null ? unavailable() : visibleIdeas.has(id) ? { type: "idea", id, path: `/private?ideaId=${id}`, available: true } : unavailable("idea", id);
  }
  if (row.type === "announcement_published") {
    const id = positiveId(announcementLink.exec(link)?.[1] ?? "");
    return id === null ? unavailable() : visibleAnnouncements.has(id) ? { type: "announcement", id, path: `/private?announcementId=${id}`, available: true } : unavailable("announcement", id);
  }
  if (["feedback_received", "feedback_response", "feedback_campaign_opened"].includes(row.type) && link === "/private/feedback") {
    return { type: "feedback", id: null, path: "/private?view=feedback", available: true };
  }
  if (row.type === "learning_recommendation") {
    try {
      const url = new URL(link, "http://localhost");
      if (url.origin !== "http://localhost" || url.pathname !== "/private/knowledge" || url.searchParams.size !== 1 || !url.searchParams.has("topic")) return unavailable();
      const topic = url.searchParams.get("topic")?.trim() ?? "";
      if (!topic || topic.length > 200 || /[\u0000-\u001f\u007f]/.test(topic)) return unavailable();
      return { type: "learning", id: null, path: `/private?view=learn&topic=${encodeURIComponent(topic)}`, available: true };
    } catch { return unavailable(); }
  }
  return unavailable();
}

export function listNotifications(userId: number, input: ListInput): NotificationPage {
  const { page, pageSize, unreadOnly = false, cursor } = input;
  if (!Number.isSafeInteger(userId) || userId < 1 || !Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new Error("Invalid notification list input.");
  const boundary = cursor ? parseCursor(cursor) : null;
  const own = eq(notifications.userId, userId);
  const filter = and(own, unreadOnly ? eq(notifications.isRead, false) : undefined);
  const rowFilter = and(filter, boundary ? or(lt(notifications.createdAt, boundary.date), and(eq(notifications.createdAt, boundary.date), lt(notifications.id, boundary.id))) : undefined);
  const rows = db.select().from(notifications).where(rowFilter).orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(pageSize + 1).offset(boundary ? 0 : (page - 1) * pageSize).all();
  const pageRows = rows.slice(0, pageSize);
  const ideaIds = Array.from(new Set(pageRows.filter((row) => ideaTypes.has(row.type)).map((row) => positiveId(ideaLink.exec(row.link ?? "")?.[1] ?? "")).filter((id): id is number => id !== null)));
  const announcementIds = Array.from(new Set(pageRows.filter((row) => row.type === "announcement_published").map((row) => positiveId(announcementLink.exec(row.link ?? "")?.[1] ?? "")).filter((id): id is number => id !== null)));
  const visibleIdeas = new Set(ideaIds.length ? db.select({ id: ideas.id }).from(ideas).where(and(inArray(ideas.id, ideaIds), or(eq(ideas.authorId, userId), sql`${ideas.status} <> 'draft'`))).all().map((row) => row.id) : []);
  const visibleAnnouncements = new Set(announcementIds.length ? db.select({ id: announcements.id }).from(announcements).where(and(inArray(announcements.id, announcementIds), eq(announcements.published, true))).all().map((row) => row.id) : []);
  const items = pageRows.map((row): NotificationItem => {
    const target = targetFor(row, visibleIdeas, visibleAnnouncements);
    const createdAt = row.createdAt instanceof Date && Number.isFinite(row.createdAt.getTime()) ? row.createdAt.toISOString() : new Date(0).toISOString();
    return { id: row.id, type: row.type, title: row.title?.trim() || "Notification", body: row.body ?? "", link: target.path, target, isRead: Boolean(row.isRead), createdAt };
  });
  const total = Number(db.select({ count: sql<number>`count(*)` }).from(notifications).where(filter).get()?.count ?? 0);
  const unreadCount = Number(db.select({ count: sql<number>`count(*)` }).from(notifications).where(and(own, eq(notifications.isRead, false))).get()?.count ?? 0);
  return { items, page, pageSize, total, totalPages: Math.ceil(total / pageSize), unreadCount, nextCursor: rows.length > pageSize && pageRows.length ? cursorFor(pageRows[pageRows.length - 1]) : null };
}

export function setNotificationRead(userId: number, input: { id?: number; all?: boolean; read: boolean }): boolean {
  if (!Number.isSafeInteger(userId) || userId < 1 || typeof input.read !== "boolean" || Boolean(input.id) === Boolean(input.all)) throw new Error("Invalid notification update input.");
  if (input.all) {
    db.update(notifications).set({ isRead: input.read, updatedAt: new Date() }).where(eq(notifications.userId, userId)).run();
    return true;
  }
  if (!Number.isSafeInteger(input.id) || input.id! < 1) throw new Error("Invalid notification ID.");
  const changed = db.update(notifications).set({ isRead: input.read, updatedAt: new Date() }).where(and(eq(notifications.id, input.id!), eq(notifications.userId, userId))).run();
  return changed.changes > 0;
}

export function getPublishedAnnouncement(id: number) {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const row = db.select({ id: announcements.id, title: announcements.title, body: announcements.body, createdAt: announcements.createdAt }).from(announcements).where(and(eq(announcements.id, id), eq(announcements.published, true))).get();
  return row ? { id: row.id, title: row.title, body: row.body, publishedAt: row.createdAt.toISOString() } : null;
}
