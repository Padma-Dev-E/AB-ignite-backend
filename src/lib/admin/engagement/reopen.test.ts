import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

test("closing and reopening a campaign restores the sole pin and accepts feedback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ignite-campaign-reopen-"));
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = join(directory, "test.db");
  try {
    const { db } = await import("../../../db/connection");
    const { auditEvents, feedbackCampaigns, feedbackResponses, refreshTokens, users } = await import("../../../db/schema");
    const { setCampaignActive } = await import("./service");
    const { getFeedback, submitFeedback } = await import("../../articles/service");
    migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });

    const admin = db.insert(users).values({ name: "Campaign admin", email: "campaign-admin@example.test", role: "back_office", passwordHash: "test" }).returning().get();
    const employee = db.insert(users).values({ name: "Campaign employee", email: "campaign-employee@example.test", passwordHash: "test" }).returning().get();
    const session = db.insert(refreshTokens).values({ userId: admin.id, tokenHash: "campaign-admin-session", expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning().get();
    const employeeSession = db.insert(refreshTokens).values({ userId: employee.id, tokenHash: "campaign-employee-session", expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning().get();
    const original = db.insert(feedbackCampaigns).values({ title: "Original", description: "First survey", active: true, pinned: true }).returning().get();
    const replacement = db.insert(feedbackCampaigns).values({ title: "Replacement", description: "Second survey", active: false, pinned: false }).returning().get();
    const actor = (reason: string) => ({ userId: admin.id, sessionId: session.id, reason });
    const employeeContext = { userId: employee.id, sessionId: employeeSession.id };

    const closed = setCampaignActive(actor("Pause original survey"), original.id, false, "campaign-close-original");
    assert.equal(closed.active, false);
    assert.equal(closed.pinned, false);
    await assert.rejects(submitFeedback(employeeContext, { category: "experience", message: "Feedback while closed", idempotencyKey: "feedback-while-closed" }), /no active feedback campaign/i);

    const openedReplacement = setCampaignActive(actor("Select replacement survey"), replacement.id, true, "campaign-open-replacement");
    assert.equal(openedReplacement.active, true);
    assert.equal(openedReplacement.pinned, true);

    const reopened = setCampaignActive(actor("Resume original survey"), original.id, true, "campaign-reopen-original");
    assert.equal(reopened.active, true);
    assert.equal(reopened.pinned, true);
    assert.equal(db.select().from(feedbackCampaigns).where(eq(feedbackCampaigns.pinned, true)).all().length, 1);
    assert.equal(db.select().from(feedbackCampaigns).where(eq(feedbackCampaigns.id, replacement.id)).get()?.pinned, false);
    assert.equal((await getFeedback(employee.id)).campaign?.id, original.id);

    const submitted = await submitFeedback(employeeContext, { category: "experience", message: "Feedback after reopening", idempotencyKey: "feedback-after-reopen" });
    assert.equal(submitted.duplicate, false);
    assert.equal(db.select().from(feedbackResponses).where(eq(feedbackResponses.id, submitted.id)).get()?.campaignId, original.id);
    const lifecycleAudits = db.select().from(auditEvents).where(eq(auditEvents.action, "admin.engagement.campaign.lifecycle")).all();
    assert.deepEqual(lifecycleAudits.map((event) => event.reason), ["Pause original survey", "Select replacement survey", "Resume original survey"]);
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    rmSync(directory, { recursive: true, force: true });
  }
});
