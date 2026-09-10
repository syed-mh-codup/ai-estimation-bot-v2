#!/usr/bin/env bash
# Generate and apply a migration against LOCAL postgres, never Neon.
#
# `prisma migrate dev` cannot be used in this repo: packages/db/.env OVERRIDES
# the shell environment, so an explicitly-passed DATABASE_URL is silently
# ignored and Prisma connects to the production Neon database. Verified by
# passing a deliberately bogus URL and watching it connect to Neon anyway.
#
# So: generate the SQL offline with `migrate diff` against a throwaway shadow,
# and swap .env for the duration of the apply behind a trap.
#
# Usage: scripts/local-migrate.sh <migration_name>
set -euo pipefail
NAME="${1:?usage: local-migrate.sh <migration_name>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL="postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public"
SHADOW="postgresql://postgres:postgres@localhost:5433/aeh_migrate_shadow?schema=public"
cd "$ROOT/packages/db"

RAW="$(mktemp)"
trap 'rm -f "$RAW"' EXIT

psql "postgresql://postgres:postgres@localhost:5433/postgres" \
  -c "DROP DATABASE IF EXISTS aeh_migrate_shadow;" -c "CREATE DATABASE aeh_migrate_shadow;" >/dev/null

# Generated to a TEMP file, not into the migrations tree. `--from-migrations`
# reads that whole directory, so creating the destination folder first put an
# empty migration into the very input being replayed.
npx prisma migrate diff \
  --from-migrations ./prisma/migrations \
  --to-schema-datamodel ./prisma/schema.prisma \
  --shadow-database-url "$SHADOW" --script 2>/dev/null > "$RAW"

psql "postgresql://postgres:postgres@localhost:5433/postgres" \
  -c "DROP DATABASE IF EXISTS aeh_migrate_shadow;" >/dev/null

# Strip, THEN decide whether anything is left — in that order, and the order is
# the whole point. A no-op diff is not empty: it still carries the
# CreateExtension preamble the datamodel declares, ~61 bytes of it. Checking for
# content before stripping therefore always passed, and wrote a 1-byte
# migration that `migrate deploy` then recorded as applied — a phantom every
# subsequent deploy insists on and which has to be deleted from
# `_prisma_migrations` by hand.
# `status=0; cmd || status=$?` rather than `if ! cmd`, because inside an `if !`
# the `$?` seen by the body is the negation's result, not the command's — so
# "nothing changed" (1) and "destructive" (2) were indistinguishable.
status=0
python3 - "$RAW" <<'PY' || status=$?
import re, sys
src = re.sub(r'-- CreateExtension\nCREATE EXTENSION[^\n]*\n+', '', open(sys.argv[1]).read()).strip()
if not src:
    sys.exit(1)
bad = []
for a in re.findall(r'^ALTER TABLE .*?;', src, re.M | re.S):
    if re.search(r'\bDROP\b', a):
        bad.append(a[:90])
    for name, defn in re.findall(r'ADD COLUMN\s+"(\w+)"\s+([^,;]+)', a):
        if 'NOT NULL' in defn and 'DEFAULT' not in defn:
            bad.append(f"{name}: NOT NULL without DEFAULT")
if re.search(r'\bDROP (TABLE|TYPE|INDEX)\b', src):
    bad.append("DROP of an object")
if bad:
    print("UNSAFE — not additive:", *bad, sep="\n  ", file=sys.stderr)
    sys.exit(2)
open(sys.argv[1], 'w').write(src + "\n")
print(f"safe: {len(re.findall(r'ADD COLUMN', src))} column(s), "
      f"{len(re.findall(r'CREATE TABLE', src))} table(s), "
      f"{len(re.findall(r'CREATE TYPE', src))} enum(s), "
      f"{len(re.findall(r'ALTER TYPE', src))} enum value(s)")
PY
if [ "$status" -eq 1 ]; then echo "no schema change — nothing generated"; exit 0; fi
if [ "$status" -ne 0 ]; then echo "refusing to write a destructive migration" >&2; exit 1; fi

DIR="prisma/migrations/$(date -u +%Y%m%d%H%M%S)_${NAME}"
mkdir -p "$DIR"
cp "$RAW" "$DIR/migration.sql"

cp .env .env.migrate.bak
trap 'mv -f .env.migrate.bak .env 2>/dev/null || true; rm -f "$RAW"' EXIT
printf 'DATABASE_URL="%s"\nDIRECT_URL="%s"\n' "$LOCAL" "$LOCAL" > .env
npx prisma migrate deploy 2>&1 | grep -E "have been applied|already in sync|Error" || true
npx prisma generate 2>&1 | grep -E "Generated|Error" || true
echo "applied: $DIR"
