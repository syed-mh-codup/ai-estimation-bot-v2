# AEH-238 — findings

Everything found after the branch was built: fifteen from the code review, four
from you using it. Written 2026-09-09, last updated against `c196980` plus the
role-lock work.

The numbers below are positions in this document, not stable identifiers — they
renumbered when items moved from outstanding to fixed.

All nineteen are addressed, plus a twentieth found in use afterwards — see 20,
which was by far the most damaging of the lot and was mine.

One of the nineteen turned out not to be a defect at all — see 16, where the
review was wrong and my fix for it was worse.

**A note on how to read the severity.** I have ordered by what the mistake
costs, not by how hard it is to fix. The four at the top could each lose
somebody's work or somebody's money without saying anything, which is the
property that makes them worse than a broken screen.

---

## Fixed and committed

### 1. A restructure looped, burning a model call each time — `10c15ee`

`packages/agents/src/ledger-edit.ts`

`applyRestructure` ran outside `step.run`. Inngest replays the function body
from the top at every step boundary, so each invocation reshaped again: it
re-created every card the Curator had not asked to reuse, giving them fresh
cuids, and deleted the previous pass's cards as "emptied" — because
`pinnedCardIds` had been overwritten, so they now looked like sources. The
re-cost steps are keyed `reassess:<cardId>:<role>`, so a new cuid meant a step
id that could never be served from the memo: a paid model call, a replay, and
round again until the step cap killed the job with the ledger already reshaped.

Now one memoized step covering the reshape and the `pinnedCardIds` write.

**Why no test caught it.** `LedgerEditDeps.step` defaults to running each step
inline, which is what makes the engine testable with no executor — and inline
means every step runs exactly once, in one pass. Nothing in the suite had ever
replayed anything. `packages/agents/src/ledger-edit-replay.test.ts` now is a
real executor: it suspends after each fresh step and re-invokes from the top.

### 2. A revert could destroy a locked row — `10c15ee`

`packages/db/src/ledger-edit.ts`, `packages/db/src/statement-edit.ts`

Neither revert path asked about locks — the only writes in this feature that
did not. Apply a steered edit, let a reviewer lock one of the rows it wrote,
then put the edit back: the `deleteMany` took the locked row with it and the
lock cascaded away. No error, no `LockEvent`, a lock nobody removed. The
statement axis had the same hole, where the upsert overwrote settled wording.

Both refuse now, and name what is locked and who holds it.

### 3. An empty proposal deleted the region and reported success — `10c15ee`

`packages/db/src/ledger-edit.ts`

`resolveTarget` documents that a `LINE` target ignores `roles` — a line *is*
one role. So a LINE-scoped edit whose roles omit that line's own role pinned
the row, produced no slices, and arrived at the applier with nothing to write.
The applier deleted the pinned rows anyway and stamped the edit `APPLIED` with
`hoursAfter: 0`. The council returning no line items for every slice reached
the same place.

Now `REFUSED_EMPTY`, its own outcome rather than an empty success — a delete of
everything the edit was pointed at, recorded as success, is the loudest way
this feature could lose somebody's work.

### 4. A reshape silently overwrote a colleague's concurrent edit — `10c15ee`

`packages/agents/src/ledger-edit.ts`

I passed `overwriteConflict: true` for a reshape to get past a fingerprint I
knew was stale. That switched off the concurrency check *entirely* — the one
protection this feature is built around. A colleague typing hours into an
unrelated row on the same card while the model calls ran had that row deleted
and replaced, with no warning and no chance to approve. It also stamped
`overwroteConflict` on every reshape, so the audit claimed a conflict nobody
had.

The fix is a new baseline, not no baseline: the reshape step captures the
region's fingerprint immediately after it lands, inside the memo — computed on
a replay instead, it would take a colleague's meanwhile-edit as the baseline
and hide exactly the conflict it exists to catch.

### 5. Nothing was visible after a reload — `10c15ee` *(you found this)*

`apps/web/src/app/estimates/[id]/page.tsx`,
`apps/web/src/app/estimates/[id]/ledger-context.tsx`

`page.tsx` passed `initialLocks`, `viewerId` and `renderedAt` to
`LedgerProvider` but never `initialEdits` — the prop existed and was typed, it
was simply not wired. And `poll()` only ever started from inside a steer. So an
edit already running was invisible on reload and nothing ever asked about it
again: no progress, no approve/discard on a parked conflict, no revert.

The panel now loads in the first paint and resumes polling for work already in
flight.

### 6. The ledger kept showing pre-edit hours — `10c15ee`

Nothing refreshed the estimate when an edit landed, so a person watched an edit
reach "Applied" while the cards below still showed the hours it had replaced —
the entire output of the feature, invisible. Every other background job here
refreshes when it lands (`ScopeDerive`, `ScopeScenarios`, `ScopeGraphEditor`);
this one did not.

The remount key had to widen for that refresh to mean anything. It was built
from section and **card** ids, and a re-price replaces line items while cards
keep their ids — so the key never changed and the provider held its stale
state straight through. Line item ids are in it now, and the statement lists
are keyed on text and provenance as well, because a steered revision rewords a
row *in place*: an id-only key could not see the Scribe's output at all.

### 7. `discardLedgerEdit` had no status check and no `assertOpen` — `10c15ee`

`apps/web/src/app/estimates/[id]/edit-actions.ts`

A bare update accepted any edit's id. Pointed at an `APPLIED` one it left the
rows in the ledger while recording that the proposal had been thrown away —
and since `isRevertible` only answers for `APPLIED`, those rows could then
never be put back. Pointed at a `QUEUED` one it changed a label while the job
kept running and wrote anyway.

### 8. The e2e seed still wrote a column that no longer exists — `cf5e055`

`apps/web/e2e/global-setup.ts` seeded `edited: false` after the column became
`provenance`. It survived five typecheck runs and a clean `next build`:
excess-property checking does not reach an object literal returned from a
`.map()` handed to a Prisma nested create. Only running the suite found it.

### 9. A filtered test run wrote to the real database — `cf5e055`

`packages/db/vitest.config.ts` and `apps/web/vitest.config.ts` had no
`setupFiles`, so a run started from inside either package skipped the root DB
pin and Prisma auto-loaded `packages/db/.env` — which points at Neon. Running
one test file from `packages/db` created and deleted fixtures in the real
database. It cleaned up after itself; it did not have to.

### 10. Locks could not be scoped to a role from the UI *(you found this)*

The storage is already per line item: `LedgerLock.lineItemId` is unique and
`resolveTarget` handles `CARD × ['DEV']` correctly. The guards, the refusals and
the engine all work at row granularity. **The UI never exposes it.**

- `CardLockButton` hard-codes all four roles (`LockControls.tsx:316`), so the
  padlock a dev would naturally click freezes DEV, QA, PM *and* BA.
- `LineLockBadge` returns null unless the row is already locked — it is an
  unlock-and-history control, not a lock one. So the `LINE` scope is
  unreachable.

So a dev locking their finished work blocks PM, BA and QA from touching their
own rows and forces each of them through the override ceremony to do their job —
the opposite of the intent, and contrary to your branch-2 answer that a lock
applies on the same axes a selection does.

**Built.** All three affordances, each placed where that scope's number already
sits — which makes "a lock and a selection are one coordinate system" visible
rather than merely true:

| control | scope | where |
| --- | --- | --- |
| `LineLockButton` | `LINE` | the row, beside its lock badge |
| `RoleLockButton` | `CARD × role` | the card's cell for that role's hours |
| `RoleLockButton` | `ESTIMATE × role` | the column head that names the role |

The card padlock stays lock-all, as you chose. Each role control is three-state
like the card's, because a role slice can be partly frozen and a plain open
padlock over four locked DEV rows would surprise whoever's edit is then refused.

Five tests in `lock-enforcement-db.test.ts` pin your case specifically: DEV
frozen on a card leaves QA editable, a QA line can still be added while DEV is
frozen, one role can be frozen across every card, a single role's lock does not
freeze the card's title, and the card's structure is still refused because one
locked row is enough.

Also fixed in the same pass: the list padlock's override confirmation was
scanning every statement lock on the estimate rather than its own list, so a
colleague's lock on a narrative line armed the confirmation on the assumptions
padlock — and the mirror case skipped it when it was genuinely needed.

---

## Also fixed — the seven lower-severity review findings

### 11. The Curator could collapse two proposals onto one card

`packages/agents/src/curator.ts`

`reuseFor` was keyed by the model's own `ref`, which the schema does not make
unique. Given two proposals both calling themselves 1, the second write
overwrote the first, both read the same `reuseMenuItemId`, every line landed on
one card, and the original the first should have reused was left line-less and
deleted — a split silently becoming a merge that lost a card. Keyed by the
assignment's index now, with a test that fails if it goes back.

### 12. The no-requirement carry-through destroyed most of each row

`packages/agents/src/ledger-edit.ts`

Rows the council could not price were "carried through unchanged" — through a
five-column select. `notes`, `meta`, `touchesFrontend` and `touchesBackend`
were never fetched, so a carried row lost the requirement id, complexity tier,
`aiAssistApplied`, `dependsOn` and `anchorPresetIds` every reader renders, lost
the DEV frontend/backend split, and had a hand-typed row's `HUMAN` provenance
restamped `STEERED`.

One `PINNED_SELECT` now covers both reads, and `ProposedRow` gained an optional
`provenance` so a carried row keeps what it had: it was not re-priced, so
calling it steered would record a re-assessment nobody made.

### 13. The lock check sat outside the transaction that deletes

`packages/db/src/ledger-edit.ts`

A `lockRegion` landing between the check and the `deleteMany` inserted a lock
the fingerprint could not see — `ledgerLock.createMany` touches neither
`RoleLineItem.updatedAt` nor `MenuItem.updatedAt`, so `moved` stayed false. The
delete ran and cascaded the lock away. My comment claimed the placement was
deliberate; the reviewer was right and the comment was wrong.

Checked twice now: once cheaply outside, so a refusal costs no snapshot, and
once inside the transaction, which is the one that holds.

### 14. A statement with surrounding whitespace could wedge its list — latent only

`packages/db/src/statement-locks.ts`, `packages/db/src/estimate-statements.ts`

**Verified against real data before deciding: zero of 2271 rows on Neon
dev/main are untrimmed.** Every writer trims before storing, so no path can
create one; only the backfill inserted raw values, and none of what it inserted
had surrounding space. So this was never live.

Trimmed on both sides anyway — one line each, and it removes the class. Had one
slipped through, a locked statement would have been unmatchable: every save of
its list refused for ever for a line nobody touched, or, unlocked, deleted and
recreated on the next blur, losing its id and provenance.

### 15. A statement revision read as an edit against a deleted card

`apps/web/src/app/estimates/[id]/EditActivity.tsx`

`startStatementEdit` stores no roles and no cards, so the panel rendered an
empty chip and "a card that is no longer here" for every assumption rewrite.
It reads its own write set now — `statementIds`, which was on the DTO with no
consumer — and says "Prose" where a role would go, because a sentence is not
DEV or QA work.

### 16. The specialist prompt drift — THE REVIEW WAS WRONG, and so was my fix

`packages/agents/src/specialist.ts`, `packages/agents/src/specialist-prompt.test.ts`

Reported as: inserting `buildRevisionBlocks` swallowed the blank line before
"Respond with JSON only", so every specialist call sent a message one newline
short. I applied it, returning `'\n'` for the empty case.

**Both wrong.** The template interpolates on its own line, so the newline after
the insertion point is already in it: returning `''` yields exactly the
original `\n\nRespond`, and my `'\n'` added a *third* — introducing the drift
the finding claimed to fix.

What caught it was insisting the new test fail without the fix. It didn't, so
I checked the template's actual bytes. Reverted, and the test now asserts both
halves — a blank line before the JSON contract, and *not* two — because
asserting only its presence passes whatever the function returns.

The lesson is the one worth keeping from this whole list: a review finding is
a hypothesis. I applied this one without verifying it and briefly made the
codebase worse.

### 17. The Oracle no-write guard was widened by model instead of by verb

`apps/web/src/app/estimates/[id]/oracle-no-write.test.ts`

`OWN_MODELS` gained `estimateStatement`, and the write regex matches every
verb — so `estimateStatement.deleteMany({ where: { estimateId } })` added
anywhere in the Oracle source set would have passed, wiping both statement
lists and, through the `StatementLock` cascade, every lock protecting them.

Allowed pairs now, not allowed models: `estimateStatement.create` and nothing
else, with its own tables keeping every verb because they are its own. A new
test feeds the guard that hostile line and asserts it is caught.

## Also fixed — the two things you specified

### 18. Only a few of a bulk edit's jobs were visible *(you found this)* — FIXED

Three limits stack, and a bulk re-price hits all of them:

| where | limit | effect |
| --- | --- | --- |
| `EditActivity.tsx:55` | `edits.slice(0, 8)` | 8 rows on screen, hard cap |
| `edit-actions.ts:384` | `take: 20` | the poll never knows about more than 20 |
| `inngest/functions.ts:417` | `concurrency: 2` | two run at a time; the rest sit `QUEUED` |

And a `REPRICE` fans out **one edit per card** — only a reshape groups them — so
a few dozen cards is a few dozen rows, not one job. With ~36 cards you see 8 of
36: two running, six queued, twenty-eight invisible.

Nothing is lost: every card got its own durable `LedgerEdit` row and they all
run. But this fails your own requirement — "it needs to be clearly visible what
stage its on, how many jobs are running" — on the exact workload that most
needs it.

**Fixed.** The list moved into a right-hand sheet with a fixed tab, and the tab
carries TRUE counts — a `groupBy` over status, bounded by the status vocabulary
rather than by the number of edits, so "34 · 2 running · 28 queued" is right
however many there are. The list stays a page (40, up from 20; shipping every
DTO on a two-second poll would trade one problem for a worse one) and the sheet
says which page of what it is showing.

`concurrency: 2` left alone — that is a spend decision, and a one-line change
whenever you want it.

## Found in use, after the review — and the worst of the lot

### 20. A big assumptions list could not be edited at all *(you found this)* — FIXED

`packages/db/src/estimate-statements.ts`

Reported first as "the assumptions lock is not working", then as "I deleted my
assumptions, they came back, and my replacements are gone". Neither was the
lock.

`reconcileStatements` reordered rows with a loop of one `updateMany` per KEPT
row, inside an interactive transaction on Prisma's default five-second timeout.
On the estimate it was found on — **485 assumptions** — deleting one line left
484 sequential round trips. At Neon's latency that blows the timeout: nothing
commits, the action throws, and the editor's optimistic revert restores the old
list. So the deleted lines return, and whatever was typed instead was never
written anywhere.

It is also why the other estimate looked fine: 24 assumptions is 24 round
trips, comfortably inside the budget, so every lock and every save there
behaved exactly as intended. Both reports were one bug wearing two faces.

One `UPDATE ... FROM (VALUES ...)` now, still conditional on the order actually
differing so a renumber does not restamp every row's `updatedAt`, plus an
explicit generous timeout.

**Nothing typed was recoverable** — there is not one `HUMAN` or `STEERED`
statement on that estimate, so none of it reached the database. The crew's 485
are intact.

**Why no test caught it, which matters more than the fix.** Every test in that
file used two or three lines. I wrote size tests first — 485 rows, delete the
first, insert at the top, replace them all — and they pass *with the bug still
in place*, because 484 round trips against local docker take a fraction of a
second. Wall-clock cannot pin a latency bug on a fast database.

What pins it is the ROUND TRIP COUNT: a Prisma client with query logging,
asserting the whole reconcile costs under twenty queries. With the loop
restored it reports **489**. That fails for the right reason on any database at
any latency.

The same loop shape exists in `applyStatementRevision` and
`revertStatementRevision`. Neither is broken — both are bounded by what a
person ticked and both already carry a 60s timeout — but the constraint is now
written next to each, with what would have to change if a future selection
could reach a whole list.

## Answered, no defect

### 19. Are Scribe and Curator calls cost-tracked? *(you asked)*

Yes, both, fully. `runCurator` records with `kind: 'CURATOR'`
(`curator.ts:165`) and `runScribe` with `kind: 'SCRIBE'` (`scribe.ts:163`), both
through `createUsageRecorder` in the engine with `ledgerEditId: editId`
attached. Both kinds are in `AGENT_USAGE_KIND`, and `/admin/usage` groups
straight off `ModelUsage.kind`, so they appear as their own rows with no further
wiring. The `ledgerEditId` join also makes "what did this specific edit cost"
answerable, which the other agents do not have.

Both are editable at `/admin/prompts` like every other agent, because that
screen is driven by `AGENT_CATALOGUE`. They show a "not seeded" pill on any
database without the prompt row; `pnpm --filter @repo/db db:seed:prompt SCRIBE`
installs it and touches nothing else. Done on local docker and Neon dev/main.

---

## Not a finding, but worth recording

**e2e is 53 passed / 2 failed, and the 2 are not from this ticket.** Both are
the Cartographer graph specs (`scope.spec.ts:200` and `:241`), failing because
`INNGEST_EVENT_KEY` is unset in CI so the job never queues. The master run from
the day before this branch shows the identical two specs and the identical
counts. Every statement, lock and edit spec passes.

**The live outage was mine.** Applying the migrations to Neon dev/main was a
production event, because the deployed app and local dev share one database.
Three of the six dropped columns the running build still read. Additive
migrations are safe to land early; destructive ones are not — code first, or
both at once. No data was lost: the backfill ran before the drop inside the same
migration, and the counts were verified either side (119 narrative and 2152
assumption lines, 554 rows to `HUMAN`, 6851 to `CREW`).
