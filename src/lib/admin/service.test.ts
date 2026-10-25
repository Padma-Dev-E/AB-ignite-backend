import test from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/connection";
import { articles, auditEvents, ideaSettings, ideas, pointsLedger, quizAttempts, quizVersions, quizzes, refreshTokens, users } from "../../db/schema";
import { adminAccess, CAPABILITIES } from "./http";
import { changeUserRole, setUserActive, resetUserSecurity, resetUserPassword, revokeUserSession, createUser, listUsers, getUserDetail, listUserSessions, listAuditEvents, getAdminAnalytics, parseAdminOffsetPage, listAdminAnnouncementPage, listAdminCampaignPage, listAdminRewardPage, listAdminChallengePage, listAdminFeedbackPage, listAdminQuizPage } from "./service";
import { verifyPassword } from "../../auth/password-core";

test("admin operations persist, revoke sessions, audit reasons, and return no secrets", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const actor = db.insert(users).values({ name: "Admin actor", email: `admin-actor-${stamp}@example.test`, role: "back_office", passwordHash: "actor-secret" }).returning({ id: users.id }).get();
  const target = db.insert(users).values({ name: "Admin target", email: `admin-target-${stamp}@example.test`, passwordHash: "target-secret", failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 60_000) }).returning({ id: users.id }).get();
  const actorSession = db.insert(refreshTokens).values({ userId: actor.id, tokenHash: `actor-token-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
  const targetSession = db.insert(refreshTokens).values({ userId: target.id, tokenHash: `target-token-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
  const context = { userId: actor.id, sessionId: actorSession.id };
  try {
    const actorCookie = { user: { id: String(actor.id), sessionId: String(actorSession.id) } } as Parameters<typeof adminAccess>[0];
    assert.equal((await adminAccess(actorCookie, CAPABILITIES.USERS_MANAGE)).userId, actor.id);
    await assert.rejects(adminAccess({ user: { id: String(target.id), sessionId: String(targetSession.id) } } as Parameters<typeof adminAccess>[0], CAPABILITIES.USERS_MANAGE));
    assert.ok((await listUsers({ limit: 100, after: null })).items.some((item) => item.id === target.id));
    const detail = await getUserDetail(target.id);
    assert.equal(detail.id, target.id);
    assert.equal(JSON.stringify(detail).includes("target-secret"), false);
    assert.equal(JSON.stringify(await listUserSessions(target.id, { limit: 10, after: null })).includes("target-token"), false);
    assert.throws(() => changeUserRole(context, target.id, "back_office", " "));
    assert.throws(() => setUserActive(context, actor.id, false, "self deactivation"));
    await changeUserRole(context, target.id, "back_office", "approved promotion");
    assert.equal(db.select().from(refreshTokens).where(eq(refreshTokens.id, targetSession.id)).get()?.revokedAt instanceof Date, true);
    await assert.rejects(adminAccess({ user: { id: String(target.id), sessionId: String(targetSession.id) } } as Parameters<typeof adminAccess>[0], CAPABILITIES.USERS_READ));
    await resetUserSecurity(context, target.id, "recover account");
    assert.equal(db.select().from(users).where(eq(users.id, target.id)).get()?.failedLoginAttempts, 0);
    await setUserActive(context, target.id, false, "left company");
    assert.equal(db.select().from(users).where(eq(users.id, target.id)).get()?.isActive, false);
    const event = db.select().from(auditEvents).where(and(eq(auditEvents.action, "admin.user.deactivated"), eq(auditEvents.targetId, String(target.id)))).get();
    assert.equal(event?.reason, "left company");
    const audit = await listAuditEvents({ limit: 100, after: null, actorUserId: actor.id });
    assert.ok(audit.items.some((item) => item.id === event?.id));
    assert.equal(JSON.stringify(audit).includes("actor-secret"), false);
    db.update(refreshTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(refreshTokens.id, actorSession.id)).run();
    await assert.rejects(adminAccess(actorCookie, CAPABILITIES.USERS_READ));
  } finally {
    db.update(users).set({ isActive: false, updatedAt: new Date() }).where(eq(users.id, actor.id)).run();
  }
});

test("management analytics returns status, priority, department, points, and learning counts", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const user = db.insert(users).values({ name: "Analytics", email: `analytics-${stamp}@example.test`, passwordHash: "test", department: "Treasury" }).returning({ id: users.id }).get();
  const idea = db.insert(ideas).values({ authorId: user.id, title: "Analytics idea", summary: "A test", category: "Ops", reference: `AI-${stamp}`, status: "screening", priorityBand: "Priority", priorityScore: 2.7 }).returning({ id: ideas.id }).get();
  db.insert(pointsLedger).values({ userId: user.id, amount: 11, eventType: "test", sourceType: "test", sourceId: "analytics", idempotencyKey: `analytics-${stamp}` }).run();
  const quiz = db.insert(quizzes).values({ title: `Analytics quiz ${stamp}`, category: "Ops", difficulty: "Beginner", objective: "Analytics test", passMark: 70, pointsPerQuestion: 10, questionCount: 1 }).returning({ id: quizzes.id }).get();
  const version = db.insert(quizVersions).values({ quizId: quiz.id, version: 1, categoryCode: "ops", level: "1", objective: "Analytics test", passMark: 70, pointsPerQuestion: 10 }).returning({ id: quizVersions.id }).get();
  db.insert(quizAttempts).values({ userId: user.id, quizId: quiz.id, quizVersionId: version.id, scorePercent: 80, passed: true, status: "submitted", startedAt: new Date(), submittedAt: new Date(), totalQuestions: 1, idempotencyKey: `quiz-${stamp}` }).run();
  db.insert(articles).values({ title: `Article ${stamp}`, summary: "S", body: "B", category: "Banking", categoryCode: "banking", publisher: "Test", difficulty: "Beginner", readingMinutes: 1, published: true, contentType: "internal" }).run();
  const result = await getAdminAnalytics();
  assert.ok(result.ideasByStatus.some((row) => row.status === "screening" && row.count >= 1));
  assert.ok(result.ideasByPriority.some((row) => row.band === "Priority" && row.count >= 1));
  assert.ok(result.ideasByDepartment.some((row) => row.department === "Treasury" && row.count >= 1));
  assert.ok(result.usersByDepartment.some((row) => row.department === "Treasury" && row.count >= 1));
  assert.ok(result.points.total >= 11);
  assert.ok(result.learning.quizAttempts >= 1);
  assert.ok(result.learning.publishedArticles >= 1);
  assert.ok(idea.id > 0);
});

test("directory search filters before pagination and treats SQL wildcards literally", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const a = db.insert(users).values({ name: `Needle ${stamp}`, email: `needle-${stamp}@example.test`, department: `Unit-${stamp}`, jobTitle: `Coordinator-${stamp}`, passwordHash: "test" }).returning({ id: users.id }).get();
  db.insert(users).values({ name: `Other ${stamp}`, email: `other-${stamp}@example.test`, department: "Finance", passwordHash: "test" }).run();
  const page = await listUsers({ limit: 1, after: null, q: `NEEDLE ${stamp}` });
  assert.deepEqual(page.items.map((user) => user.id), [a.id]);
  assert.equal(page.nextAfter, null);
  for (const q of [`NEEDLE-${stamp}`, `UNIT-${stamp}`, `COORDINATOR-${stamp}`]) {
    assert.deepEqual((await listUsers({ limit: 10, after: null, q })).items.map((user) => user.id), [a.id]);
  }
  assert.deepEqual((await listUsers({ limit: 10, after: a.id, q: `NEEDLE ${stamp}` })).items, []);
  assert.deepEqual((await listUsers({ limit: 10, after: null, q: "%" })).items, []);
});

test("role assignment, user creation, password reset and individual revocation are audited", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const actor = db.insert(users).values({ name: "Admin", email: `admin-rbac-${stamp}@example.test`, role: "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
  const actorSession = db.insert(refreshTokens).values({ userId: actor.id, tokenHash: `admin-rbac-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
  const context = { userId: actor.id, sessionId: actorSession.id };
  const created = await createUser(context, { name: "Owner", email: `owner-${stamp}@example.test`, department: "Risk", role: "business_owner" }, "approved onboarding");
  const userId = created.user.id;
  try {
    assert.equal(created.user.role, "business_owner");
    assert.equal(created.user.mustChangePassword, true);
    assert.equal(await verifyPassword(db.select().from(users).where(eq(users.id, userId)).get()!.passwordHash, created.temporaryPassword), true);
    const sessionA = db.insert(refreshTokens).values({ userId, tokenHash: `owner-a-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    const sessionB = db.insert(refreshTokens).values({ userId, tokenHash: `owner-b-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    revokeUserSession(context, userId, sessionA.id, "suspected lost device");
    assert.ok(db.select().from(refreshTokens).where(eq(refreshTokens.id, sessionA.id)).get()?.revokedAt);
    assert.equal(db.select().from(refreshTokens).where(eq(refreshTokens.id, sessionB.id)).get()?.revokedAt, null);
    const password = await resetUserPassword(context, userId, "verified identity");
    assert.equal(await verifyPassword(db.select().from(users).where(eq(users.id, userId)).get()!.passwordHash, password.temporaryPassword), true);
    assert.equal(db.select().from(users).where(eq(users.id, userId)).get()?.mustChangePassword, true);
    const adminCreated = await createUser(context, { name: "Managed back office", email: `managed-admin-${stamp}@example.test`, department: "Risk", role: "back_office" }, "approved back-office onboarding");
    assert.equal(adminCreated.user.role, "back_office");
    assert.equal(adminCreated.user.mustChangePassword, true);
    assert.ok(db.select().from(refreshTokens).where(eq(refreshTokens.id, sessionB.id)).get()?.revokedAt);
    await changeUserRole(context, userId, "back_office", "transfer to transformation");
    assert.equal(db.select().from(users).where(eq(users.id, userId)).get()?.role, "back_office");
    const audit = db.select().from(auditEvents).where(eq(auditEvents.targetId, String(userId))).all();
    assert.ok(audit.some((row) => row.action === "admin.user.created"));
    assert.ok(audit.some((row) => row.action === "admin.user.password_reset"));
    assert.equal(JSON.stringify(audit).includes(password.temporaryPassword), false);
    assert.throws(() => revokeUserSession(context, actor.id, actorSession.id, "self"));
  } finally {
    db.update(users).set({ isActive: false }).where(eq(users.id, actor.id)).run();
  }
});

test("configured department and role policy restricts user administration", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  db.run(sql`SAVEPOINT admin_user_policy_test`);
  try {
    const actor = db.insert(users).values({ name: "Policy admin", email: `policy-admin-${stamp}@example.test`, role: "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: actor.id, tokenHash: `policy-admin-${stamp}`, expiresAt: new Date(Date.now() + 60_000) }).returning({ id: refreshTokens.id }).get();
    const context = { userId: actor.id, sessionId: session.id };
    db.insert(ideaSettings).values([{ key: "departments", value: '["Risk"]' }, { key: "roles", value: '["employee","business_owner"]' }]).onConflictDoUpdate({ target: ideaSettings.key, set: { value: sql`excluded.value` } }).run();
    await assert.rejects(createUser(context, { name: "Blocked", email: `blocked-${stamp}@example.test`, department: "Treasury", role: "employee" }, "Policy check"), /allowed department/);
    await assert.rejects(createUser(context, { name: "Blocked", email: `blocked2-${stamp}@example.test`, department: "Risk", role: "back_office" }, "Policy check"), /allowed role/);
    const created = await createUser(context, { name: "Allowed", email: `allowed-${stamp}@example.test`, department: "Risk", role: "employee" }, "Approved onboarding");
    assert.equal(created.user.department, "Risk");
    assert.equal(changeUserRole(context, created.user.id, "business_owner", "Approved transfer").role, "business_owner");
  } finally {
    db.run(sql`ROLLBACK TO admin_user_policy_test`);
    db.run(sql`RELEASE admin_user_policy_test`);
  }
});

test("admin list pages cap at ten and expose navigable totals and cursors", async () => {
  const firstPage = parseAdminOffsetPage(new URL("https://example.test/admin"));
  assert.deepEqual(firstPage, { page: 1, pageSize: 10, offset: 0 });
  assert.throws(() => parseAdminOffsetPage(new URL("https://example.test/admin?pageSize=11")));
  assert.throws(() => parseAdminOffsetPage(new URL("https://example.test/admin?page=0")));
  for (const list of [listAdminAnnouncementPage, listAdminCampaignPage, listAdminRewardPage]) {
    const first = list(firstPage);
    assert.ok(first.items.length <= 10);
    assert.equal(first.pageSize, 10);
    assert.ok(first.total >= first.items.length);
    assert.equal(first.totalPages, Math.ceil(first.total / 10));
    if (first.total > 10) {
      const second = list(parseAdminOffsetPage(new URL("https://example.test/admin?page=2")));
      assert.ok(second.items.length > 0 && second.items.length <= 10);
      assert.notDeepEqual(second.items[0], first.items[0]);
    }
  }
  for (const list of [listAdminChallengePage, listAdminFeedbackPage, listAdminQuizPage]) {
    const first = list({ limit: 10, after: null });
    assert.ok(first.items.length <= 10);
    assert.ok(first.total >= first.items.length);
    if (first.nextAfter !== null) {
      const second = list({ limit: 10, after: first.nextAfter });
      assert.ok(second.items.length > 0 && second.items.length <= 10);
      assert.equal(second.total, first.total);
      assert.ok(second.items.every((item) => item.id < first.nextAfter!));
    }
  }
  const audit = await listAuditEvents({ limit: 10, after: null });
  assert.ok(audit.items.length <= 10);
  assert.ok(audit.total >= audit.items.length);
});
