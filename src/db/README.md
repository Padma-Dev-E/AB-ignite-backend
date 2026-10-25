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

4. Seed the default administrator:

   ```bash
   npm run db:seed
   ```

5. Inspect the database with Drizzle Studio:

   ```bash
   npm run db:studio
   ```

The typed database client is exported from `src/db/index.ts`; the auth foundation uses it for users and refresh sessions. `db:seed` creates `admin@admin.com` with an Argon2id password hash and is idempotent for an existing admin record. Change the development password and `AUTH_SECRET` before using a deployed environment.
