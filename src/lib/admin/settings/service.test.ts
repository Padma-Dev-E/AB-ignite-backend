import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import { auditEvents, ideaSettings, levels, pointRules, refreshTokens, users } from "../../../db/schema";
import { getAdminSettings, updateAdminSettings } from "./service";

test("admin policy settings include all supported workflow controls and persist them with an audit reason", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const admin = db.insert(users).values({ name: "Settings admin", email: `settings-${stamp}@example.test`, role: "back_office", passwordHash: "test" }).returning().get();
  const session = db.insert(refreshTokens).values({ userId: admin.id, tokenHash: `settings-${stamp}`, expiresAt: new Date(Date.now() + 60_000) }).returning().get();
  const actor = { userId: admin.id, sessionId: session.id, reason: "Approved policy review" };
  const priority = {
    priority_kpis: JSON.stringify([
      { key: "turnaround", question: "Time saved?", hint: "Estimate days", weight: 0.3 },
      { key: "volume", question: "How many cases?", hint: "Estimate cases", weight: 0.3 },
      { key: "value", question: "Financial value?", hint: "Estimate value", weight: 0.4 },
    ]),
    priority_bands: JSON.stringify([{ name: "Watch", minimum: 0 }, { name: "Quality", minimum: 1.5 }, { name: "Priority", minimum: 2.5 }]),
    sla_days: JSON.stringify({ screening: 5, business_review: 10 }),
    required_controls: JSON.stringify(["risk review"]),
    departments: JSON.stringify(["Treasury", "Risk"]),
    demo_access: JSON.stringify({ enabled: false }),
    roles: JSON.stringify(["employee", "business_owner", "back_office"]),
  };
  try {
    await updateAdminSettings(actor, { priority });
    const settings = await getAdminSettings();
    for (const [key, value] of Object.entries(priority)) assert.equal(settings.priority[key], value);
    assert.deepEqual(settings.departments, ["Treasury", "Risk"]);
    const audit = db.select().from(auditEvents).where(eq(auditEvents.action, "admin.settings.updated")).all().find((row) => row.actorUserId === admin.id);
    assert.equal(audit?.reason, actor.reason);
    assert.equal(JSON.parse(audit?.metadataJson ?? "{}").result, Object.keys(priority).length);
    const changes = db.select().from(auditEvents).where(eq(auditEvents.action, "admin.settings.policy_changed")).all().filter((row) => row.actorUserId === admin.id);
    assert.equal(changes.length, Object.keys(priority).length);
    const slaChange = changes.find((row) => row.targetId === "sla_days");
    assert.equal(JSON.parse(slaChange?.metadataJson ?? "{}").toStatus, priority.sla_days);
    const pointRule = db.select().from(pointRules).limit(1).get()!;
    const level = db.select().from(levels).limit(1).get()!;
    await updateAdminSettings(actor, { pointRules: [{ code: pointRule.code, points: pointRule.points + 1, active: pointRule.active }], levels: [{ id: level.id, name: level.name, description: level.description, minimumPoints: level.minimumPoints + 1, sortOrder: level.sortOrder }] });
    const recordChanges = db.select().from(auditEvents).where(eq(auditEvents.action, "admin.settings.policy_changed")).all().filter((row) => row.actorUserId === admin.id);
    assert.ok(recordChanges.some((row) => row.targetType === "point_rule" && row.targetId === pointRule.code));
    assert.ok(recordChanges.some((row) => row.targetType === "level" && row.targetId === String(level.id)));
  } finally {
    db.update(users).set({ isActive: false }).where(eq(users.id, admin.id)).run();
    db.delete(ideaSettings).where(eq(ideaSettings.updatedBy, admin.id)).run();
  }
});

test("admin policy validation rejects malformed bounded controls without writing settings", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const admin = db.insert(users).values({ name: "Settings admin", email: `settings-invalid-${stamp}@example.test`, role: "back_office", passwordHash: "test" }).returning().get();
  const session = db.insert(refreshTokens).values({ userId: admin.id, tokenHash: `settings-invalid-${stamp}`, expiresAt: new Date(Date.now() + 60_000) }).returning().get();
  try {
    await assert.rejects(updateAdminSettings({ userId: admin.id, sessionId: session.id, reason: "Invalid controls" }, { priority: { sla_days: JSON.stringify({ screening: 999 }) } }));
    await assert.rejects(updateAdminSettings({ userId: admin.id, sessionId: session.id, reason: "Invalid controls" }, { priority: { priority_kpis: JSON.stringify([{ key: "turnaround", question: "Time", hint: "Time", weight: 1 }]) } }));
    assert.equal(db.select().from(ideaSettings).where(eq(ideaSettings.key, "sla_days")).get(), undefined);
  } finally { db.update(users).set({ isActive: false }).where(eq(users.id, admin.id)).run(); }
});
