#!/bin/sh
set -eu
umask 077
AUTH_SECRET=${AUTH_SECRET:-}

if [ "${#AUTH_SECRET}" -lt 32 ]; then
  echo "AUTH_SECRET must contain at least 32 characters." >&2
  exit 1
fi

case "${1:-}" in
  backend)
    node docker/import-dev-db.mjs
    npm run db:migrate
    if [ ! -f /app/data/.ab-ignite-seeded ]; then
      if [ -z "${DEFAULT_ADMIN_PASSWORD:-}" ]; then
        echo "DEFAULT_ADMIN_PASSWORD must be set before initial backend setup." >&2
        exit 1
      fi
      npm run db:seed
      touch /app/data/.ab-ignite-seeded
    fi
    exec npm run api:start
    ;;
  web)
    exec ./node_modules/.bin/next start --hostname 0.0.0.0 --port 3000
    ;;
  *)
    echo "Usage: entrypoint.sh {backend|web}" >&2
    exit 2
    ;;
esac
