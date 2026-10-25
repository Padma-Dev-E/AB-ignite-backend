# AB Ignite Backend

Fastify owns authentication decisions, SQLite persistence, migrations, domain APIs and AI processing. The API starts the AI job worker inside the same backend process. Only this repository mounts or reads the SQLite database.

The backend Docker image uses Node.js 24 by default. `NODE_IMAGE` can override the base image when building for another supported runtime.

## Local development and Docker

1. Copy `.env.example` to `.env` and set independent random values for `AUTH_SECRET`, `INTERNAL_API_TOKEN` and `AUTH_AUDIT_HASH_SECRET`.
2. Configure the frontend with the same `AUTH_SECRET` and `INTERNAL_API_TOKEN` values.
3. Run `npm ci`, `npm run db:migrate`, `npm run db:seed`, then `npm run api:dev`.
4. Configure Gemini credentials in the backend `.env` to enable AI jobs.

## Docker with separate repositories

The backend Compose file builds and runs only the Fastify API (including its in-process AI worker). It creates the private network `ab-ignite-local_api_private`, which the frontend Compose file joins as an external network. Both repositories keep independent Dockerfiles, Compose files, and `.env` files.

1. Copy this repository's `.env.example` to `.env` and configure backend secrets, Gemini, and `API_ALLOWED_ORIGINS`.
2. Start the backend from this repository with `docker compose up -d --build`.
3. Start the frontend from its repository with `docker compose up -d --build`.

Configure matching `AUTH_SECRET` and `INTERNAL_API_TOKEN` values in each repository's `.env`. The SQLite volume remains `ab-ignite-local_sqlite_data` across redeployments.
