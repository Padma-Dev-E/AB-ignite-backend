# Database setup

The project uses SQLite through Drizzle ORM and `better-sqlite3`.

1. Copy `.env.example` to `.env.local` if you want to override the default database path.
2. Generate migrations after changing `src/db/schema.ts`:

   ```bash
   npm run db:generate
   ```

3. Apply migrations when you are ready to create/update the local database:

   ```bash
   npm run db:migrate
   ```

4. To deliberately reset an existing database before seeding, stop the API and run:

   ```bash
   npm run db:wipe -- --confirm
   npm run db:seed
   ```

   `db:wipe` refuses to run without `--confirm`. If `NODE_ENV=production`, also pass `--allow-production`. It uses the configured `DATABASE_URL`, requires an existing database with the Drizzle migration ledger, resets generated ID sequences, and restores append-only database triggers before it exits. It does not remove or recreate the database file. Check `DATABASE_URL` before running it; wiping is irreversible.

   When the live database is in the backend Compose volume, run these from `backend/` so the wipe targets that volume rather than a host-side SQLite file:

   ```bash
   docker compose stop api
   docker compose run --rm --no-deps --entrypoint npm api run db:wipe -- --confirm --allow-production
   docker compose run --rm --no-deps --entrypoint npm api run db:seed
   docker compose start api
   ```

5. Seed the default administrator and demo learning catalogue. On a reset database, run this immediately after `db:wipe`; for a newly migrated empty database, run it directly:

   ```bash
   npm run db:seed
   ```

6. Inspect the database with Drizzle Studio:

   ```bash
   npm run db:studio
   ```

The typed database client is exported from `src/db/index.ts`; the auth foundation uses it for users and refresh sessions. `db:seed` creates `admin@admin.com` with an Argon2id password hash and idempotently seeds the four active idea AI prompts at version 1, two published five-question banking quizzes, two published employee-learning articles, a feedback campaign, and the article points rule. The sample learning material uses public Arab Bank context and is illustrative; it does not replace approved bank policy. Seeding is idempotent for an existing admin and learning catalogue. Change the development password and `AUTH_SECRET` before using a deployed environment.
