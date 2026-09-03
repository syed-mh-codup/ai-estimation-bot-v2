# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-232 — merged and deployed, awaiting confirmation on prod

Merged to master as `91dd5f0` and pushed to both remotes on 2026-09-03, which
triggers the Vercel deploy. Branch `fix/aeh-232-sheets-export-live` is fully
contained in master and can be deleted. Jira still In Progress on purpose.

**The export is live-verified.** Against a real estimate: 5 tabs, correct
headers, row counts 77/54/63/43/5 read back out of Drive, and a second export
that updated in place with no duplicate. The sheet is at
`https://docs.google.com/spreadsheets/d/1LvZnk5XGXG7YVfEu7ioyOXgej0UjvgwMVBtnHZkSRmk`
and is deliberately left in Drive for a human to look at. Full detail is on the
ticket; the durable environment facts are in
[[sheets-export-service-account-quota]].

Two things could still make prod fail, neither of them code:

1. `GOOGLE_IMPERSONATE_SUBJECT` must exist in the Vercel **Production**
   environment. It was set locally in `apps/web/.env.local` here; whether it is
   set in Vercel was not verifiable from this machine. Without it the export
   fails on quota — but now with an error that names the cause.
2. Domain-wide delegation is granted and confirmed working (token issues while
   acting as syed.hassan@codup.co, ownership resolves to that account's real
   quota), so nothing further is needed in the Google Admin console.

Still outstanding: the human eyeball on that spreadsheet, and one export clicked
through the deployed app so `exportSheetsAction` and its strict read run through
the real UI rather than the script. Only then is the ticket honestly done.

### Unresolved, probably not this ticket

Prod showed "Application error: a server-side exception has occurred while
loading ai-estimation-bot-v2-web.vercel.app". That is a bare-domain page or
layout throw, not the shape a failing export server action takes — a failed
export surfaces on `/estimates/<id>`. No Vercel CLI is installed and the repo
has no `.vercel` link, so the runtime logs were never reachable from here. The
user was asked for the exact URL and whether Export had been clicked; no answer
yet. If it predates any export attempt it is a separate bug and probably belongs
with the AEH-235 commits of 2026-09-02.

## Left behind by AEH-235 (Done, on master)

AEH-235 is Done, merged and on master at `e3abf01`. The implementation record
lives on the ticket, not here — including the framing (the estimate owns its
dependency graph; the preset library's is a record, never read back), the
Cartographer, the saved configurations and what a re-derive keeps.

The branch `feat/aeh-235-scope-configurator` is fully contained in master and can
be deleted.

Four things this left for whoever picks up next.

**Component tests do not exist in this repo.** `vitest.config.ts` is
`environment: 'node'`, the include pattern is `*.test.ts` not `*.test.tsx`, and
neither jsdom nor testing-library is installed. So logic inside a React
component can only be reached by Playwright, at ~5 min per spec file and ~13 min
for the suite. The workaround AEH-235 used was to keep logic out of components
(`scope-interaction.ts`, `scope-dto.ts` — 40-odd tests in ~150ms). Adding jsdom
plus testing-library is the real fix and is an untaken dependency decision.

**The e2e suite is not green on master.** `estimates-create.spec.ts:17` fails
reproducibly there; `oracle.spec.ts` fails non-deterministically with a
different set each run. Both verified by stashing and re-running. Recorded on
AEH-282 with detail.

**The "Load bearing" chip on the estimate screen is dead** and knowingly left
alone — `PresetDependency` is empty, so `notSafelyRemovable` is false for every
card. Accepted debt, wants its own ticket. See [[preset-graph-is-empty]].

**AEH-306 (High)** — every agent prompt still asserts the preset library is the
ecommerce/B2B range P01–P45. Voiding that library made it false in all ten, and
it degrades matching silently rather than erroring. Should be scheduled ahead of
the preset wave. The bodies exist only in Neon dev/main, so it is a data change
with a runbook, not a code edit. The new CARTOGRAPHER prompt deliberately does
not repeat the mistake.

**Undecided from AEH-242:** it was §2 of six. §3 (AEH-243), §3b (AEH-245), §4
(AEH-246) and §5 each still want their own migration against a preset model that
is being reshaped anyway. Landing them as one reshape may be cheaper than four
sequential ones. Raised, never settled — worth deciding before the next starts.

## Databases

    local docker  ai_estimation        30 migrations
    local docker  ai_estimation_test   30 migrations
    Neon test     (ep-wild-heart)      30 migrations
    Neon dev/main (ep-polished-credit) 30 migrations

Remotes are `github` and `origin` (origin is Bitbucket). An earlier entry here
called the second one `bitbucket`, which is not a configured remote name.

⚠️ `packages/db/.env` points at **Neon dev/main**, so a bare `prisma migrate dev`
from that package runs against real data and can offer to reset it. Always pass
an explicit DATABASE_URL/DIRECT_URL when migrating locally. Related: the
`prisma-shadow-db-wiped-neon` memory.

⚠️ Stale `packages/*/dist` shadows source through TypeScript project references —
a barrel export can appear "not exported" until the referenced project is
rebuilt. `tsc -b` (what `pnpm typecheck` runs) is correct; a bare `tsc --noEmit`
per package is not.

⚠️ Local docker `ai_estimation` has **demo deadlines** set on its six most recent
estimates (one overdue, one due today, one in two days, one in nine, two
undated) and a custodian on alternate rows. Set by hand on 2026-08-31 to see the
dashboard states; harmless, but they are not real data.

⚠️ Still true from AEH-259: seed Neon dev/main with targeted scripts only, never
`pnpm db:seed`. It carries hand-tuned prompts at v3 and v4 whose text exists
nowhere in the repo, and the bootstrap seed would revert all ten to their
two-sentence v1 bodies. On 2026-08-31 that database was wiped by a `migrate
diff` shadow-database mistake and restored from a four-hour-old backup — the
restore proved the point, since those prompt bodies are ~5000 characters each
and no other database in the project has anything resembling them. The lesson
lives in the `prisma-shadow-db-wiped-neon` memory.

## Related tickets

**AEH-237** — multi-level approval, and now genuinely unblocked: an estimate
carries a named person who is not merely its creator, on master.

**AEH-282** — the e2e suite. Open, and the reason AEH-240 shipped with unit
tests only. Two specs are worth writing when it is healthy: setting a deadline
clears the reminder rows, and the dashboard leads with what is overdue.

## Traps worth keeping

- A schema split turns one atomic row insert into N writes. Wrap every
  multi-table write in a `$transaction` — `setDueAt` does, because a moved
  deadline that kept its old reminder rows would silence every nudge for the
  new date.
- `new Date('2026-02-31')` does not fail. It quietly means 3 March, so a date
  parsed from a form has to be round-tripped against its own string.
- Deleting a "why" comment deletes the reason a guard exists.
- `pkill -f 'next dev'` inside a compound bash command matches the shell running
  it and kills the command before it starts — a bare exit 144. Kill by PID or
  process group instead. (Already in [[local-dev-env-traps]]; hit again anyway.)
