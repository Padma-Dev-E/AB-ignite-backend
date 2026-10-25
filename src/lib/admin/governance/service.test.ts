import test from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../db/connection";
import { auditEvents, ideaEvents, ideaReviews, ideaSettings, ideaSubmissions, ideas, notifications, refreshTokens, users } from "../../../db/schema";
import { decideGovernance, getEvaluation, listBusinessOwners, listDeliveryQueue, listRoutedEvaluations, listScreeningQueue, listTransformationQueue, requireGovernanceRole } from "./service";
import { adminAccess, CAPABILITIES } from "../http";

test("back-office can accept a screening idea directly without a business-owner approval", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const makeUser = (name: string, role: "employee" | "back_office") => {
    const user = db.insert(users).values({ name, email: `${name}-${stamp}@example.test`, role, passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${name}-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = makeUser("direct-accept-employee", "employee");
  const reviewer = makeUser("direct-accept-reviewer", "back_office");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Directly accepted idea", summary: "A screening idea accepted by back office.", problem: "Manual rechecking causes delays.", solution: "Validate a complete set automatically.", benefits: "Fewer repeat contacts.", risks: "Incorrect matches need review.", category: "Technology", reference: `ABI-DIRECT-${stamp}` }).returning({ id: ideas.id }).get();

  const acceptKey = `direct-accept-${stamp}`;
  const result = await decideGovernance(reviewer, idea.id, "accept", "Accept for proof of concept", undefined, undefined, acceptKey);
  assert.deepEqual(await decideGovernance(reviewer, idea.id, "accept", "Accept for proof of concept", undefined, undefined, acceptKey), result);

  assert.deepEqual(result, { ideaId: idea.id, action: "accept", fromStatus: "screening", toStatus: "poc" });
  assert.deepEqual(db.select({ status: ideas.status, assignedUserId: ideas.assignedUserId }).from(ideas).where(eq(ideas.id, idea.id)).get(), { status: "poc", assignedUserId: null });
  assert.equal(db.select().from(ideaEvents).all().some((event) => event.ideaId === idea.id && event.eventType === "screening_accepted" && event.fromStatus === "screening" && event.toStatus === "poc"), true);
  const acceptedDetail = await getEvaluation(idea.id, reviewer);
  assert.equal(acceptedDetail.idea.problem, "Manual rechecking causes delays.");
  assert.equal(acceptedDetail.idea.solution, "Validate a complete set automatically.");
  assert.equal(acceptedDetail.idea.benefits, "Fewer repeat contacts.");
  assert.equal(acceptedDetail.idea.risks, "Incorrect matches need review.");
  assert.equal(db.select().from(ideaReviews).all().some((review) => review.ideaId === idea.id && review.decision === "approved" && review.reviewerId === reviewer.userId), true);
  assert.equal(db.select().from(notifications).all().some((item) => item.userId === employee.userId && item.type === "idea_accepted" && item.body?.includes("Congratulations")), true);
  assert.equal(db.select().from(auditEvents).all().some((item) => item.targetId === String(idea.id) && item.action === "admin.governance.accept"), true);

  const unauthorizedIdea = db.insert(ideas).values({ authorId: employee.userId, title: "Employee cannot accept", summary: "A screening idea for authorization coverage.", category: "Technology", reference: `ABI-DIRECT-DENIED-${stamp}` }).returning({ id: ideas.id }).get();
  await assert.rejects(decideGovernance(employee, unauthorizedIdea.id, "accept", "Unauthorized direct acceptance"));
});

test("back-office governance and business-owner decisions enforce current assignment", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  function principal(profile: string) {
    const user = db.insert(users).values({ name: profile, email: `${profile}-${stamp}@example.test`, role: profile === "employee" ? "employee" : profile === "business_owner" ? "business_owner" : "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  }
  const employee = principal("employee");
  const reviewer = principal("reviewer");
  const owner = principal("business_owner");
  const control = principal("control");
  const management = principal("management");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "RBAC idea", summary: "Test", category: "Technology", reference: `ABI-RBAC-${stamp}` }).returning({ id: ideas.id }).get();
  await assert.rejects(requireGovernanceRole(employee, ["back_office"]));
  await assert.rejects(listRoutedEvaluations(employee));
  await requireGovernanceRole(management, ["back_office"]);
  await assert.rejects(decideGovernance(reviewer, idea.id, "route", "send for review", employee.userId));
  await decideGovernance(reviewer, idea.id, "route", "send for review", owner.userId);
  assert.equal((await listRoutedEvaluations(owner)).items.some((item) => item.id === idea.id), true);
  assert.equal((await getEvaluation(idea.id, owner)).idea.id, idea.id);
  await assert.rejects(decideGovernance(reviewer, idea.id, "confirm", "final confirmation"));
  await assert.rejects(decideGovernance(reviewer, idea.id, "approve", "owner only"));
  await decideGovernance(owner, idea.id, "approve", "business case approved");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "control_review");
  assert.ok((await listRoutedEvaluations(control)).items.some((item) => item.id === idea.id));
  assert.equal((await listRoutedEvaluations(owner)).items.some((item) => item.id === idea.id), false);
  assert.ok(db.select().from(ideaReviews).all().some((review) => review.ideaId === idea.id && review.reviewerId === owner.userId));
  await assert.rejects(decideGovernance(reviewer, idea.id, "confirm", "premature confirmation"));
  await decideGovernance(control, idea.id, "approve", "control review passed");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
  assert.ok(db.select().from(ideaEvents).all().some((event) => event.ideaId === idea.id && event.eventType === "control_approved"));
  await decideGovernance(reviewer, idea.id, "confirm", "accepted for proof of concept");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "poc");
  assert.ok((await listDeliveryQueue(reviewer)).items.some((item) => item.id === idea.id));
  await assert.rejects(listDeliveryQueue(employee));
  assert.equal(db.select().from(notifications).where(eq(notifications.userId, employee.userId)).all().filter((notification) => notification.type === "idea_accepted" && notification.body?.includes("Congratulations")).length, 1);
  await decideGovernance(reviewer, idea.id, "start_implementation", "POC completed successfully");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "implementation");
  await decideGovernance(reviewer, idea.id, "mark_implemented", "Impact target achieved");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "implemented");
  const queue = await listTransformationQueue(100);
  assert.equal(queue.items.some((item) => item.id === idea.id), false);
});

test("governance detail and owner list require the actual authorized session and current assignment", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  let sequence = 0;
  const make = (profile: string) => {
    const suffix = `${stamp}-${++sequence}`;
    const user = db.insert(users).values({ name: profile, email: `${profile}-private-${suffix}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-private-${suffix}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee");
  const reviewer = make("reviewer");
  const owner = make("business_owner");
  const otherOwner = make("business_owner");
  const inconsistentOwner = db.insert(users).values({ name: "Inconsistent owner", email: `inconsistent-owner-${stamp}@example.test`, role: "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Private review", summary: "Only assigned owner can evaluate", category: "Technology", reference: `ABI-PRIVATE-${stamp}` }).returning({ id: ideas.id }).get();
  await assert.rejects(adminAccess({ user: { id: String(employee.userId), sessionId: String(employee.sessionId) } } as Parameters<typeof adminAccess>[0], CAPABILITIES.GOVERNANCE_READ));
  await assert.rejects(getEvaluation(idea.id, employee));
  assert.equal((await getEvaluation(idea.id, reviewer)).idea.id, idea.id);
  await assert.rejects(listRoutedEvaluations({ userId: owner.userId, sessionId: reviewer.sessionId }));
  await assert.rejects(decideGovernance(reviewer, idea.id, "route", "Wrong profile", employee.userId));
  assert.ok((await listBusinessOwners(reviewer)).items.some((item) => item.id === owner.userId));
  assert.equal((await listBusinessOwners(reviewer)).items.some((item) => item.id === inconsistentOwner.id), false);
  await assert.rejects(listBusinessOwners(employee));
  await assert.rejects(decideGovernance(reviewer, idea.id, "route", "Inconsistent owner", inconsistentOwner.id));
  const key = `assign-owner-${stamp}`;
  await decideGovernance(reviewer, idea.id, "route", "Assign owner", owner.userId, undefined, key);
  assert.deepEqual(await decideGovernance(reviewer, idea.id, "route", "Assign owner", owner.userId, undefined, key), { ideaId: idea.id, action: "route", fromStatus: "screening", toStatus: "business_review" });
  const routedEvent = db.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents).where(eq(ideaEvents.ideaId, idea.id)).get();
  const persistedDueAt = db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt;
  assert.equal((JSON.parse(routedEvent!.metadataJson!) as { dueAt: string }).dueAt, persistedDueAt?.toISOString());
  await assert.rejects(getEvaluation(idea.id, reviewer));
  await assert.rejects(getEvaluation(idea.id, otherOwner));
  assert.equal((await getEvaluation(idea.id, owner)).idea.id, idea.id);
  await assert.rejects(decideGovernance(otherOwner, idea.id, "approve", "Not assigned"));
});

test("confirmation queue contains only owner-approved ideas ready for confirmation", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const make = (profile: string) => {
    const user = db.insert(users).values({ name: profile, email: `${profile}-queue-${stamp}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-queue-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee"), reviewer = make("reviewer"), owner = make("business_owner"), control = make("control");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Queue stages", summary: "Only awaiting confirmation", category: "Technology", reference: `ABI-QUEUE-${stamp}` }).returning({ id: ideas.id }).get();
  assert.ok((await listScreeningQueue(100)).items.find((row) => row.id === idea.id)?.dueAt instanceof Date);
  await decideGovernance(reviewer, idea.id, "route", "Owner assessment", owner.userId);
  await decideGovernance(owner, idea.id, "approve", "Business approved");
  assert.equal((await listTransformationQueue(100)).items.some((row) => row.id === idea.id), false);
  await decideGovernance(control, idea.id, "approve", "Control approved");
  assert.ok(db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt);
  const confirmation = (await listTransformationQueue(100)).items.find((row) => row.id === idea.id);
  assert.ok(confirmation);
  assert.ok(confirmation.dueAt && confirmation.dueAt.getTime() > Date.now() + 2 * 86_400_000);
  await decideGovernance(reviewer, idea.id, "confirm", "Accept idea");
  assert.equal((await listTransformationQueue(100)).items.some((row) => row.id === idea.id), false);
});

test("screening due date starts when a saved draft is submitted", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const author = db.insert(users).values({ name: "Draft author", email: `draft-due-${stamp}@example.test`, passwordHash: "test" }).returning({ id: users.id }).get();
  const idea = db.insert(ideas).values({ authorId: author.id, title: "Old draft", summary: "Submitted today", category: "Technology", reference: `ABI-DUE-${stamp}`, status: "screening", createdAt: new Date(Date.now() - 20 * 86_400_000) }).returning({ id: ideas.id }).get();
  db.insert(ideaSubmissions).values({ ideaId: idea.id, answersJson: "{}", metricsJson: "{}", score: 2, minimumScore: 2, submittedAt: new Date() }).run();
  const queued = (await listScreeningQueue(100)).items.find((item) => item.id === idea.id);
  assert.ok(queued?.dueAt && queued.dueAt.getTime() > Date.now() + 2 * 86_400_000);
});

test("a policy change after owner approval does not add a new control gate", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const make = (profile: string) => {
    const user = db.insert(users).values({ name: profile, email: `${profile}-policy-${stamp}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-policy-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee"), reviewer = make("reviewer"), owner = make("business_owner");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Policy snapshot", summary: "Control requirement at owner decision", category: "Technology", reference: `ABI-POLICY-${stamp}` }).returning({ id: ideas.id }).get();
  await decideGovernance(reviewer, idea.id, "route", "Assign owner", owner.userId);
  db.run(sql`SAVEPOINT governance_policy_test`);
  try {
    db.insert(ideaSettings).values({ key: "required_controls", value: "[]" }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: "[]" } }).run();
    await decideGovernance(owner, idea.id, "approve", "Owner approves without required controls");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
    db.update(ideaSettings).set({ value: '["Risk"]' }).where(eq(ideaSettings.key, "required_controls")).run();
    await decideGovernance(reviewer, idea.id, "confirm", "Confirm under the approval policy");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "poc");
  } finally {
    db.run(sql`ROLLBACK TO governance_policy_test`);
    db.run(sql`RELEASE governance_policy_test`);
  }
});

test("SLA limits routing and named controls require separate audited approvals", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  let sequence = 0;
  const make = (profile: string) => {
    const suffix = `${stamp}-${++sequence}`;
    const user = db.insert(users).values({ name: profile, email: `${profile}-enforcement-${suffix}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-enforcement-${suffix}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee"), reviewer = make("reviewer"), owner = make("business_owner"), control = make("control"), secondControl = make("control");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Named controls", summary: "Test", category: "Technology", reference: `ABI-CONTROL-${stamp}` }).returning({ id: ideas.id }).get();
  db.run(sql`SAVEPOINT governance_named_controls_test`);
  try {
    db.insert(ideaSettings).values({ key: "sla_days", value: '{"business_review":3,"control_review":4,"decision":5}' }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: '{"business_review":3,"control_review":4,"decision":5}' } }).run();
    db.insert(ideaSettings).values({ key: "required_controls", value: '["Risk","Compliance"]' }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: '["Risk","Compliance"]' } }).run();
    await assert.rejects(decideGovernance(reviewer, idea.id, "route", "Too late", owner.userId, new Date(Date.now() + 5 * 86_400_000)), /SLA/);
    await assert.rejects(decideGovernance(reviewer, idea.id, "route", "Already late", owner.userId, new Date(Date.now() - 1000)), /SLA/);
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "screening");
    await decideGovernance(reviewer, idea.id, "route", "Assign within SLA", owner.userId);
    const routedDue = db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt;
    assert.ok(routedDue && routedDue.getTime() > Date.now() + 2 * 86_400_000 && routedDue.getTime() <= Date.now() + 3 * 86_400_000);
    await decideGovernance(owner, idea.id, "approve", "Business case accepted");
    const controlDue = db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt;
    assert.ok(controlDue && controlDue.getTime() > Date.now() + 3 * 86_400_000);
    assert.deepEqual((await getEvaluation(idea.id, control)).controlReview?.pending, ["Risk", "Compliance"]);
    db.update(ideaSettings).set({ value: "[]" }).where(eq(ideaSettings.key, "required_controls")).run();
    await assert.rejects(decideGovernance(control, idea.id, "approve", "Ambiguous control"), /Select a required control/);
    await assert.rejects(decideGovernance(control, idea.id, "approve", "Wrong control", undefined, undefined, undefined, "Security"), /Select a required control/);
    const key = `risk-approval-${stamp}`;
    const first = await decideGovernance(control, idea.id, "approve", "Risk accepted", undefined, undefined, key, "risk");
    assert.equal(first.toStatus, "control_review");
    assert.deepEqual((await getEvaluation(idea.id, secondControl)).controlReview, { required: ["Risk", "Compliance"], approved: ["Risk"], pending: ["Compliance"] });
    assert.equal(db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt?.getTime(), controlDue.getTime());
    assert.deepEqual(await decideGovernance(control, idea.id, "approve", "Risk accepted", undefined, undefined, key, "risk"), first);
    await assert.rejects(decideGovernance(control, idea.id, "approve", "Risk accepted", undefined, undefined, key, "Compliance"), /Idempotency/);
    await assert.rejects(decideGovernance(control, idea.id, "approve", "Risk again", undefined, undefined, undefined, "Risk"), /already approved/);
    await assert.rejects(decideGovernance(control, idea.id, "approve", "Same reviewer", undefined, undefined, undefined, "Compliance"), /different control reviewer/);
    assert.ok(db.select().from(auditEvents).where(eq(auditEvents.targetId, String(idea.id))).all().some((row) => row.action === "admin.governance.approve" && row.metadataJson?.includes('"controlName":"Risk"')));
    db.update(ideas).set({ status: "decision" }).where(eq(ideas.id, idea.id)).run();
    await assert.rejects(decideGovernance(reviewer, idea.id, "confirm", "Cannot skip Compliance"), /All required controls/);
    db.update(ideas).set({ status: "control_review" }).where(eq(ideas.id, idea.id)).run();
    await decideGovernance(secondControl, idea.id, "approve", "Compliance accepted", undefined, undefined, undefined, "Compliance");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
    await decideGovernance(reviewer, idea.id, "confirm", "All controls complete");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "poc");
  } finally {
    db.run(sql`ROLLBACK TO governance_named_controls_test`);
    db.run(sql`RELEASE governance_named_controls_test`);
  }
});

test("business owner approval and transformation confirmation require distinct workspace roles", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const make = (profile: string) => {
    const user = db.insert(users).values({ name: profile, email: `${profile}-roles-${stamp}@example.test`, role: profile === "employee" ? "employee" : profile === "business_owner" ? "business_owner" : "back_office", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-roles-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee");
  const reviewer = make("reviewer");
  const owner = make("business_owner");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Role boundary", summary: "Distinct owner and transformation authority.", category: "Technology", reference: `ABI-ROLE-${stamp}` }).returning({ id: ideas.id }).get();
  await decideGovernance(reviewer, idea.id, "route", "Route to owner", owner.userId);
  db.update(ideas).set({ status: "business_review", assignedUserId: employee.userId }).where(eq(ideas.id, idea.id)).run();
  db.insert(ideaEvents).values({ ideaId: idea.id, actorType: "admin", actorId: reviewer.userId, eventType: "business_owner_routed", toStatus: "business_review", metadataJson: JSON.stringify({ businessOwnerId: employee.userId }) }).run();
  await assert.rejects(decideGovernance(employee, idea.id, "approve", "Employee cannot approve"));
});
