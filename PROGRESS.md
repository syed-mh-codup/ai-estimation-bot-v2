# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-232 — Sheets export, live verified, NOT yet deployed

Branch `fix/aeh-232-sheets-export-live`, master merged in. Jira In Progress.

**The live export works, verified end to end on 2026-09-03** — the first time
this code path has ever run for real:

    DEV(77) QA(54) PM(63) BA(43) Roll-Up(5), headers correct, row counts exact
    second export updated in place, same spreadsheetId, no duplicate
    https://docs.google.com/spreadsheets/d/1LvZnk5XGXG7YVfEu7ioyOXgej0UjvgwMVBtnHZkSRmk

Domain-wide delegation was granted by the user and is confirmed working:
`authorize` issues a token acting as syed.hassan@codup.co, and file ownership
resolves to that account's real quota instead of the service account's zero.
`GOOGLE_IMPERSONATE_SUBJECT` is set in `apps/web/.env.local` (local only).

**The open scope question is settled: `drive.file` is sufficient.** The folder
itself stays unreadable under it, but files this app created inside the folder
are visible, so `getSpreadsheetId` finds them and re-exports update rather than
duplicate. No need to widen to full `drive`. The diagnosis's caveat used to
claim the opposite and was corrected in `21164d4`.

### Why prod still fails

Nothing to do with Google. **The fix was never merged** — master carries zero
occurrences of `impersonateSubject`, so the deployed build never asks to
impersonate anyone and the grant is inert there. Remaining, and all of it needs
the user:

1. Merge this branch to master (awaiting their go-ahead).
2. Add `GOOGLE_IMPERSONATE_SUBJECT=syed.hassan@codup.co` to the Vercel project
   under the **Production** environment — an env change alone does not
   redeploy, so trigger one after.
3. Eyeball the spreadsheet above, and click Export once in the running app so
   `exportSheetsAction` and `toMenuItem` are exercised through the real UI.

### Unexplained, possibly unrelated

Prod also showed "Application error: a server-side exception has occurred while
loading ai-estimation-bot-v2-web.vercel.app". That is a bare-domain page/layout
throw, not the shape a failing export server action takes — a failed export
surfaces on `/estimates/<id>`. No Vercel CLI is installed and the repo has no
`.vercel` link, so the runtime logs were not reachable from here. Needs the
exact URL and whether Export had been clicked; if it predates any export
attempt it is a separate bug from AEH-232 and probably belongs with the 21
AEH-235 commits that landed on 2026-09-02.

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
