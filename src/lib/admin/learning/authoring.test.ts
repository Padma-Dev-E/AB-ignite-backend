import test from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db/connection";
import {
  articles,
  auditEvents,
  pointRules,
  quizCategories,
  quizChallengeParticipants,
  quizChallenges,
  quizOptions,
  quizQuestions,
  quizVersions,
  quizzes,
  refreshTokens,
  users,
} from "../../../db/schema";
import {
  createQuiz,
  createQuizVersion,
  addQuestion,
  publishQuizVersion,
  createChallenge,
  updateChallenge,
} from "./authoring";
import {
  createAdminArticle,
  updateAdminArticle,
  updateAdminQuestion,
} from "./service";

test("admin authoring creates immutable published quiz versions and replays the same request", () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const admin = db
    .insert(users)
    .values({
      name: "Author",
      email: `author-${stamp}@example.test`,
      role: "back_office",
      passwordHash: "test",
    })
    .returning()
    .get();
  const session = db
    .insert(refreshTokens)
    .values({
      userId: admin.id,
      tokenHash: `author-${stamp}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
    .get();
  db.insert(quizCategories)
    .values({ code: `topic-${stamp}`, name: "Test topic", active: true })
    .run();
  const actor = {
    userId: admin.id,
    sessionId: session.id,
    reason: "Approved learning programme",
  };
  const key = `quiz-${stamp}`;
  const input = {
    title: "Bank controls",
    categoryCode: `topic-${stamp}`,
    level: "beginner",
    objective: "Learn safe controls",
    passMark: 70,
    pointsPerQuestion: 10,
    timeLimitSeconds: 300,
    questionCount: 1,
  };
  const first = createQuiz(actor, input, key);
  assert.deepEqual(createQuiz(actor, input, key), first);
  assert.throws(() => createQuiz(actor, { ...input, title: "Other" }, key));
  const questionInput = {
    prompt: "Safe action?",
    topic: "control",
    sortOrder: 1,
    points: 10,
    options: [
      { optionKey: "a", label: "Document it", sortOrder: 1, isCorrect: true },
      { optionKey: "b", label: "Skip it", sortOrder: 2, isCorrect: false },
    ],
  };
  const question = addQuestion(
    actor,
    first.versionId,
    questionInput,
    `question-${stamp}`,
  );
  assert.equal(
    addQuestion(actor, first.versionId, questionInput, `question-${stamp}`).id,
    question.id,
  );
  assert.equal(
    db
      .select()
      .from(quizOptions)
      .where(eq(quizOptions.questionId, question.id))
      .all().length,
    2,
  );
  assert.equal(
    publishQuizVersion(actor, first.versionId, `publish-${stamp}`).published,
    true,
  );
  assert.equal(
    publishQuizVersion(actor, first.versionId, `publish-${stamp}`).id,
    first.versionId,
  );
  assert.throws(() =>
    addQuestion(
      actor,
      first.versionId,
      {
        prompt: "Another?",
        topic: "control",
        sortOrder: 2,
        points: 10,
        options: [
          { optionKey: "a", label: "A", sortOrder: 1, isCorrect: true },
          { optionKey: "b", label: "B", sortOrder: 2, isCorrect: false },
        ],
      },
      `late-${stamp}`,
    ),
  );
  const version = createQuizVersion(actor, first.id, `version-${stamp}`);
  assert.equal(version.version, 2);
  assert.equal(
    db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizVersionId, version.id))
      .all().length,
    1,
  );
  const audit = db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.action, "admin.learning.quiz_version_published"),
        eq(auditEvents.actorUserId, admin.id),
      ),
    )
    .all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, actor.reason);
  const user = db
    .insert(users)
    .values({
      name: "Reader",
      email: `reader-${stamp}@example.test`,
      passwordHash: "test",
    })
    .returning()
    .get();
  const userSession = db
    .insert(refreshTokens)
    .values({
      userId: user.id,
      tokenHash: `reader-${stamp}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
    .get();
  assert.throws(() =>
    createQuiz(
      { userId: user.id, sessionId: userSession.id, reason: "Trying" },
      input,
      `unauthorized-${stamp}`,
    ),
  );
});

test("publishing rejects incomplete questions and challenge closure preserves participants", () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const admin = db
    .insert(users)
    .values({
      name: "Author",
      email: `author2-${stamp}@example.test`,
      role: "back_office",
      passwordHash: "test",
    })
    .returning()
    .get();
  const session = db
    .insert(refreshTokens)
    .values({
      userId: admin.id,
      tokenHash: `author2-${stamp}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
    .get();
  db.insert(quizCategories)
    .values({ code: `topic2-${stamp}`, name: "Test topic", active: true })
    .run();
  const actor = {
    userId: admin.id,
    sessionId: session.id,
    reason: "Quarterly content review",
  };
  db.insert(pointRules)
    .values({
      code: "challenge_join",
      name: "Join challenge",
      points: 20,
      active: true,
    })
    .onConflictDoUpdate({
      target: pointRules.code,
      set: { points: 20, active: true },
    })
    .run();
  const quiz = createQuiz(
    actor,
    {
      title: "Controls",
      categoryCode: `topic2-${stamp}`,
      level: "beginner",
      objective: "Learn",
      passMark: 70,
      pointsPerQuestion: 10,
      timeLimitSeconds: 300,
      questionCount: 1,
    },
    `quiz2-${stamp}`,
  );
  assert.throws(() =>
    publishQuizVersion(actor, quiz.versionId, `publish2-${stamp}`),
  );
  assert.equal(
    db
      .select()
      .from(quizVersions)
      .where(eq(quizVersions.id, quiz.versionId))
      .get()?.published,
    false,
  );
  assert.throws(() =>
    addQuestion(
      actor,
      quiz.versionId,
      {
        prompt: "Invalid",
        topic: "control",
        sortOrder: 1,
        points: 10,
        options: [
          { optionKey: "a", label: "A", sortOrder: 1, isCorrect: true },
          { optionKey: "b", label: "B", sortOrder: 2, isCorrect: true },
        ],
      },
      `invalid-${stamp}`,
    ),
  );
  assert.equal(
    db
      .select()
      .from(quizQuestions)
      .where(eq(quizQuestions.quizVersionId, quiz.versionId))
      .all().length,
    0,
  );
  const challengeInput = {
    title: "Monthly challenge",
    question: "Improve a control",
    deadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
    active: true,
  };
  const challenge = createChallenge(
    actor,
    challengeInput,
    `challenge-${stamp}`,
  );
  assert.equal(
    createChallenge(actor, challengeInput, `challenge-${stamp}`).id,
    challenge.id,
  );
  const participant = db
    .insert(users)
    .values({
      name: "Participant",
      email: `participant-${stamp}@example.test`,
      passwordHash: "test",
    })
    .returning()
    .get();
  db.insert(quizChallengeParticipants)
    .values({
      challengeId: challenge.id,
      userId: participant.id,
      idempotencyKey: `participant-${stamp}`,
      joinedAt: new Date(),
    })
    .run();
  assert.throws(() =>
    updateChallenge(
      actor,
      challenge.id,
      { question: "Changed question" },
      `change-${stamp}`,
    ),
  );
  const closed = updateChallenge(
    actor,
    challenge.id,
    { active: false },
    `close-${stamp}`,
  );
  assert.equal(closed.active, false);
  assert.equal(
    db
      .select()
      .from(quizChallenges)
      .where(eq(quizChallenges.id, challenge.id))
      .get()?.active,
    false,
  );
  assert.equal(
    db
      .select()
      .from(quizChallengeParticipants)
      .where(eq(quizChallengeParticipants.challengeId, challenge.id))
      .all().length,
    1,
  );
  assert.throws(() =>
    updateChallenge(actor, challenge.id, { active: true }, `reopen-${stamp}`),
  );
});

test("question PATCH replays safely and rejects duplicate option keys or order", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const admin = db
    .insert(users)
    .values({
      name: "Question author",
      email: `question-author-${stamp}@example.test`,
      role: "back_office",
      passwordHash: "test",
    })
    .returning()
    .get();
  const session = db
    .insert(refreshTokens)
    .values({
      userId: admin.id,
      tokenHash: `question-author-${stamp}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
    .get();
  db.insert(quizCategories)
    .values({
      code: `question-topic-${stamp}`,
      name: "Question topic",
      active: true,
    })
    .run();
  const actor = {
    userId: admin.id,
    sessionId: session.id,
    reason: "Question quality review",
  };
  const quiz = createQuiz(
    actor,
    {
      title: "Question validation",
      categoryCode: `question-topic-${stamp}`,
      level: "beginner",
      objective: "Validate answers",
      passMark: 70,
      pointsPerQuestion: 10,
      timeLimitSeconds: 300,
      questionCount: 1,
    },
    `question-quiz-${stamp}`,
  );
  const question = addQuestion(
    actor,
    quiz.versionId,
    {
      prompt: "Original?",
      topic: "controls",
      sortOrder: 1,
      points: 10,
      options: [
        { optionKey: "a", label: "Yes", sortOrder: 1, isCorrect: true },
        { optionKey: "b", label: "No", sortOrder: 2, isCorrect: false },
      ],
    },
    `question-create-${stamp}`,
  );
  const nextQuestion = addQuestion(
    actor,
    quiz.versionId,
    {
      prompt: "Which separate verification step should follow?",
      topic: "controls",
      sortOrder: 2,
      points: 10,
      options: [
        { optionKey: "a", label: "Independent review", sortOrder: 1, isCorrect: true },
        { optionKey: "b", label: "Skip the review", sortOrder: 2, isCorrect: false },
      ],
    },
    `question-create-next-${stamp}`,
  );
  assert.ok(nextQuestion.id > question.id);
  assert.equal(
    db.select().from(quizzes).where(eq(quizzes.id, quiz.id)).get()?.questionCount,
    2,
  );
  const input = {
    prompt: "Updated?",
    topic: "controls",
    sortOrder: 1,
    points: 15,
    options: [
      { optionKey: "a", label: "Correct", sortOrder: 1, isCorrect: true },
      { optionKey: "b", label: "Incorrect", sortOrder: 2, isCorrect: false },
    ],
  };
  const key = `question-update-${stamp}`;
  const first = await updateAdminQuestion(actor, question.id, input, key);
  assert.deepEqual(
    await updateAdminQuestion(actor, question.id, input, key),
    first,
  );
  assert.equal(
    db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.action, "admin.learning.question_updated"),
          eq(auditEvents.actorUserId, admin.id),
        ),
      )
      .all().length,
    1,
  );
  await assert.rejects(
    () =>
      updateAdminQuestion(
        actor,
        question.id,
        { ...input, prompt: "Different" },
        key,
      ),
    /idempotency/i,
  );
  await assert.rejects(
    () =>
      updateAdminQuestion(
        actor,
        question.id,
        {
          ...input,
          options: [
            { optionKey: "a", label: "One", sortOrder: 1, isCorrect: true },
            { optionKey: "b", label: "Two", sortOrder: 1, isCorrect: false },
          ],
        },
        `question-order-${stamp}`,
      ),
    /unique|order/i,
  );
  await assert.rejects(
    () =>
      updateAdminQuestion(
        actor,
        question.id,
        {
          ...input,
          options: [
            { optionKey: "a", label: "One", sortOrder: 1, isCorrect: true },
            { optionKey: "a", label: "Two", sortOrder: 2, isCorrect: false },
          ],
        },
        `question-key-${stamp}`,
      ),
    /unique|key/i,
  );
  await assert.rejects(
    () =>
      updateAdminQuestion(
        actor,
        question.id,
        {
          ...input,
          options: [
            { optionKey: "a", label: "One", sortOrder: 1, isCorrect: true },
            { optionKey: "b", label: "Two", sortOrder: 2, isCorrect: true },
          ],
        },
        `question-correct-${stamp}`,
      ),
    /exactly one/i,
  );
});

test("article create and PATCH require replay-safe idempotency and publish rejects duplicate option order", async () => {
  const stamp = `${Date.now()}-${Math.random()}`;
  const admin = db
    .insert(users)
    .values({
      name: "Article author",
      email: `article-author-${stamp}@example.test`,
      role: "back_office",
      passwordHash: "test",
    })
    .returning()
    .get();
  const session = db
    .insert(refreshTokens)
    .values({
      userId: admin.id,
      tokenHash: `article-author-${stamp}`,
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning()
    .get();
  const actor = {
    userId: admin.id,
    sessionId: session.id,
    reason: "Learning content review",
  };
  const input = {
    title: "Secure controls",
    summary: "A short summary",
    body: "Internal guidance",
    category: "controls",
    topic: "access",
    publisher: "AB Ignite",
    difficulty: "beginner",
    readingMinutes: 5,
    publishedLabel: null,
    url: null,
    published: false,
    contentType: "internal" as const,
    categoryCode: `article-topic-${stamp}`,
  };
  const createKey = `article-create-${stamp}`;
  const first = await createAdminArticle(actor, input, createKey);
  assert.deepEqual(await createAdminArticle(actor, input, createKey), first);
  await assert.rejects(
    () =>
      createAdminArticle(actor, { ...input, title: "Different" }, createKey),
    /idempotency/i,
  );
  const updateKey = `article-update-${stamp}`;
  const updated = await updateAdminArticle(
    actor,
    first.id,
    { ...input, title: "Updated controls" },
    updateKey,
  );
  assert.deepEqual(
    await updateAdminArticle(
      actor,
      first.id,
      { ...input, title: "Updated controls" },
      updateKey,
    ),
    updated,
  );
  await assert.rejects(
    () =>
      updateAdminArticle(
        actor,
        first.id,
        { ...input, title: "Another update" },
        updateKey,
      ),
    /idempotency/i,
  );
  assert.equal(
    db.select().from(articles).where(eq(articles.id, first.id)).get()?.title,
    "Updated controls",
  );

  db.insert(quizCategories)
    .values({ code: input.categoryCode, name: "Article topic", active: true })
    .run();
  const quiz = createQuiz(
    actor,
    {
      title: "Publish validation",
      categoryCode: input.categoryCode,
      level: "beginner",
      objective: "Validate publishing",
      passMark: 70,
      pointsPerQuestion: 10,
      timeLimitSeconds: 300,
      questionCount: 1,
    },
    `publish-quiz-${stamp}`,
  );
  const question = addQuestion(
    actor,
    quiz.versionId,
    {
      prompt: "Publish?",
      topic: "controls",
      sortOrder: 1,
      points: 10,
      options: [
        { optionKey: "a", label: "Yes", sortOrder: 1, isCorrect: true },
        { optionKey: "b", label: "No", sortOrder: 2, isCorrect: false },
      ],
    },
    `publish-question-${stamp}`,
  );
  db.update(quizOptions)
    .set({ sortOrder: 1 })
    .where(eq(quizOptions.questionId, question.id))
    .run();
  assert.throws(
    () => publishQuizVersion(actor, quiz.versionId, `publish-invalid-${stamp}`),
    /unique|order/i,
  );
});
