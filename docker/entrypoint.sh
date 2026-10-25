#!/bin/sh
set -eu
umask 077
AUTH_SECRET=${AUTH_SECRET:-}

if [ "${#AUTH_SECRET}" -lt 32 ]; then
  echo "AUTH_SECRET must contain at least 32 characters." >&2
  exit 1
fi

case "${1:-}" in
  setup)
    DEFAULT_ADMIN_PASSWORD=${DEFAULT_ADMIN_PASSWORD:-}
    if [ -z "$DEFAULT_ADMIN_PASSWORD" ]; then
      echo "DEFAULT_ADMIN_PASSWORD must be set before setup." >&2
      exit 1
    fi
    node docker/import-dev-db.mjs
    npm run db:migrate
    exec npm run db:seed
    ;;
  web)
    exec ./node_modules/.bin/next start --hostname 0.0.0.0 --port 3000
    ;;
  api)
    exec npm run api:start
    ;;
  ai-worker)
    if [ -z "${GEMINI_API_KEY:-}${GOOGLE_API_KEY:-}" ]; then
      echo "The AI worker requires GEMINI_API_KEY or GOOGLE_API_KEY." >&2
      exit 1
    fi
    exec ./node_modules/.bin/tsx scripts/run-ai-worker.ts
    ;;
  *)
    echo "Usage: entrypoint.sh {setup|web|api|ai-worker}" >&2
    exit 2
    ;;
esac
