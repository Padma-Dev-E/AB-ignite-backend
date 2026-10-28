import test from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db } from "../../../db/connection";
import { auditEvents, ideaEvents, ideaReviews, ideaSettings, ideaSubmissions, ideas, notifications, refreshTokens, users } from "../../../db/schema";
import { assignBusinessOwner, decideGovernance, getEvaluation, listBusinessOwners, listDeliveryQueue, listGovernanceIdeas, listRoutedEvaluations, listScreeningQueue, listTransformationQueue, requireGovernanceRole } from "./service";

test("admins accept screening ideas into owner matching without assigning an owner", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const makeUser = (name: string, role: "employee" | "admin") => {
    const user = db.insert(users).values({ name, email: `${name}-${stamp}@example.test`, role, passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${name}-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = makeUser("direct-accept-employee", "employee");
  const reviewer = makeUser("direct-accept-reviewer", "admin");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Directly accepted idea", summary: "A screening idea accepted by back office.", problem: "Manual rechecking causes delays.", solution: "Validate a complete set automatically.", benefits: "Fewer repeat contacts.", risks: "Incorrect matches need review.", category: "Technology", reference: `ABI-DIRECT-${stamp}` }).returning({ id: ideas.id }).get();

  const acceptKey = `direct-accept-${stamp}`;
  const result = await decideGovernance(reviewer, idea.id, "accept", "Accept for owner matching", acceptKey);
  assert.deepEqual(await decideGovernance(reviewer, idea.id, "accept", "Accept for owner matching", acceptKey), result);

  assert.deepEqual(result, { ideaId: idea.id, action: "accept", fromStatus: "screening", toStatus: "owner_matching" });
  assert.deepEqual(db.select({ status: ideas.status, assignedUserId: ideas.assignedUserId }).from(ideas).where(eq(ideas.id, idea.id)).get(), { status: "owner_matching", assignedUserId: null });
  assert.equal(db.select().from(ideaEvents).all().some((event) => event.ideaId === idea.id && event.eventType === "screening_accepted" && event.fromStatus === "screening" && event.toStatus === "owner_matching"), true);
  const acceptedDetail = await getEvaluation(idea.id, reviewer);
  assert.equal(acceptedDetail.idea.problem, "Manual rechecking causes delays.");
  assert.equal(acceptedDetail.idea.solution, "Validate a complete set automatically.");
  assert.equal(acceptedDetail.idea.benefits, "Fewer repeat contacts.");
  assert.equal(acceptedDetail.idea.risks, "Incorrect matches need review.");
  assert.equal(db.select().from(ideaReviews).all().some((review) => review.ideaId === idea.id && review.decision === "approved" && review.reviewerId === reviewer.userId), true);
  assert.equal(db.select().from(notifications).all().some((item) => item.userId === employee.userId && item.type === "idea_accepted" && item.body?.includes("matched with a business owner")), true);
  assert.equal(db.select().from(auditEvents).all().some((item) => item.targetId === String(idea.id) && item.action === "admin.governance.accept"), true);

  const unauthorizedIdea = db.insert(ideas).values({ authorId: employee.userId, title: "Employee cannot accept", summary: "A screening idea for authorization coverage.", category: "Technology", reference: `ABI-DIRECT-DENIED-${stamp}` }).returning({ id: ideas.id }).get();
  await assert.rejects(decideGovernance(employee, unauthorizedIdea.id, "accept", "Unauthorized direct acceptance"));
});

test("maintainers accept to owner matching, assign active owners, monitor progress, and cannot mutate owner lifecycle", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  function principal(name: string, role: "employee" | "admin" | "maintainer" | "business_owner", active = true) {
    const user = db.insert(users).values({ name, email: `${name}-${stamp}@example.test`, role, isActive: active, businessProfile: role === "business_owner" ? "Retail payments and digital onboarding" : null, passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${name}-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  }
  const employee = principal("maintainer-flow-employee", "employee");
  const maintainer = principal("maintainer-flow-reviewer", "maintainer");
  const admin = principal("maintainer-flow-admin", "admin");
  const firstOwner = principal("maintainer-flow-owner-one", "business_owner");
  const secondOwner = principal("maintainer-flow-owner-two", "business_owner");
  const inactiveOwner = principal("maintainer-flow-owner-inactive", "business_owner", false);
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Maintainer accepted idea", summary: "An accepted idea requires owner matching.", category: "Technology", reference: `ABI-MAINT-${stamp}` }).returning({ id: ideas.id }).get();
  const draft = db.insert(ideas).values({ authorId: employee.userId, title: "Private draft", summary: "Drafts are never in governance monitoring.", category: "Technology", reference: `ABI-MAINT-DRAFT-${stamp}`, status: "draft" }).returning({ id: ideas.id }).get();

  assert.equal((await listGovernanceIdeas(maintainer)).items.some((item) => item.id === idea.id), true);
  assert.equal((await listGovernanceIdeas(maintainer)).items.some((item) => item.id === draft.id), false);
  assert.equal((await decideGovernance(maintainer, idea.id, "accept", "Accept for matching")).toStatus, "owner_matching");
  assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "owner_matching");
  await assert.rejects(assignBusinessOwner(maintainer, idea.id, inactiveOwner.userId), /Active business owner/);
  assert.equal((await listBusinessOwners(maintainer)).items.find((owner) => owner.id === firstOwner.userId)?.businessProfile, "Retail payments and digital onboarding");
  assert.deepEqual((await listBusinessOwners(firstOwner)).items.map((owner) => owner.id), [firstOwner.userId]);

  const idempotencyKey = `assign-maintainer-${stamp}`;
  const assigned = await assignBusinessOwner(maintainer, idea.id, firstOwner.userId, idempotencyKey);
  assert.deepEqual(assigned, { ideaId: idea.id, action: "assign_owner", fromStatus: "owner_matching", toStatus: "business_review", businessOwnerId: firstOwner.userId });
  assert.deepEqual(await assignBusinessOwner(maintainer, idea.id, firstOwner.userId, idempotencyKey), assigned);
  assert.equal(db.select().from(ideaEvents).all().filter((event) => event.ideaId === idea.id && event.eventType === "business_owner_assigned").length, 1);

  await decideGovernance(firstOwner, idea.id, "approve", "Owner accepts the business case");
  await decideGovernance(firstOwner, idea.id, "confirm", "Owner confirms delivery");
  await decideGovernance(firstOwner, idea.id, "start_implementation", "Owner starts implementation");
  assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "implementation");
  assert.equal((await listGovernanceIdeas(maintainer)).items.some((item) => item.id === idea.id), true);
  assert.equal((await getEvaluation(idea.id, maintainer)).idea.id, idea.id);
  await assert.rejects(decideGovernance(maintainer, idea.id, "mark_implemented", "Must remain owner-controlled"), /Business owner/);

  const reassigned = await assignBusinessOwner(admin, idea.id, secondOwner.userId, `reassign-maintainer-${stamp}`);
  assert.deepEqual(reassigned, { ideaId: idea.id, action: "reassign_owner", fromStatus: "implementation", toStatus: "implementation", businessOwnerId: secondOwner.userId });
  await assert.rejects(decideGovernance(firstOwner, idea.id, "mark_implemented", "Old owner lost access"));
  await decideGovernance(secondOwner, idea.id, "mark_implemented", "New owner completes delivery");
  assert.equal(db.select({ status: ideas.status, assignedUserId: ideas.assignedUserId }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "implemented");
  assert.equal(db.select().from(auditEvents).all().some((event) => event.targetId === String(idea.id) && event.action === "admin.governance.owner_reassigned"), true);
  assert.equal(db.select().from(notifications).all().filter((notification) => notification.userId === secondOwner.userId && notification.type === "idea_routed").length, 1);
});

test("back-office governance and business-owner decisions enforce current assignment", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  function principal(profile: string) {
    const user = db.insert(users).values({ name: profile, email: `${profile}-${stamp}@example.test`, role: profile === "employee" ? "employee" : profile === "business_owner" ? "business_owner" : "admin", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  }
  const employee = principal("employee");
  const reviewer = principal("reviewer");
  const owner = principal("business_owner");
  const management = principal("management");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "RBAC idea", summary: "Test", category: "Technology", reference: `ABI-RBAC-${stamp}` }).returning({ id: ideas.id }).get();
  await assert.rejects(requireGovernanceRole(employee, ["admin", "maintainer"]));
  await assert.rejects(listRoutedEvaluations(employee));
  await requireGovernanceRole(management, ["admin", "maintainer"]);
  await decideGovernance(reviewer, idea.id, "accept", "send for matching");
  await assert.rejects(assignBusinessOwner(reviewer, idea.id, employee.userId));
  await assignBusinessOwner(reviewer, idea.id, owner.userId);
  assert.equal((await listRoutedEvaluations(owner)).items.some((item) => item.id === idea.id), true);
  assert.equal((await getEvaluation(idea.id, owner)).idea.id, idea.id);
  await assert.rejects(decideGovernance(reviewer, idea.id, "confirm", "final confirmation"));
  await assert.rejects(decideGovernance(reviewer, idea.id, "approve", "owner only"));
  await decideGovernance(owner, idea.id, "approve", "business case approved");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
  assert.ok((await listTransformationQueue(reviewer)).items.some((item) => item.id === idea.id));
  assert.equal((await listRoutedEvaluations(owner)).items.some((item) => item.id === idea.id), true);
  assert.ok(db.select().from(ideaReviews).all().some((review) => review.ideaId === idea.id && review.reviewerId === owner.userId));
  await decideGovernance(owner, idea.id, "confirm", "accepted for proof of concept");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "poc");
  assert.ok((await listDeliveryQueue(reviewer)).items.some((item) => item.id === idea.id));
  await assert.rejects(listDeliveryQueue(employee));
  assert.equal(db.select().from(notifications).where(eq(notifications.userId, employee.userId)).all().filter((notification) => notification.type === "idea_accepted" && notification.body?.includes("Congratulations")).length, 1);
  await decideGovernance(owner, idea.id, "start_implementation", "POC completed successfully");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "implementation");
  await decideGovernance(owner, idea.id, "mark_implemented", "Impact target achieved");
  assert.equal(db.select().from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "implemented");
  const queue = await listTransformationQueue(reviewer, 100);
  assert.equal(queue.items.some((item) => item.id === idea.id), false);
});

test("governance detail and owner list require the actual authorized session and current assignment", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  let sequence = 0;
  const make = (profile: string) => {
    const suffix = `${stamp}-${++sequence}`;
    const user = db.insert(users).values({ name: profile, email: `${profile}-private-${suffix}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "admin", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-private-${suffix}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee");
  const reviewer = make("reviewer");
  const owner = make("business_owner");
  const otherOwner = make("business_owner");
  const inconsistentOwner = db.insert(users).values({ name: "Inconsistent owner", email: `inconsistent-owner-${stamp}@example.test`, role: "admin", passwordHash: "test" }).returning({ id: users.id }).get();
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Private review", summary: "Only assigned owner can evaluate", category: "Technology", reference: `ABI-PRIVATE-${stamp}` }).returning({ id: ideas.id }).get();
  await assert.rejects(getEvaluation(idea.id, employee));
  assert.equal((await getEvaluation(idea.id, reviewer)).idea.id, idea.id);
  await assert.rejects(listRoutedEvaluations({ userId: owner.userId, sessionId: reviewer.sessionId }));
  await decideGovernance(reviewer, idea.id, "accept", "Accept for assignment");
  await assert.rejects(assignBusinessOwner(reviewer, idea.id, employee.userId));
  assert.ok((await listBusinessOwners(reviewer)).items.some((item) => item.id === owner.userId));
  assert.equal((await listBusinessOwners(reviewer)).items.some((item) => item.id === inconsistentOwner.id), false);
  await assert.rejects(listBusinessOwners(employee));
  await assert.rejects(assignBusinessOwner(reviewer, idea.id, inconsistentOwner.id));
  const key = `assign-owner-${stamp}`;
  await assignBusinessOwner(reviewer, idea.id, owner.userId, key);
  assert.deepEqual(await assignBusinessOwner(reviewer, idea.id, owner.userId, key), { ideaId: idea.id, action: "assign_owner", fromStatus: "owner_matching", toStatus: "business_review", businessOwnerId: owner.userId });
  const routedEvent = db.select({ metadataJson: ideaEvents.metadataJson }).from(ideaEvents).where(eq(ideaEvents.ideaId, idea.id)).all().find((event) => event.metadataJson?.includes('"action":"assign_owner"'));
  const persistedDueAt = db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt;
  assert.equal((JSON.parse(routedEvent!.metadataJson!) as { businessOwnerId: number }).businessOwnerId, owner.userId);
  assert.ok(persistedDueAt);
  assert.equal((await getEvaluation(idea.id, reviewer)).idea.id, idea.id);
  await assert.rejects(getEvaluation(idea.id, otherOwner));
  assert.equal((await getEvaluation(idea.id, owner)).idea.id, idea.id);
  await assert.rejects(decideGovernance(otherOwner, idea.id, "approve", "Not assigned"));
});

test("owner-approved ideas appear in the transformation confirmation queue", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const make = (profile: string) => {
    const user = db.insert(users).values({ name: profile, email: `${profile}-queue-${stamp}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "admin", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-queue-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee"), reviewer = make("reviewer"), owner = make("business_owner");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Queue stages", summary: "Only awaiting confirmation", category: "Technology", reference: `ABI-QUEUE-${stamp}` }).returning({ id: ideas.id }).get();
  assert.ok((await listScreeningQueue(reviewer, 100)).items.find((row) => row.id === idea.id)?.dueAt instanceof Date);
  await decideGovernance(reviewer, idea.id, "accept", "Owner assessment");
  await assignBusinessOwner(reviewer, idea.id, owner.userId);
  await decideGovernance(owner, idea.id, "approve", "Business approved");
  const confirmation = (await listTransformationQueue(reviewer, 100)).items.find((row) => row.id === idea.id);
  assert.ok(confirmation);
  assert.ok(db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt);
  assert.ok(confirmation.dueAt && confirmation.dueAt.getTime() > Date.now() + 2 * 86_400_000);
  await decideGovernance(owner, idea.id, "confirm", "Accept idea");
  assert.equal((await listTransformationQueue(reviewer, 100)).items.some((row) => row.id === idea.id), false);
});

test("the assigned business owner can approve every distinct required control but cannot duplicate one", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const owner = db.insert(users).values({ name: "Single control owner", email: `single-control-${stamp}@example.test`, role: "business_owner", passwordHash: "test" }).returning({ id: users.id }).get();
  const idea = db.insert(ideas).values({ authorId: owner.id, title: "Single owner controls", summary: "One accountable owner completes distinct controls.", category: "Technology", reference: `ABI-CTRL-${stamp}`, status: "control_review", assignedUserId: owner.id }).returning({ id: ideas.id }).get();
  db.insert(ideaSettings).values({ key: "required_controls", value: '["Risk","Compliance"]' }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: '["Risk","Compliance"]' } }).run();
  db.insert(ideaEvents).values({ ideaId: idea.id, actorType: "business_owner", actorId: owner.id, eventType: "business_owner_approved", fromStatus: "business_review", toStatus: "control_review", metadataJson: JSON.stringify({ requiredControls: ["Risk", "Compliance"], requiresControlApproval: true }) }).run();

  await decideGovernance({ userId: owner.id, sessionId: db.insert(refreshTokens).values({ userId: owner.id, tokenHash: `single-control-session-${stamp}`, expiresAt: new Date(Date.now() + 60_000) }).returning({ id: refreshTokens.id }).get().id }, idea.id, "approve", "Risk control approved", undefined, "Risk");
  await assert.rejects(decideGovernance({ userId: owner.id, sessionId: db.select({ id: refreshTokens.id }).from(refreshTokens).where(eq(refreshTokens.userId, owner.id)).get()!.id }, idea.id, "approve", "Duplicate Risk control", undefined, "Risk"), /already approved/);
  await decideGovernance({ userId: owner.id, sessionId: db.select({ id: refreshTokens.id }).from(refreshTokens).where(eq(refreshTokens.userId, owner.id)).get()!.id }, idea.id, "approve", "Compliance control approved", undefined, "Compliance");
  assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
  assert.equal(db.select().from(ideaEvents).all().filter((event) => event.ideaId === idea.id && event.eventType === "control_approved").length, 2);
});

test("screening due date starts when a saved draft is submitted", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const author = db.insert(users).values({ name: "Draft author", email: `draft-due-${stamp}@example.test`, passwordHash: "test" }).returning({ id: users.id }).get();
  const reviewer = db.insert(users).values({ name: "Draft reviewer", email: `draft-reviewer-${stamp}@example.test`, role: "maintainer", passwordHash: "test" }).returning({ id: users.id }).get();
  const reviewerSession = db.insert(refreshTokens).values({ userId: reviewer.id, tokenHash: `draft-reviewer-session-${stamp}`, expiresAt: new Date(Date.now() + 60_000) }).returning({ id: refreshTokens.id }).get();
  const idea = db.insert(ideas).values({ authorId: author.id, title: "Old draft", summary: "Submitted today", category: "Technology", reference: `ABI-DUE-${stamp}`, status: "screening", createdAt: new Date(Date.now() - 20 * 86_400_000) }).returning({ id: ideas.id }).get();
  db.insert(ideaSubmissions).values({ ideaId: idea.id, answersJson: "{}", metricsJson: "{}", score: 2, minimumScore: 2, submittedAt: new Date() }).run();
  const queued = (await listScreeningQueue({ userId: reviewer.id, sessionId: reviewerSession.id }, 100)).items.find((item) => item.id === idea.id);
  assert.ok(queued?.dueAt && queued.dueAt.getTime() > Date.now() + 2 * 86_400_000);
});

test("a policy change after owner approval does not add a new control gate", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const make = (profile: string) => {
    const user = db.insert(users).values({ name: profile, email: `${profile}-policy-${stamp}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "admin", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-policy-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee"), reviewer = make("reviewer"), owner = make("business_owner");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Policy snapshot", summary: "Control requirement at owner decision", category: "Technology", reference: `ABI-POLICY-${stamp}` }).returning({ id: ideas.id }).get();
  await decideGovernance(reviewer, idea.id, "accept", "Accept for owner match");
  await assignBusinessOwner(reviewer, idea.id, owner.userId);
  db.run(sql`SAVEPOINT governance_policy_test`);
  try {
    db.insert(ideaSettings).values({ key: "required_controls", value: "[]" }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: "[]" } }).run();
    await decideGovernance(owner, idea.id, "approve", "Owner approves without required controls");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
    db.update(ideaSettings).set({ value: '["Risk"]' }).where(eq(ideaSettings.key, "required_controls")).run();
    await decideGovernance(owner, idea.id, "confirm", "Confirm under the approval policy");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "poc");
  } finally {
    db.run(sql`ROLLBACK TO governance_policy_test`);
    db.run(sql`RELEASE governance_policy_test`);
  }
});

test("manual owner assignment applies the configured review SLA and owner confirmation reaches transformation", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  let sequence = 0;
  const make = (profile: string) => {
    const suffix = `${stamp}-${++sequence}`;
    const user = db.insert(users).values({ name: profile, email: `${profile}-enforcement-${suffix}@example.test`, role: profile === "business_owner" ? "business_owner" : profile === "employee" ? "employee" : "admin", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-enforcement-${suffix}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee"), reviewer = make("reviewer"), owner = make("business_owner");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Named controls", summary: "Test", category: "Technology", reference: `ABI-CONTROL-${stamp}` }).returning({ id: ideas.id }).get();
  db.run(sql`SAVEPOINT governance_named_controls_test`);
  try {
    db.insert(ideaSettings).values({ key: "sla_days", value: '{"business_review":3,"control_review":4,"decision":5}' }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: '{"business_review":3,"control_review":4,"decision":5}' } }).run();
    db.insert(ideaSettings).values({ key: "required_controls", value: '["Risk","Compliance"]' }).onConflictDoUpdate({ target: ideaSettings.key, set: { value: '["Risk","Compliance"]' } }).run();
    await decideGovernance(reviewer, idea.id, "accept", "Accept for owner match");
    await assignBusinessOwner(reviewer, idea.id, owner.userId);
    const routedDue = db.select({ dueAt: ideas.dueAt }).from(ideas).where(eq(ideas.id, idea.id)).get()?.dueAt;
    assert.ok(routedDue && routedDue.getTime() > Date.now() + 2 * 86_400_000 && routedDue.getTime() <= Date.now() + 3 * 86_400_000);
    await decideGovernance(owner, idea.id, "approve", "Business case accepted");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "decision");
    assert.ok((await listTransformationQueue(reviewer)).items.some((item) => item.id === idea.id));
    await decideGovernance(owner, idea.id, "confirm", "Accept for transformation");
    assert.equal(db.select({ status: ideas.status }).from(ideas).where(eq(ideas.id, idea.id)).get()?.status, "poc");
  } finally {
    db.run(sql`ROLLBACK TO governance_named_controls_test`);
    db.run(sql`RELEASE governance_named_controls_test`);
  }
});

test("business owner approval and transformation confirmation require distinct workspace roles", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const make = (profile: string) => {
    const user = db.insert(users).values({ name: profile, email: `${profile}-roles-${stamp}@example.test`, role: profile === "employee" ? "employee" : profile === "business_owner" ? "business_owner" : "admin", passwordHash: "test" }).returning({ id: users.id }).get();
    const session = db.insert(refreshTokens).values({ userId: user.id, tokenHash: `${profile}-roles-${stamp}`, expiresAt: new Date(Date.now() + 60_000), sessionVersion: 0 }).returning({ id: refreshTokens.id }).get();
    return { userId: user.id, sessionId: session.id };
  };
  const employee = make("employee");
  const reviewer = make("reviewer");
  const owner = make("business_owner");
  const idea = db.insert(ideas).values({ authorId: employee.userId, title: "Role boundary", summary: "Distinct owner and transformation authority.", category: "Technology", reference: `ABI-ROLE-${stamp}` }).returning({ id: ideas.id }).get();
  await decideGovernance(reviewer, idea.id, "accept", "Accept for owner match");
  await assignBusinessOwner(reviewer, idea.id, owner.userId);
  db.update(ideas).set({ status: "business_review", assignedUserId: employee.userId }).where(eq(ideas.id, idea.id)).run();
  db.insert(ideaEvents).values({ ideaId: idea.id, actorType: "admin", actorId: reviewer.userId, eventType: "business_owner_routed", toStatus: "business_review", metadataJson: JSON.stringify({ businessOwnerId: employee.userId }) }).run();
  await assert.rejects(decideGovernance(employee, idea.id, "approve", "Employee cannot approve"));
});
