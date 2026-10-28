import test from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db } from "../../db/connection";
import { ideaEvents, ideas, users } from "../../db/schema";
import { canTransitionIdeaStatus, transitionIdeaStatus } from "./workflow";

test("post-assignment lifecycle transitions are owner-only and ownership is checked atomically", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const owner = db.insert(users).values({ name: "Workflow owner", email: `workflow-owner-${stamp}@example.test`, role: "business_owner", passwordHash: "test" }).returning({ id: users.id }).get();
  const otherOwner = db.insert(users).values({ name: "Other workflow owner", email: `workflow-other-${stamp}@example.test`, role: "business_owner", passwordHash: "test" }).returning({ id: users.id }).get();
  const admin = db.insert(users).values({ name: "Workflow admin", email: `workflow-admin-${stamp}@example.test`, role: "admin", passwordHash: "test" }).returning({ id: users.id }).get();
  const maintainer = db.insert(users).values({ name: "Workflow maintainer", email: `workflow-maintainer-${stamp}@example.test`, role: "maintainer", passwordHash: "test" }).returning({ id: users.id }).get();
  const idea = db.insert(ideas).values({ authorId: owner.id, title: "Lifecycle ownership", summary: "Delivery actions remain with the assigned owner.", category: "Technology", reference: `ABI-WORKFLOW-${stamp}`, status: "business_review", assignedUserId: owner.id }).returning({ id: ideas.id }).get();

  assert.equal(canTransitionIdeaStatus({ kind: "admin", id: String(admin.id) }, "implementation", "implemented"), false);
  assert.equal(canTransitionIdeaStatus({ kind: "maintainer", id: String(maintainer.id) }, "implementation", "implemented"), false);
  assert.equal(canTransitionIdeaStatus({ kind: "business_owner", id: String(owner.id) }, "implementation", "implemented"), true);
  await assert.rejects(transitionIdeaStatus({ kind: "admin", id: String(admin.id) }, idea.id, "decision", "Admin cannot decide"), /not authorized/);
  await assert.rejects(transitionIdeaStatus({ kind: "maintainer", id: String(maintainer.id) }, idea.id, "decision", "Maintainer cannot decide"), /not authorized/);
  await assert.rejects(transitionIdeaStatus({ kind: "business_owner", id: String(otherOwner.id) }, idea.id, "decision", "Unassigned owner cannot decide"), /not assigned/);
  await transitionIdeaStatus({ kind: "business_owner", id: String(owner.id) }, idea.id, "decision", "Owner accepted the business case");
  assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
  assert.equal(db.select().from(ideaEvents).all().some((event) => event.ideaId === idea.id && event.fromStatus === "business_review" && event.toStatus === "decision"), true);
});
