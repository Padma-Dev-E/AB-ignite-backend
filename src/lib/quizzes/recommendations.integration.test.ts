import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("a passing quiz retake clears the stale open recommendation and refreshes journey evidence", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "quiz-recommendations-")), "quiz.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { eq } = await import("drizzle-orm");
  const { db } = await import("../../db/connection");
  const { quizRecommendations, users, quizzes, quizVersions, quizQuestions, quizOptions } = await import("../../db/schema");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const [user] = db.insert(users).values({ name: "Quiz journey test", email: "quiz-journey@example.test", passwordHash: "test-only" }).returning().all();
  const [quiz] = db.insert(quizzes).values({ title: "Recommendation lifecycle", category: "Technology", difficulty: "beginner", objective: "Test recommendations", passMark: 70, pointsPerQuestion: 0, questionCount: 2 }).returning().all();
  const [version] = db.insert(quizVersions).values({ quizId: quiz.id, version: 1, categoryCode: "technology", level: "beginner", objective: quiz.objective, passMark: 70, pointsPerQuestion: 0, published: true }).returning().all();
  const questions = ["Security", "Security"].map((topic, index) => db.insert(quizQuestions).values({ quizVersionId: version.id, topic, prompt: `Question ${index + 1}`, sortOrder: index + 1 }).returning().get());
  for (const question of questions) {
    db.insert(quizOptions).values([
      { questionId: question.id, optionKey: "correct", label: "Correct answer", sortOrder: 1, isCorrect: true },
      { questionId: question.id, optionKey: "incorrect", label: "Incorrect answer", sortOrder: 2, isCorrect: false },
    ]).run();
  }

  const { startQuizAttempt, submitQuizAttempt, getJourney } = await import("./service.js");
  const first = await startQuizAttempt(user.id, quiz.id, "journey-first-attempt", new Date("2026-10-25T10:00:00Z"));
  await submitQuizAttempt(user.id, first.attempt.id, questions.map((question) => ({ questionId: question.id, optionKey: "incorrect" })), new Date("2026-10-25T10:01:00Z"));
  let journey = await getJourney(user.id);
  assert.equal(journey.recommendations.length, 1);
  assert.match(journey.recommendations[0].reason, /0%/);
  assert.equal(journey.topics.find((topic) => topic.topic === "Security")?.scorePercent, 0);

  const retake = await startQuizAttempt(user.id, quiz.id, "journey-retake-attempt", new Date("2026-10-25T10:02:00Z"));
  await submitQuizAttempt(user.id, retake.attempt.id, questions.map((question) => ({ questionId: question.id, optionKey: "correct" })), new Date("2026-10-25T10:03:00Z"));
  journey = await getJourney(user.id);

  assert.equal(journey.topics.find((topic) => topic.topic === "Security")?.scorePercent, 100);
  assert.equal(journey.recommendations.length, 0, "resolved learning gaps must no longer be presented as open recommendations");
  assert.match(journey.summary, /at or above the recommended learning thresholds/i);
  assert.doesNotMatch(journey.summary, /areas to build on/i);
  assert.equal(db.select().from(quizRecommendations).where(eq(quizRecommendations.userId, user.id)).all().filter((recommendation) => recommendation.status === "open").length, 0);

  const lowerRetake = await startQuizAttempt(user.id, quiz.id, "journey-lower-retake", new Date("2026-10-25T10:04:00Z"));
  await submitQuizAttempt(user.id, lowerRetake.attempt.id, questions.map((question) => ({ questionId: question.id, optionKey: "incorrect" })), new Date("2026-10-25T10:05:00Z"));
  journey = await getJourney(user.id);
  assert.equal(journey.recommendations.length, 1, "a later result below threshold must create a current recommendation again");
  assert.equal(journey.recommendations[0].scorePercent, 0);
  assert.match(journey.recommendations[0].reason, /0%/);
  assert.match(journey.summary, /Security as an area to build on/i);
});
