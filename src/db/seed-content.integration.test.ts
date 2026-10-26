import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("fresh learning seed creates two complete banking quizzes and two useful published articles idempotently", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "ab-ignite-seed-content-")), "seed.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db } = await import("./connection.js");
  const { articles, quizOptions, quizQuestions, quizVersions, quizzes } = await import("./schema.js");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const { ensureQuizCatalogue } = await import("../lib/quizzes/seed.js");
  const { ensureArticleCatalogue } = await import("../lib/articles/seed.js");
  ensureQuizCatalogue();
  ensureArticleCatalogue();
  ensureQuizCatalogue();
  ensureArticleCatalogue();

  const seededQuizzes = db.select().from(quizzes).all();
  assert.equal(seededQuizzes.length, 2);
  assert.ok(seededQuizzes.some((quiz) => /corporate payment/i.test(quiz.title)));
  assert.ok(seededQuizzes.some((quiz) => /phishing|data protection/i.test(quiz.title)));

  const publishedVersions = db.select().from(quizVersions).all().filter((version) => version.published);
  assert.equal(publishedVersions.length, 2);
  for (const version of publishedVersions) {
    const questions = db.select().from(quizQuestions).all().filter((question) => question.quizVersionId === version.id);
    assert.equal(questions.length, 5);
    for (const question of questions) {
      const options = db.select().from(quizOptions).all().filter((option) => option.questionId === question.id);
      assert.equal(options.length, 4);
      assert.equal(options.filter((option) => option.isCorrect).length, 1);
      assert.ok(question.prompt.length > 50);
    }
  }

  const seededArticles = db.select().from(articles).all();
  assert.equal(seededArticles.length, 2);
  assert.ok(seededArticles.every((article) => article.published && article.contentType === "internal" && article.body.length > 700));
  assert.ok(seededArticles.some((article) => /ArabiConnect|corporate payment/i.test(`${article.title} ${article.body}`)));
  assert.ok(seededArticles.some((article) => /phishing|customer data/i.test(`${article.title} ${article.body}`)));
});
