# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## ⚠️ URGENT — Neon dev/main was wiped on 2026-08-31, restore it

**`ep-polished-credit-atso15cy` (Neon dev/main, `neondb`) has zero rows in every
table.** The schema is intact and fully current; the data is gone.

**Cause — mine, in this session.** I ran, from `packages/db`:

    npx prisma migrate diff --from-migrations prisma/migrations \
      --to-schema-datamodel prisma/schema.prisma \
      --shadow-database-url "<packages/db/.env DATABASE_URL>_shadow"

The `_shadow` suffix was appended to a URL already ending in `?sslmode=require`,
producing `?sslmode=require_shadow` — the same host and the same database, with
a malformed parameter that was ignored. `migrate diff --from-migrations`
**resets its shadow database and replays every migration into it**, so dev/main
was dropped and rebuilt empty. It writes no ledger, which is why
`_prisma_migrations` is missing and `migrate deploy` now answers P3005.

**When:** between 10:10 and 10:20 UTC (15:10–15:20 PKT) on 2026-08-31.
**Nothing has been written to dev/main since** — the failed `migrate deploy`
aborted at P3005 before applying anything, and every command after it was a
SELECT. A restore to any point before 10:05 UTC loses nothing.

**Recovery — the user's action, in the Neon console:** Branch Restore (Time
Travel) on the dev/main branch, to **2026-08-31 10:05 UTC / 15:05 PKT or
earlier**. Neon snapshots the current state before restoring, so it is
reversible. The history window is finite and plan-dependent, so this is
time-sensitive.

**After the restore:**

1. The ledger will be back at 23 migrations. Apply AEH-240's with the normal
   path: `DATABASE_URL=<direct> DIRECT_URL=<direct> pnpm --filter @repo/db exec
   prisma migrate deploy`.
2. Verify: expect ~45 presets each with a non-null vector, prompts at v3/v4,
   plus users and estimates.
3. **Do not run `pnpm db:seed` against dev/main under any circumstances** — see
   the AEH-259 note further down. It would overwrite the hand-tuned prompts with
   their two-sentence v1 bodies, which is the one loss a restore is meant to
   undo.

**Never again:** do not derive a shadow-database URL by string-appending to a
real connection string. Point `--shadow-database-url` at a scratch database on
local docker (`localhost:5433/prisma_shadow`), or skip `migrate diff` entirely —
applying the migration to local docker first catches drift just as well.

**Unaffected:** local docker `ai_estimation` (21 estimates, 51 presets, 12 users,
152 prompt versions) and Neon test `ep-wild-heart` (24 estimates, 46 presets)
are both intact and both carry all 24 migrations. No code was lost.

**The restore is the only recovery — copying from another database will not
work.** I checked: neither surviving database holds anything resembling
dev/main's content. Their prompt bodies are 21–26 characters (test fixtures),
local docker's 152 PromptVersions are 143 throwaway LIBRARIAN rows from test
runs, every kind sits at v1, and between them they have one preset embedding.
The hand-tuned v3/v4 prompts, the 45 embedded presets and the real estimates
exist only in whatever Neon's history still holds.

## Current: AEH-240 — custodian, deadlines, reminders

Branch `feat/aeh-240-custodian-deadlines`, commit `e002b2b`. **Stacked on
`feat/aeh-244-preset-concern-split`, which is still unmerged** — branching from
master would have put the schema behind the three AEH-244 migrations every
database already carries.

Implementation is complete and verified: `pnpm -r build` green, `pnpm lint`
clean, 22 new unit tests passing, field/export audit clean via
`pnpm --filter @repo/audit run audit` (the root `pnpm run audit` script is
shadowed by pnpm's own `audit` and prints a vulnerability table instead).

Migrations applied: local docker dev ✅, local docker test ✅, Neon test ✅,
**Neon dev/main ❌ — blocked on the restore above.**

Not done: not merged, not pushed. Ticket left In Progress.

## Databases

    local docker  ai_estimation        24 migrations, data intact
    local docker  ai_estimation_test   24 migrations
    Neon test     (ep-wild-heart)      24 migrations, data intact
    Neon dev/main (ep-polished-credit) SCHEMA ONLY, NO LEDGER, NO DATA — restore

⚠️ Still true from AEH-259: seed Neon dev/main with targeted scripts only, never
`pnpm db:seed`. It carries hand-tuned prompts at v3 and v4 whose text exists
nowhere in the repo, and the bootstrap seed would revert all nine to their
two-sentence v1 bodies.

## Related tickets

**AEH-237** — multi-level approval, blocked by AEH-240. Now unblocked: an
estimate has a named person on it who is not merely its creator.

**AEH-282** — the e2e suite. Open, and the reason AEH-240 shipped with unit
tests rather than e2e specs. Worth an `admin-presets`-style spec later covering
"set a deadline, the reminder rows clear".

**AEH-244** — unmerged and unpushed; still the user's outstanding action, and
now also the parent of this branch.

## Traps worth keeping

- A schema split turns one atomic row insert into N writes. Wrap every
  multi-table write in a `$transaction` — `setDueAt` does, because a moved
  deadline that kept its old reminder rows would silence every nudge for the
  new date.
- `new Date('2026-02-31')` does not fail. It quietly means 3 March, so a date
  parsed from a form has to be round-tripped against its own string.
- Deleting a "why" comment deletes the reason a guard exists.
