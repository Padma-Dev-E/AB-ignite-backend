# Database Wipe and Arab Bank Learning Seed

## Intent

Provide a deliberate, repeatable way for a developer to clear one configured SQLite database and then reseed it for an Arab Bank employee-learning demo.

## Goals

- Add `npm run db:wipe` to clear every application table's data transactionally while preserving SQLite schema and Drizzle migration history.
- Require explicit confirmation and an additional flag before a production-mode wipe.
- Keep `db:seed` idempotent and create the default back-office admin, current AI prompt catalogue, exactly two realistic published quizzes, and exactly two realistic published articles on a fresh database.
- Keep quiz questions and choices specific, plausible, and useful for bank employees.

## Non-goals and constraints

- Do not wipe the current database while implementing or testing this change.
- Do not invent Arab Bank internal controls, confidential processes, or regulatory rules. Training copy should say to follow approved internal procedures.
- Do not drop tables or migration history; `db:wipe` clears data only.
- Preserve other seed data needed by the app, including quiz categories, feedback campaign, points rule, and AI prompts.

## Approaches

1. **Transactional row wipe (selected):** enumerate application tables, disable FK enforcement for the transaction, delete their rows and reset sequences, retain Drizzle migration history, validate foreign keys, then close the connection. This supports an immediate `db:seed` and preserves the known schema.
2. **Delete the SQLite file and recreate schema:** simpler deletion, but requires migration orchestration and risks removing the migration ledger or mishandling WAL files.

## Seed content

- Quiz 1: secure handling of corporate payment instructions and transaction-banking fraud indicators.
- Quiz 2: phishing recognition, customer-data protection, and safe escalation.
- Article 1: pause, verify, and escalate unusual corporate payment requests.
- Article 2: recognizing phishing and protecting customer and colleague information.

The content is illustrative employee training, not a representation of Arab Bank's unpublished procedures. Public references: Arab Bank [Corporate Solutions & Channels](https://www.arabbank.com/smartmenu/banking-solutions/corporate-institutional-banking/corporate-solutions) and [Security Statement](https://www.arabbank.com/footer-navigation/security-statement).

## Safety behavior

- `db:wipe` requires `--confirm`.
- When `NODE_ENV=production`, it additionally requires `--allow-production`.
- It reports the resolved database path and number of cleared tables, but never prints credentials or row values.

## Verification

Run the wipe and seed lifecycle against an isolated temporary SQLite database: migrate, seed, assert admin/quizzes/articles and quiz question counts, wipe, assert application tables are empty while migration history remains, seed again, and assert the same catalogue is recreated. Also run the backend API TypeScript build.
