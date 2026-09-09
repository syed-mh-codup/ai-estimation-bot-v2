# AEH-238 — findings

Everything found after the branch was built: fifteen from the code review, four
from you using it. Written 2026-09-09, against `10c15ee`.

Nine are fixed and committed. Ten are outstanding, and two of those are
features you have already specified rather than defects.

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

---

## Outstanding — defects

### 10. The Curator can collapse two proposed cards onto one

`packages/agents/src/curator.ts:211`

`reuseFor` is keyed by the model's own `ref`, and the schema only requires
`z.number().int().min(1)` — nothing makes it unique. Given
`[{ref:1, lines:[1,2]}, {ref:1, lines:[3,4]}]`, the second write overwrites the
first, both proposals read the same `reuseMenuItemId`, all four lines land on
one card, and the original the first proposal should have reused is left
line-less and deleted. A split silently becomes a no-op merge that loses a
card. **Fix:** key by the assignment's index, not by `ref`.

### 11. The no-requirement carry-through destroys most of each row

`packages/agents/src/ledger-edit.ts:690`

For a card with no matching requirement, rows are "carried through unchanged" —
except they are rebuilt from a five-column select. `notes`, `meta`,
`touchesFrontend` and `touchesBackend` are never selected, so the requirement
id, complexity tier, `aiAssistApplied`, `dependsOn` and `anchorPresetIds`
envelope every reader renders is destroyed, the DEV frontend/backend split is
lost, a hand-typed row's `HUMAN` provenance becomes `STEERED`, and a legacy row
over the cap is silently clamped. The comment above it says the rows are carried
through so the write does not silently delete them; it deletes most of each row
instead. **Fix:** select the full row, or skip those slices entirely.

### 12. The lock check sits outside the transaction that deletes the rows

`packages/db/src/ledger-edit.ts:215`

`applyRegionReplace` reads `LedgerLock`, then snapshots, then opens the
transaction. A `lockRegion` call landing in that window inserts a lock the
fingerprint cannot see — `ledgerLock.createMany` touches neither
`RoleLineItem.updatedAt` nor `MenuItem.updatedAt` — so `moved` is false, the
delete runs, and the lock cascades away with its row. My comment calls the
placement deliberate; the reviewer is right that it is the same window the
in-transaction fingerprint check exists to close. **Fix:** move the lock read
inside the transaction, or make the fingerprint cover the lock table.

### 13. A statement backfilled with whitespace can wedge its list for ever

`packages/db/src/statement-locks.ts:320`

The `..._aeh_238_statements` migration inserted `t."text"` raw, filtered only on
`btrim(...) <> ''`. So a legacy line of `' Phase one is out of scope. '` sits in
`EstimateStatement` with its spaces. `lockedStatementTextsMissing` builds its
multiset from `t.trim()` but looks the row up untrimmed, so it never matches: if
that line is locked, **every** save of the list is refused for ever with "would
be reworded or removed", even when nobody touched it. If it is unlocked,
`reconcileStatements` misses for the same reason and deletes-and-recreates the
row on the next blur, losing its id and provenance. **Fix:** trim both sides, and
`btrim` the existing rows.

I have not checked whether any real row on Neon has this shape. Worth a query
before deciding the priority.

### 14. A statement revision reads as an edit against a deleted card

`apps/web/src/app/estimates/[id]/EditActivity.tsx:64`

`startStatementEdit` stores `roles: []` and `pinnedCardIds: []`, so the panel
renders an empty roles chip and `titleOf([])`, which falls through to "a card
that is no longer here". Every assumption rewrite in the activity list reads as
an edit against something deleted. `statementIds` is already on the DTO and has
no consumer anywhere — the data to render it correctly is shipped and ignored.

### 15. The list padlock's override confirmation crosses the two lists

`apps/web/src/app/estimates/[id]/EditableList.tsx:290`

`holdsOthers` scans every statement lock on the estimate rather than the ones in
*this* list. So a colleague's lock on a narrative line arms the "override a
colleague's lock" confirmation on the assumptions padlock — a warning about a
lock in a different document — and, worse, the mirror case skips the
confirmation when it is genuinely needed. `CardLockButton` gets this right by
scoping to its own card's rows; this needs the same narrowing.

### 16. Every specialist call's prompt changed by one newline

`packages/agents/src/specialist.ts:180`

Inserting `buildRevisionBlocks` swallowed the blank line before "Respond with
JSON only". The function returns `''` on an ordinary run — no steer, no
existing lines, no ledger context — so every pipeline run's user message is now
one newline shorter than it was. The docstring two lines up asserts that a plain
run's message is byte-identical to what it was before steering existed, and
gives the reason it matters: a run whose message silently changed would re-price
differently for no recorded reason. Smaller than a gained section, same class of
unrecorded drift, on every `SPECIALIST_*` call on every estimate. **Fix:** return
`'\n'` for the empty case.

### 17. The Oracle no-write guard was widened by model instead of by verb

`apps/web/src/app/estimates/[id]/oracle-no-write.test.ts:74`

`OWN_MODELS` gained `estimateStatement`, and the write regex matches every verb
— so `prisma.estimateStatement.deleteMany({ where: { estimateId } })` added
anywhere in the Oracle source set would pass the guard untouched, wiping both
statement lists and, through the `StatementLock` cascade, every lock protecting
them. The companion assertion (one export, `appendStatement` only) covers
`statement-actions.ts`; the estimate-wide grep is what is supposed to catch the
*next* module. **Fix:** permit `estimateStatement.create` specifically and keep
every other verb an offence.

---

## Outstanding — things you specified, not defects

### 18. Only a few of a bulk edit's jobs are visible *(you found this)*

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

**Agreed fix:** a summary line above the rows ("34 edits: 2 running, 28 queued,
4 applied") computed from everything the poll returns, so the count is right
even when the rows are capped; raise `take` to cover a whole-estimate fan-out;
order in-flight first so what is moving is what you see. `concurrency: 2` left
alone — that is a spend decision, and a one-line change whenever you want it.

### 19. Locks cannot be scoped to a role from the UI *(you found this)*

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

**Agreed build:** all three affordances — a per-row padlock on hover, a per-role
padlock on the card, and a lock button for a whole role across the current
selection — with the card padlock staying lock-all, as you chose.

---

## Answered, no defect

### 20. Are Scribe and Curator calls cost-tracked? *(you asked)*

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
