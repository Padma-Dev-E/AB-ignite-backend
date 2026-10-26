# Database Wipe and Arab Bank Seed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded SQLite `db:wipe` command and seed a fresh database with the admin, AI prompts, exactly two Arab Bank-relevant quizzes, and two articles.

**Architecture:** A standalone wipe core opens the configured SQLite file, clears app table rows in one transaction, retains Drizzle migrations, and checks FK integrity. The existing seed entrypoint and catalogue seed functions remain idempotent, with their generic learning content replaced by two complete quizzes and two articles.

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3, Drizzle ORM, node:test.

**Spec:** `docs/superpowers/specs/2026-10-26-db-wipe-and-arabbank-seed-design.md`

## Global Constraints

- Do not wipe the configured working database during implementation.
- Preserve schema and Drizzle migration history.
- Require `--confirm`; also require `--allow-production` under `NODE_ENV=production`.
- Do not encode unpublished Arab Bank policies or claim the sample content is approved policy.
- Fresh seed contains exactly two quizzes and two articles; preserve admin, prompt, category, points, and feedback seed behavior.

## Review Focus

- Missing confirmation or production acknowledgement must fail before opening/deleting data; verify CLI guard behavior.
- FK-connected tables must all be cleared without FK violations; verify against migrated temporary DB.
- Wiping must retain migration history and leave the database seedable; verify wipe then reseed.
- Repeated seed must not duplicate quiz/article records or questions; verify counts after two seed runs.
- A quiz must have five distinct, scenario-based questions with one correct option per question; assert catalogue structure.

---

### Task 1: Guarded transactional database wipe

**Files:**
- Create: `src/db/wipe-core.ts`
- Create: `src/db/wipe.ts`
- Modify: `package.json`
- Test: `src/db/wipe.integration.test.ts`

**Interfaces:**
- `wipeDatabase(databasePath: string): { clearedTables: number }`
- CLI requires `--confirm`, and requires `--allow-production` when `NODE_ENV=production`.

- [x] Write tests for clearing app tables behind aborting delete triggers, preserving `__drizzle_migrations`, resetting sequences, and rejecting invalid confirmation/production invocation.
- [x] Run tests and confirm the missing implementation/guard fails as expected.
- [x] Implement transaction, foreign-key integrity check, safe identifier quoting, database-path resolution, trigger restoration, and CLI guards.
- [x] Run wipe integration tests.

### Task 2: Arab Bank learning seed content

**Files:**
- Modify: `src/lib/quizzes/seed.ts`
- Modify: `src/lib/articles/seed.ts`
- Test: `src/db/seed-content.integration.test.ts`

**Interfaces:**
- Keep existing `ensureQuizCatalogue()` and `ensureArticleCatalogue()` callable by `src/db/seed.ts`.
- Fresh seed creates quizzes on transaction-banking payment verification and phishing/data protection, each with five questions, four choices, and exactly one correct choice per question.
- Fresh seed creates two complete, published internal learning articles with Arab Bank-relevant examples and safe procedural caveats.

- [x] Write failing catalogue tests for exact counts, titles/topics, question/choice integrity, and published article metadata.
- [x] Run tests to confirm the current generic catalogue fails the intended counts/content assertions.
- [x] Implement detailed scenario-based questions and two substantial articles; retain feedback and points rule setup.
- [x] Run content integration tests and confirm repeat calls do not duplicate records.

### Task 3: End-to-end database lifecycle verification

**Files:**
- Modify: `README.md` or `src/db/README.md`

- [x] Document migrate → guarded wipe → seed commands, including production acknowledgement.
- [x] Against a temporary database, run migrate, seed twice, assert admin/catalogue, run wipe, assert app data empty and migration ledger intact, then seed and assert recreated catalogue.
- [x] Run `npm run api:build`.
- [x] Review the final diff and ensure the configured/local database was not modified.
