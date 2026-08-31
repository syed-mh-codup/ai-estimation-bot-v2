# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Resolved: the Neon dev/main wipe of 2026-08-31

**Restored and fully verified — nothing outstanding.** Kept here only until
AEH-240 closes; the lesson itself lives in the `prisma-shadow-db-wiped-neon`
memory, which is where it belongs long-term.

I wiped `ep-polished-credit` (Neon dev/main) by running `prisma migrate diff`
with a shadow-database URL built by appending `_shadow` to the real connection
string. The suffix landed inside the query string (`?sslmode=require_shadow`),
so the shadow database resolved to the live one — and `migrate diff
--from-migrations` resets its shadow database before replaying migrations into
it. The user restored from a four-hour-old backup the same day.

Verified after the restore and the re-migration:

    24 migrations, ledger consistent
    45 presets — each with a PresetRetrieval, PresetAnchor and PresetComposition
    45 of 45 retrieval rows carry a non-null embedding; 0 orphans in any of the three
    prompts active at v3/v4 with full ~5000-character bodies
    19 users, 4 estimates, 50 taxonomy nodes

The restore point predated AEH-244, so `migrate deploy` applied four migrations
rather than one: the three AEH-244 ones plus AEH-240's. I checked the split
migration before running it — it does `INSERT … SELECT` for every flat column,
embeddings included, into the new tables *before* the next migration drops them.
Nothing was lost a second time.

## Current: AEH-240 — custodian, deadlines, reminders

Branch `feat/aeh-240-custodian-deadlines`. **Stacked on
`feat/aeh-244-preset-concern-split`, which is still unmerged** — branching from
master would have put the schema behind the three AEH-244 migrations every
database already carries. Merging AEH-240 therefore lands AEH-244 with it.

Complete and verified: `pnpm -r build` green, `pnpm lint` clean, full
`pnpm test` green (56 files, 459 tests, 22 of them new), field and export audits
clean via `pnpm --filter @repo/audit run audit` (the root `pnpm run audit`
script is shadowed by pnpm's own `audit` and prints a vulnerability table
instead). Migrations applied to all four databases.

The cron expression is verified to fire at 09:00 PKT / 04:00 UTC daily — the
same instant the unit tests use as their sweep clock. **The one thing never
exercised live is Inngest registering the function.** Run `pnpm dev` and
`pnpm dev:inngest`, then confirm `estimate-due-reminders` appears in the dev UI.

The ticket is Done in Jira (closed by the user). The branch is **not merged and
not pushed** — that is the only outstanding action, and it lands AEH-244 too.

## Databases

    local docker  ai_estimation        24 migrations, data intact
    local docker  ai_estimation_test   24 migrations
    Neon test     (ep-wild-heart)      24 migrations, data intact
    Neon dev/main (ep-polished-credit) 24 migrations, restored and verified

⚠️ Still true from AEH-259: seed Neon dev/main with targeted scripts only, never
`pnpm db:seed`. It carries hand-tuned prompts at v3 and v4 whose text exists
nowhere in the repo, and the bootstrap seed would revert all ten to their
two-sentence v1 bodies. The restore above is what proved this is not theoretical:
those bodies are ~5000 characters each, and no other database in the project has
anything resembling them.

## Related tickets

**AEH-237** — multi-level approval, and now unblocked: AEH-240 is Done, and an
estimate carries a named person who is not merely its creator. Note the
custodian only exists on the branch until it is merged.

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
