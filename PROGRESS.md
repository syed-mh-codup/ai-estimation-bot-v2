# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-232 — first live verification of the Sheets export

Branch `fix/aeh-232-sheets-export-live`, commit `02db39f`, off master at
`4236f40`. Jira In Progress since 2026-09-01.

### What the live path was actually doing (diagnosed, not guessed)

Credentials are fine — `authorize()` succeeds. The folder is fine too: "AI
Estimates (v2)", in syed.hassan@codup.co's My Drive, with
`ai-estimation-bot@codup-internal-ops.iam.gserviceaccount.com` already a
**writer**. Two separate faults were stacked behind the single unhelpful
"The caller does not have permission" from 2026-08-07:

1. **Scope.** The code asks for `drive.file`, which by design only ever sees
   files the app itself created. A folder shared with the bot by a human is
   invisible to it — `files.get` on it returns 404. Proven by probing the same
   folder under three scopes: `drive.file` 404, `drive.metadata.readonly`
   visible, `drive` visible with `canAddChildren: true`.
2. **Ownership — this is the real blocker.** The service account has a Drive
   storage limit of **0**, so it cannot own a file and therefore cannot create
   one. Every create route fails, and Google words it differently each time:
   `sheets.spreadsheets.create` → "The service is currently unavailable";
   the same under full `drive` scope → "The caller does not have permission";
   `drive.files.create` with `parents:[folder]` → "The user's Drive storage
   quota has been exceeded." That last one is the honest message and the reason
   the other two were red herrings for a month.

No Shared Drive is visible to the bot, and it owns no files anywhere; the write
probes left nothing behind (verified).

### Decisions taken (2026-09-01, with the user)

- **Domain-wide delegation**, not a Shared Drive: `GOOGLE_IMPERSONATE_SUBJECT`
  names a Workspace user to act as, so created files are owned by and charged
  to a real account, and the existing My Drive folder keeps working.
- **Keep `drive.file`** for now and retest once ownership is fixed. Quota
  failed before create-with-parents could be isolated, so whether the narrow
  scope suffices is still an open empirical question. Widen to `drive` only if
  a live create 404s.

### Code state — done, unit-tested, green

- `packages/providers/src/sheets-provider.ts` — creates straight into the
  target folder (`drive.files.create` with `parents`), dropping the old
  create-in-My-Drive-then-re-parent hop that could never have worked. Optional
  `impersonateSubject` third constructor arg becomes the JWT `subject`. Shared
  `syncTabs` for create and update, whose delete guard now correctly drops a
  new file's default "Sheet1" (the old `existingSheets.length > 1` check left
  it behind). Failures are rethrown naming the likely cause. New `describeTabs`
  reads an export back — nothing in the product does, which is why nobody
  noticed.
- `packages/providers/src/sheets-diagnostics.ts` — `diagnoseSheetsConfig()`,
  read-only, distinguishes "not shared" from "invisible under drive.file" and
  prints the exact admin-console steps with the bot's client ID.
- `packages/agents/src/scripts/verify-sheets-export.ts` — `pnpm verify:sheets`
  (read-only) and `--live` (real export of a real estimate, read back, then
  exported a second time to prove it updates in place instead of duplicating).
  Registered as a knip production entry, or gate 2 of AEH-228 fails.
- 28 new unit tests, all green. `pnpm typecheck` and `pnpm lint` clean.

### The one thing left, and it is not mine to do

`--live` cannot run until a Workspace admin grants delegation:

    Admin console -> Security -> Access and data control -> API controls
      -> Domain-wide delegation -> Add new
    Client ID:     110768422158258397617
    OAuth scopes:  https://www.googleapis.com/auth/spreadsheets,
                   https://www.googleapis.com/auth/drive.file

then `GOOGLE_IMPERSONATE_SUBJECT=syed.hassan@codup.co` in
`apps/web/.env.local`. After that: `pnpm verify:sheets` (expect all PASS),
`pnpm verify:sheets --live`, then open the sheet and eyeball the tab shape —
AEH-232 explicitly asks for a human to look at the real spreadsheet, so the
ticket is not done when the script goes green.

### Traps found on the way

- **A domain-wide delegation grant is per-scope.** The diagnosis's fallback
  probe (which distinguishes "folder not shared" from "folder invisible to
  `drive.file`") must run as the BARE service account, never as the subject:
  asking for `drive.metadata.readonly` while impersonating fails
  `unauthorized_client` unless that third scope was granted too, and the
  diagnosis would then announce "nobody can see the folder" on a correctly
  configured install — reproducing the exact misdiagnosis this ticket exists to
  kill. Guarded by two tests now; a single shared `authorize` mock hid it,
  because the probe's independent failure was never modelled.
- `toMenuItem` is not interchangeable with `MenuItemSchema.parse`: it spreads
  the row's `meta` object and coerces nulls to undefined. A verification that
  hand-rolls the parse fails on rows the real export handles fine.
- `@repo/providers` is consumed through TS project references, so a new export
  is invisible to `packages/agents` until `tsc -b packages/providers` reruns —
  it reports as "has no exported member", which reads like a typo.
- `pnpm test` marks ~15 DB-backed test files as failed with **zero** failing
  tests: they are skipped under whole-suite Neon latency and pass individually
  (`packages/db/src/estimate.test.ts` alone: 2 passed in 10.2s). Not a
  regression; check the failing-test count, not the file count.
- `pnpm lint` fails on 14 pre-existing `no-undef` errors in untracked editor
  tooling (`.claude/helpers/*.cjs`, `.cursor/hooks/*.cjs`), nothing in `src`.

## Databases

    local docker  ai_estimation        24 migrations
    local docker  ai_estimation_test   24 migrations
    Neon test     (ep-wild-heart)      24 migrations
    Neon dev/main (ep-polished-credit) 24 migrations

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
