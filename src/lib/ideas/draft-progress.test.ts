import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { IdeaDraftProgressSchema } from "./schemas.js";

const partialProgress = {
  step: 3,
  raw: "Initial employee description",
  answers: { "Who benefits?": "Customers" },
  impact: { turnaround: "", volume: "1.5", value: "" },
  metricExplanations: { turnaround: "", volume: "Based on monthly cases", value: "" },
  differentiation: "",
  continueWithoutQuestions: false,
  workingCopy: {
    kind: "idea",
    title: "A draft title",
    summary: "A saved draft summary for resume.",
    details: { problem: "", solution: "", benefits: "", risks: "" },
  },
};

test("draft progress accepts partial answers and impact values for durable resume", () => {
  const result = IdeaDraftProgressSchema.safeParse(partialProgress);
  assert.equal(result.success, true);
});

test("draft progress rejects invalid wizard steps and oversized answer state", () => {
  assert.equal(IdeaDraftProgressSchema.safeParse({ ...partialProgress, step: 6 }).success, false);
  assert.equal(IdeaDraftProgressSchema.safeParse({ ...partialProgress, answers: { ["q".repeat(501)]: "answer" } }).success, false);
});

test("draft progress survives reload through owner-scoped database reads and writes", async () => {
  process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "idea-draft-progress-")), "ideas.sqlite");
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  const { db } = await import("../../db/connection.js");
  const { ideas, users } = await import("../../db/schema.js");
  const { getIdeaDraftProgress, saveIdeaDraftProgress } = await import("./repository.js");
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const [owner] = db.insert(users).values({ name: "Draft Owner", email: "draft-owner@example.test", passwordHash: "test-only", role: "employee" }).returning().all();
  const [other] = db.insert(users).values({ name: "Other User", email: "other-user@example.test", passwordHash: "test-only", role: "employee" }).returning().all();
  const [idea] = db.insert(ideas).values({ authorId: owner.id, title: "Draft resume", summary: "An idea being saved for later resume.", category: "Operations", status: "draft", reference: "TEMP-DRAFT-RESUME" }).returning().all();

  assert.equal(await saveIdeaDraftProgress({ kind: "user", id: String(owner.id) }, idea.id, partialProgress), true);
  assert.deepEqual(await getIdeaDraftProgress({ kind: "user", id: String(owner.id) }, idea.id), partialProgress);
  assert.equal(await getIdeaDraftProgress({ kind: "user", id: String(other.id) }, idea.id), null);
  assert.equal(await saveIdeaDraftProgress({ kind: "user", id: String(other.id) }, idea.id, partialProgress), false);
});
