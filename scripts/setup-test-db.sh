#!/usr/bin/env bash
# Provision the ISOLATED e2e database (schema only — global-setup seeds the
# required data each run). Reads TEST_DATABASE_URL from env or apps/web/.env.local.
#
#   - Local docker DB: creates the database if it doesn't exist, then migrates.
#   - Neon test branch: create the branch in the Neon dashboard first; this just
#     applies migrations to it.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "${TEST_DATABASE_URL:-}" ]; then
  TEST_DATABASE_URL=$(grep -E '^TEST_DATABASE_URL=' "$ROOT/apps/web/.env.local" 2>/dev/null \
    | head -1 | sed -E 's/^TEST_DATABASE_URL=//; s/^"//; s/"$//')
fi
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  echo "TEST_DATABASE_URL not set (env or apps/web/.env.local)." >&2
  exit 1
fi

DBNAME=$(echo "$TEST_DATABASE_URL" | sed -E 's#.*/([^/?]+)(\?.*)?$#\1#')

# Local docker only: create the database if missing (Neon branches are made in
# the dashboard, not here).
if echo "$TEST_DATABASE_URL" | grep -q 'localhost:5433'; then
  docker compose exec -T postgres psql -U postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='$DBNAME'" | grep -q 1 \
    || docker compose exec -T postgres psql -U postgres -c "CREATE DATABASE \"$DBNAME\""
fi

DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" \
  pnpm --filter @repo/db exec prisma migrate deploy

echo "Test DB ready: $DBNAME"
