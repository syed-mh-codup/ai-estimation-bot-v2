#!/usr/bin/env bash
# Generate and apply a migration against LOCAL postgres, never Neon.
#
# `prisma migrate dev` cannot be used in this repo: packages/db/.env OVERRIDES
# the shell environment, so an explicitly-passed DATABASE_URL is silently
# ignored and Prisma connects to the production Neon database. Verified by
# passing a deliberately bogus URL and watching it connect to Neon anyway.
#
# So: swap .env for the duration behind a trap, and generate the SQL offline
# with `migrate diff` against a throwaway shadow that is dropped afterwards.
#
# Usage: scripts/local-migrate.sh <migration_name>
set -euo pipefail
NAME="${1:?usage: local-migrate.sh <migration_name>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public"
SHADOW="postgresql://postgres:postgres@localhost:5433/aeh_migrate_shadow?schema=public"
cd "$ROOT/packages/db"

psql "postgresql://postgres:postgres@localhost:5433/postgres" \
  -c "DROP DATABASE IF EXISTS aeh_migrate_shadow;" -c "CREATE DATABASE aeh_migrate_shadow;" >/dev/null

DIR="prisma/migrations/$(date -u +%Y%m%d%H%M%S)_${NAME}"
mkdir -p "$DIR"
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW" --script 2>/dev/null > "$DIR/migration.sql"

psql "postgresql://postgres:postgres@localhost:5433/postgres" \
  -c "DROP DATABASE IF EXISTS aeh_migrate_shadow;" >/dev/null

if ! grep -q . "$DIR/migration.sql"; then rmdir "$DIR"; echo "no schema change"; exit 0; fi

python3 - "$DIR/migration.sql" <<'PY'
import re, sys
p = sys.argv[1]
src = re.sub(r'-- CreateExtension\nCREATE EXTENSION[^\n]*\n\n', '', open(p).read()).strip() + "\n"
open(p, 'w').write(src)
bad = []
for a in re.findall(r'^ALTER TABLE .*?;', src, re.M | re.S):
    if re.search(r'\bDROP\b', a): bad.append(a[:90])
    for name, defn in re.findall(r'ADD COLUMN\s+"(\w+)"\s+([^,;]+)', a):
        if 'NOT NULL' in defn and 'DEFAULT' not in defn: bad.append(f"{name}: NOT NULL without DEFAULT")
if re.search(r'\bDROP (TABLE|TYPE|INDEX)\b', src): bad.append("DROP of an object")
if bad:
    print("UNSAFE — not additive:"); [print("  ", b) for b in bad]; sys.exit(1)
print(f"safe: {len(re.findall(r'ADD COLUMN', src))} column(s), "
      f"{len(re.findall(r'CREATE TABLE', src))} table(s), {len(re.findall(r'CREATE TYPE', src))} enum(s)")
PY

cp .env .env.migrate.bak
trap 'mv -f .env.migrate.bak .env 2>/dev/null || true' EXIT
printf 'DATABASE_URL="%s"\nDIRECT_URL="%s"\n' "$LOCAL" "$LOCAL" > .env
npx prisma migrate deploy 2>&1 | grep -E "have been applied|already in sync|Error" || true
npx prisma generate 2>&1 | grep -E "Generated|Error" || true
echo "applied: $DIR"
