# AB Ignite Backend

Fastify owns authentication decisions, SQLite persistence, migrations, domain APIs and AI processing. The API and AI worker run as separate processes from this backend image; the worker uses the same backend-owned database volume.

## Local development

1. Copy `.env.example` to `.env` and set independent random values for `AUTH_SECRET`, `INTERNAL_API_TOKEN` and `AUTH_AUDIT_HASH_SECRET`.
2. Configure the frontend with the same `AUTH_SECRET` and `INTERNAL_API_TOKEN` values.
3. Run `npm ci`, `npm run db:migrate`, `npm run db:seed`, then `npm run api:dev`.
4. Run `npm run ai:worker` separately when Gemini credentials are configured.

Only this repository should mount or read the SQLite database.
