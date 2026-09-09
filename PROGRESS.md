# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## In flight: AEH-238 — AI-assisted WBS editing (SPEC AGREED, awaiting approval to build)

No code written. No Jira writes made. Ticket left in Selected for Development.

Spec settled by a grill-me interview on 2026-09-09. The reframe came from the
user and it is NOT what the ticket says: this is not a propose-then-verify diff
surface. **A human declares the blast radius up front, the system enforces it
mechanically, and the AI works inside it.** Out-of-scope damage is impossible
rather than something a reviewer has to catch.

### The envelope

Axes: `scope × role`, where scope is estimate / section / card / line and role
is DEV/QA/PM/BA. Declared by SELECTING in the UI, then prompting — no NL parsing
of scope, so the boundary is deterministic UI state.

**The envelope never cascades.** `packages/shared/src/scope-selection.ts` has a
selection model already, but it is the scope configurator's (AEH-235): card-only
and it walks the dependency graph to pull in prerequisites. Reusing it would
silently widen a boundary the human drew deliberately. Mirror its refusal shape
(`SelectionChange.refused`), do not reuse the module.

### Locks

Same coordinate system as the selection — one addressing concept serves both the
thing a human grants and the thing a human forbids. Row (`RoleLineItem`) is the
finest unit, because a row is one description paired with its own hours for one
role; freezing half of it would freeze half of one thought. No per-field locks.

A lock freezes **hours, description, and existence**. Placement stays free
(`sectionId`/`order` are presentational per the schema). So: no hour change, no
rename, no delete, no merge; dragging between sections is fine.

**Coarse locks materialise to row level at lock time.** Otherwise a lock is
escapable: lock `section × DEV`, drag the card out of the section (allowed —
placement is free), and a live membership test would unlock it. The hover
history records that a row's lock came from a section lock.

**Read is WIDE, write is NARROW — and this is load-bearing, not a nicety.**
The model sees everything the Oracle sees: every menu item, the assumptions, the
narrative and the corpus (`sowText`). It writes only inside the envelope. A
blind AI makes edits that are locally plausible and globally wrong — splitting a
module without seeing the rest of the ledger produces a duplicate of a card that
already exists elsewhere. Locked rows are VISIBLE AND MARKED, never hidden. So
the prompt carries two clearly separated sets: what you can see, and what you
may change.

**Enforcement rule, and it is the whole mechanism:**

    Refuse if (selection ∩ locks) ≠ ∅. Otherwise the write set is exactly the
    selection, and nothing outside it is writable.

So locking DEV on a card does not block re-costing QA on that same card — the
sets do not intersect. A refusal names what is locked and who locked it.

Locks bind USERS as well as the AI, so `updateLineItem`, `deleteLineItem`,
`renameMenuItem`, `deleteMenuItem` and `setItemEnabled` all grow a lock check.
NOT `moveMenuItem` — placement is free. `setItemEnabled` IS frozen: toggling a
locked card off changes the totals, so it belongs with existence. This is a
permission layer on the ledger that the AI happens to also respect.

Override: the locker unlocks freely; anyone else must confirm they are
overriding. **No reason required** — simple audit is the preventative measure,
and the team is trying to remove steps, not add them. The lock's history
(who, when, overrides) renders on hover.

### One engine, not two

The 0.5-hour case killed the arithmetic path: a 30% cut on a 0.5h row gives
0.35h, which violates the quarter-hour snapping and the four-hour-rule
decomposition the rows exist to express. The work must be re-thought for the
hours to be honest.

So **every edit is a re-assessment inside the envelope**, and the write is
"replace the rows in this region with a new set" — not "patch these rows'
numbers." Rows may appear, vanish and be rewritten. The envelope is a REGION
THAT GETS REGENERATED.

The human steers; the model re-assesses against the requirement. The model may
set numbers because it went back to the requirement — the same licence the
specialist council has. Abuse ("throw cards in the air and see what sticks") is
knowingly deferred: "we will fix it when we get there."

### Structure (split / merge)

- The human normally states the seam. The AI MAY decide the seam, but only when
  explicitly asked to.
- A restructure **re-costs by default**; preserving the total is the opt-in.
  Cutting a module in two re-conceives the work.
- The AI decides `taxonomyKey`, `category`, `phase`, `requirementIds` — those
  were the Librarian's and Architect's calls, not a human's.
- **`matchScore` → null** on any structural change. It is an Archivist
  embedding-similarity measurement, not a judgement; a model asked for one emits
  fiction, and promotion/writeback read it.
- Affected `ScopeScenarioPick` rows and `MenuItemDependency` edges are
  invalidated by the existing re-run rule ("dependencies and the scopes cut from
  them are properties of THIS set of cards"). `HiddenWorkFinding.menuItemId` is
  cleared while the outcome survives — also an existing precedent.

### A full re-run refuses while any lock exists

`runEstimate` still deletes every row at `run-estimate.ts:460`, so the first
re-run after someone locks a card destroys the locked work and orphans its audit
trail. Same rule as 2c: refuse, naming the locks and who set them. The refusal
belongs in the action that DISPATCHES the Inngest job — not inside the persist
step, five minutes of paid model calls later.

### Apply model — no gate in the happy path, a gate only when the world moved

1. Pre-flight: warn if the region on screen is already stale vs the DB, before
   spending a model call.
2. Run.
3. Apply: re-check the region. Unchanged -> the write lands immediately.
   Changed -> warn and ask; approving overwrites the concurrent change,
   rejecting discards the AI's work.
4. After: the region is marked as this prompt's work, with a one-level revert
   scoped to that region.

**Gap this needs:** there is no cheap staleness signal today. Neither `MenuItem`
nor `RoleLineItem` has `updatedAt` or a revision counter, so "has this card
moved" currently requires refetching and comparing. Add a per-card revision
marker — one column, and the same column the begin/end conflict check reads.

The richer undo model, and how undo behaves under concurrent editing, is
EARMARKED FOR LATER WORK. Not designed now.

### Assumptions and narrative

Their own tickable targets, outside the `scope × role` axes. Both get
**promoted from `String[]` to real tables**: a bare string in an ordered array
has no identity, so "lock assumption 4" locks an array index that breaks on the
next insert, and the audit could only ever say "the assumptions changed."

The Oracle's `{{suggested assumption}}` copy button becomes a one-click write
once a write path exists — in scope, as QoL. Note that "Oracle has no write
path" is currently asserted in four places
(`packages/shared/src/citations.ts:110`, `Oracle.tsx:609`, the `OracleRole`
schema comment, `oracle.test.ts`), so crossing it needs a sibling AgentKind, not
a change to Oracle.

### Provenance and the audit record

`RoleLineItem.edited` becomes an enum: **CREW / HUMAN / STEERED**. It is
display-only — exactly one behaviour-bearing read, a badge at
`MenuCardEditor.tsx:860`. Nothing gates on it: not promotion, not writeback, not
the Sheets export. Full blast radius, counted: three write sites in
`actions.ts` (215/226/270) setting true, three in the agents package setting
false (`architect.ts:81`, `audit.ts:123`, `taxation.ts:128`), the zod default at
`packages/shared/src/schemas.ts:349`, two DTO mappings in
`packages/db/src/menu-item-mapping.ts`, and a Boolean-to-enum migration on Neon
with a backfill (true -> HUMAN, false -> CREW).

One audit row per prompt, holding: the prompt verbatim, the resolved envelope
(concrete card and row ids), the model's stated reasoning, who and when, the
model and its cost via a new `UsageKind`, whether it was reverted, whether it
overwrote a conflict, and a **JSON before/after snapshot which doubles as the
revert payload**.

Performance was raised and answered: a card × DEV envelope is ~16 rows (~6KB);
the pathological whole-estimate case is ~170KB each way. Postgres TOASTs any
JSON column over ~2KB — out-of-line, compressed, not read unless selected. Two
conditions: (1) the payload column is NEVER selected by default, or a careless
`findMany` drags every snapshot out of Neon; (2) the snapshot writes in the SAME
TRANSACTION as the ledger change, because a ledger write whose revert payload
did not land is worse than no audit. Retention deferred. Analysis path is
download-and-take-it-elsewhere (Hex / chat), which suits a blob better than a
normalised child table.

### Neighbours — do NOT conflate

- **AEH-366 stays exactly as it is.** It is a UX problem: how a user interfaces
  with numbers manually and consciously. This ticket is a strategic problem.
  I twice tried to merge them and was twice told not to. Its role-filtered view
  and keyboard ergonomics are its own.
- **AEH-241 stays separate.** It was always meant as a steer for the INITIAL run
  and for re-runs, not for review-time editing. Do not present this ticket as
  satisfying it.
- **AEH-367** is still blocked by the corpus being deleted at
  `apps/web/src/inngest/functions.ts:210` — untouched by this. But locks plus
  region-replace are most of the answer to its "a re-run destroys every hand
  edit" problem, and that is worth a comment on it once this lands.

### Corrections owed to the ticket itself (on approval)

- The "manual editing exists and is good" line must go — AEH-366 explicitly asks
  whoever picks up first to fix it.
- The claim that the partial-run mechanism "must now be designed" is too
  pessimistic. `runSpecialistCouncil` is already invoked standalone for hidden
  work at `packages/agents/src/run-estimate.ts:364` with a synthesised
  requirement, and the Librarian's requirement set survives every run in
  `Estimate.agentState.librarianOutput`. The real gap is the PERSIST — the
  delete-and-recreate at `run-estimate.ts:460-481` — which region-replace fixes.
- Use the `jira-text` skill for both; paired markup characters get eaten.

### Constraints from the code the design obeys

- `IModelProvider` has NO tool calling
  (`packages/providers/src/model-provider.ts:158`). The grain is `chatJSON` +
  zod with `responseFormat: 'json_object'`.
- ONE chat turn is ONE model call, deliberately, because of Vercel Hobby's 300s:
  `apps/web/src/app/api/estimates/[id]/oracle/route.ts:24`. No agentic loop.
- Any applier MUST reuse `updateLineItem`'s tax recompute
  (`apps/web/src/app/estimates/[id]/actions.ts:226`) — it taxes at the config
  version the estimate is PINNED to, not the active one. AEH-335 exists because
  that was got wrong once.
- The model's re-decomposition must be validated deterministically against the
  four-hour rule and `snapToQuarterHour`.
- `MenuItem.requirementIds` lives in `meta` (JSON), and the schema warns `meta`
  is write-only by convention (the AEH-227 lesson). Reading it needs a validated
  helper or promotion to a column.

### UI placement — proposed, needs approving not discovering

Selection ticks live on the cards and their rows; role chips and the prompt box
live in a bar that appears only once something is selected, anchored to the
bottom of the ledger rather than added to the rail — AEH-302 already records
that the rail is a fixed stack that buries its actions, and this would be the
heaviest thing in it. Lock controls sit on the card header and the row, with
the history on hover. The revert affordance sits on the region it applies to.

### Sizing

Seven migrations on Neon: lock table, per-card revision marker, provenance enum
(with backfill), audit/revert table, assumptions table, narrative table, and the
sibling AgentKind plus UsageKind (which also needs catalogue entries in
`agent-catalogue.ts` and `usage-catalogue.ts` — there is a completeness test
that fails until both move, plus a `PromptVersion` row for the new agent).

Stage 1 (locks) is the smallest and ships standalone value. Stage 2 is the bulk
of it. Realistically this is two to three weeks of build before the single
review, and the migration count is the part that will hurt.

### Also decided

`setEstimateTaxPct` is a bulk hour change by another name — it re-taxes every
row of a role. It must REFUSE while any row of that role is locked, naming them,
rather than quietly re-taxing frozen hours. Same rule as the full re-run.

UI placement above is approved for now, to be revisited at the end.

### Build order — ONE review at the end

The user will review all of it in one go. Build everything, then call it done.
Commit checkpoints as it goes (terminal crashes), but no incremental review.

1. **Locks** — no AI. Auditable, hover history, enforced in the existing manual
   server actions. Standalone value on day one, and it establishes the
   enforcement rule everything else depends on.
2. **The engine, hours only** — selection UI, region-replace persist, the new
   sibling agent + prompt row + catalogue entries, revision markers, provenance
   enum, audit/revert table, conflict flow, job progress. Scoped to `card x role`.
3. **Structure** — split, merge, and the metadata rules above.
4. **Assumptions and narrative** — the tables, plus the Oracle copy-button write.

### Checklist (tick as it lands — terminal crashes)

Stage 1 — locks  (DONE, local docker only — see the migration note below)
- [x] `LedgerLock` + `LockEvent` schema and migration
      (`20260909120000_aeh_238_ledger_locks`)
- [x] lock/unlock/override server actions, coarse locks materialised to rows
      (`packages/db/src/ledger-locks.ts`, `lock-actions.ts`)
- [x] enforcement in `updateLineItem`, `createLineItem`, `deleteLineItem`,
      `setLineItemSide`, `renameMenuItem`, `deleteMenuItem`, `setItemEnabled`
      (`apps/web/src/lib/lock-guards.ts`)
- [x] `setEstimateTaxPct` refuses on a locked role
- [x] full re-run refuses at dispatch while any lock exists
- [x] lock UI on card header + row, history on hover (`LockControls.tsx`)
- [x] tests — 15, `packages/db/src/ledger-locks.test.ts`

Migrations are applied to LOCAL DOCKER ONLY so far, deliberately. Neon dev/main
and the Neon test branch get every migration in one pass at the final gate, so
the schema is settled first rather than half-applied across three targets.

Two notes for the reviewer of stage 1:
- Role-scoped locking exists in the data model but has no UI yet. Picking roles
  is the selection bar's interaction, so the role picker arrives with stage 2
  rather than being built twice.
- `prisma format` reflows the WHOLE schema file (it had pre-existing drift), so
  the schema edits here are hand-formatted to each block's existing alignment.
  `git diff -w` on the schema is pure additions, which is the check.

Stage 2 — engine  (DONE)
- [x] `updatedAt` on MenuItem + RoleLineItem as the staleness fingerprint;
      provenance enum CREW/HUMAN/STEERED + backfill
      (`20260909130000_aeh_238_edit_engine`)
- [x] `LedgerEdit` audit/revert table with `PENDING_CONFLICT` and `FAILED`
- [x] NO new AgentKind — the specialist council does the re-pricing. See below.
- [x] wide-read ledger summary with locked cards MARKED
      (`renderLedgerContext`, `packages/agents/src/ledger-edit.ts`)
- [x] three optional prompt blocks on `SpecialistInput` (steer, existing rows,
      ledger context); a plain run's message is byte-identical to before
- [x] Inngest `ledgerEditFn`, one step per card per role, concurrency 2
- [x] region-replace persist reusing the PINNED-config tax recompute
- [x] quarter-hour snap + four-hour clamp at the persistence gate
- [x] conflict checks: pre-flight staleness warning, apply-time park
- [x] selection UI (`EditBar`), progress + decisions (`EditActivity`)
- [x] one-level revert, scoped to the region
- [x] tests — 10 in `packages/db/src/ledger-edit.test.ts`

The design decision worth reading before touching stage 2: there is NO new
agent kind. Every edit is a re-assessment against the requirement (the
0.5-hour case), which is exactly what `runSpecialist` does — against the same
admin-authored prompts the estimate was costed with. A purpose-built edit
agent would re-derive the four-hour decomposition in a fresh prompt and
diverge from the crew's numbers immediately. It also hands us the envelope's
granularity for free: card x DEV runs SPECIALIST_DEV and nothing else.

Cost attribution is `ModelUsage.ledgerEditId`, a join, mirroring `artifactId`
— not a usage kind, because the call really IS a SPECIALIST_* call.

Two bugs found and fixed while building, both worth knowing about:
- `revertRegion` first identified an edit's rows by card + provenance, which
  also matches an EARLIER steered edit on the same card, so putting one back
  destroyed another's work. Now the written ids are captured with
  `createManyAndReturn` and stored in `afterSnapshot`. Pinned by a test.
- `LockInfo` was a hand-written look-alike of the Prisma row type, which made
  every `lock.declaredScope` read invisible to the orphan-field audit. It is
  a `Pick<LedgerLock, ...>` now — the audit attributes reads by the
  RECEIVER's type.

Stage 3 — structure
- [ ] split/merge ops in the change set
- [ ] metadata rules (matchScore null, scenario picks, graph edges, findings)
- [ ] tests

Stage 4 — assumptions + narrative
- [ ] tables + migration + backfill
- [ ] targets in the envelope
- [ ] Oracle suggested-assumption becomes a write
- [ ] tests

Gate before review: `pnpm --filter web build` (the only check that compiles
routes), typecheck with `tsc -b` ordering, lint, full vitest with docker up,
migrations applied to all three targets, then `/review`.

### Why the engine is an Inngest job, not a chat turn

A whole-estimate envelope (863 rows, all roles) will not be re-assessed inside
300s in one call. The engine is job-shaped, not conversation-shaped, and the
house rule is already stated at `route.ts:29`: "everything else that takes time
is an Inngest job the client polls." Oracle streams because watching words
appear IS the value; here the value is the result. So: ALWAYS Inngest, one step
per card, which also makes the model calls durable and replayable.

**The job must be visible and in context.** A background job that shows nothing
is worse UX than the blocking call it replaces, and the user needs to stay
engaged with it. Show the stage it is on and how many are running, on the ledger
where the edit is happening rather than on a separate page. There is a precedent
to mirror: `RunProgress { stage, pct }` is persisted to the `Estimate` row by
`onProgress` in `RunEstimateDeps` and polled by the UI (see
`ArtifactProgress.tsx`). This needs the same, per job, with several concurrent.

Consequence that must be specced: a background job cannot "ask" about a
conflict. So a conflict detected at apply time parks the after-snapshot in the
audit row as `PENDING_CONFLICT`, and the UI presents approve/discard against it.
That IS the "write warns, approval overwrites" mechanism from branch 5 — it
falls out of the audit table rather than needing anything new.

### Corpus render needs handles (stage 2)

Region-replace does not need row ids, but split and merge address cards, and
locked rows must be VISIBLE BUT MARKED to the model — the user was explicit that
a locked card stays in the AI's context and is merely unwritable. The Oracle
corpus carries no ids at all (`packages/agents/src/oracle.ts:33-52`), so the new
agent needs its own render with stable handles the applier resolves.

---

## In flight: AEH-335 — per-estimate PM/BA/QA buffer overrides

Branch `worktree-aeh-335-per-estimate-tax`, off master `ce88455`. The ticket
carries the full design; it was groomed from an undesigned stub on 2026-09-08
before any code. Read the ticket first — every decision below is justified there.

Order of work, ticked as it lands:

1. [x] Schema: three nullable `*PctOverride` columns + `overheadRatesStale` on
       Estimate, `overhead` on MenuItem, new `EstimateTaxChange`.
2. [x] Migration `20260908170000_aeh_335_per_estimate_tax_overrides`, generated
       with `prisma migrate diff --from-schema-datamodel` (pure, touches no DB)
       and a hand-appended backfill for `MenuItem.overhead`.
3. [x] `prisma generate`.
4. [x] Audit + schema-ledger test — all three gates clean.
5. [x] `resolveTaxPercents` in `@repo/shared` — the lowest common dependency of
       apps/web and packages/agents, so there is exactly one implementation.
6. [x] Collapse the two `taxPercents()` copies onto the PINNED configVersion.
7. [x] `setEstimateTaxPct` action: role-scoped recompute, skips overhead cards.
8. [x] Client: taxPercents becomes state, RollupCard is the edit surface.
9. [x] run-estimate: honour overrides, write configVersion back, clear stale.
10. [x] Tests (900 pass) + `next build` green.
11. [x] Committed on `worktree-aeh-335-per-estimate-tax` (5 commits) and merged
        `--ff-only` into local master.

### Migration state

Applied to local docker `ai_estimation` and `ai_estimation_test`, and to **Neon
dev/main** (`ep-polished-credit`) by hand on 2026-09-08. All three are at 35.

**Neon test (`ep-wild-heart`) is one migration behind** — checked 2026-09-08 with
`migrate status`: 34 applied, this ticket's is the only one pending.

Its URL is `TEST_DATABASE_URL` in `apps/web/.env.local`, NOT anything in
`packages/db/.env` — that file names dev/main, and Prisma auto-loads it, which is
why a bare `migrate deploy` from `packages/db` silently targets dev/main instead.
An exported `DATABASE_URL` does override it (verified), but confirm the host with
`migrate status` before applying rather than trusting that.

The `MenuItem.overhead` backfill was verified against real data on Neon
dev/main, which is the only place it had any to act on: 276 menu items, 34
injected, all 34 carrying a `process.*` key, and all 34 marked. Zero injected
cards fall outside the predicate, so nothing was missed and nothing was wrongly
marked. Local docker had no overhead cards at all, so the local run proved
nothing about it.

Master is merged locally and **still not pushed** — that is a deliberate hand-off,
not a blocker: Neon dev/main now has the columns, so a push is safe whenever the
deploy is wanted.

### How it was verified

917 tests over 82 files, typecheck and lint clean, all three audit gates clean,
`next build` compiles. Beyond that: a DB-backed test drives the real action
against local Postgres (the mock tests cannot fail the way Prisma can), and the
rollup was rendered in a real browser — no hydration warning, and the finalised
state exposes zero interactive elements, so read-only holds at the
accessibility level and not just visually.

One gap worth knowing about: the Chrome extension's synthetic typing never
reached React's onChange on that page, so the click-and-type path was not
exercised end to end. The claim it would have checked — that the headline total
moves — is instead asserted directly by `retax-role.test.ts` (29.25 -> 30 at a
40% QA buffer, overhead card untouched), which is the better test anyway.

Migration applied to local docker `ai_estimation` and `ai_estimation_test` only,
by `migrate deploy` with an explicit URL. **Neon has NOT been touched** — that is
deliberately the user's call, and it must happen before or with the next deploy
because the estimate page now reads the new columns.

### A pre-existing flake this branch surfaced (NOT a regression)

The full suite intermittently fails `writeback-graph-carry.test.ts` with
`Inconsistent query result: Field preset is required to return data, got null`,
thrown from `loadPresetGraph` in `preset-graph.ts`.

It is memory trap 5 (`local-dev-env-traps`): seven test files call `deleteMany`
on Preset/PresetVersion/PresetDependency, vitest runs files in parallel against
one shared database, and a delete lands between the version read and its
`preset` join. Adding this branch's two test files shifted vitest's worker
layout, which is the documented trigger for it becoming visible.

Proven pre-existing rather than assumed: running ONLY those seven preset files
plus `writeback-graph-carry`, with none of this branch's code or test files in
the run, reproduced it **5 times out of 5** (16 identical errors). It also passes
when run alone. This branch touches no preset, writeback or preset-graph file.

Worth its own ticket — the fix per memory is per-file fixture namespacing, across
seven files. Do not "fix" it by rewinding a sequence in teardown; see
[[shared-sequence-rewind-flake]].

Non-obvious bits, so a fresh session does not undo them:

- The recompute is ROLE-SCOPED on purpose. A whole-estimate rewrite would
  silently "heal" PM/BA lines carrying mixed-version hours from the very bug
  this ticket fixes, moving numbers the estimator never touched.
- `MenuItem.overhead` exists because a delivery-overhead card is already a
  percentage OF taxed hours. Re-taxing one compounds a percentage on a
  percentage. The backfill predicate is exact, not heuristic: `process.*`
  taxonomy nodes are all `classifiable = false`, so no asked-for or hidden-work
  card can ever carry one of those keys.
- Per-line 0.25h snapping stays, and the lumpiness it causes is documented in
  the ticket as chosen. Line hours must sum to the displayed total.
- ⚠️ Do NOT push master. Vercel deploys from it against Neon, which will not
  have this migration; the estimate page reads the new columns, so a deploy
  ahead of the migration breaks that page outright.

## Current: AEH-239 — artifact generation alongside the WBS (built, awaiting merge)

Branch `feat/aeh-239-artifacts`. Plan approved 2026-09-03. The shape below is
the agreed one, written down before the code so a crashed session can resume
from it.

**All four slices are built.** `15e8f2f` schema + migration, `e156394` admin
UI, `dbb74b5` the generation pipeline and the estimate-side UI, plus the dry run
and the contract docs. 690 tests pass (three consecutive green runs), typecheck
and lint clean, `next build` green, all three audit gates clean.

**Verified live** on 2026-09-03, against the running app with Inngest and the
stub provider: logged in, created a type, dry-ran the outline, generated
through the real route, and read the finished document. The route enqueued,
Inngest ran outline + three section steps + assemble, and the row reached DONE
with three sections. The assembled document is a whole HTML file carrying its
own `default-src 'none'` CSP, a tab bar, one panel per section with only the
first visible, print CSS that keeps all of them, scoped section CSS and no
leaked markdown fence. Four ModelUsage rows, all ARTIFACT, all attributed to
the artifact. The viewer rendered `sandbox="allow-scripts"` with no
`allow-same-origin` — checked in the real HTML, since that is the one mistake
that would quietly undo the isolation.

The dry run is the strongest evidence the corpus plumbing works: the type
ticked cards + requirements + rollup, and the plan came back with exactly those
three sections, because the stub derives its outline from the headings actually
present in the dossier.

**Not done:** a pass against a REAL model. Everything above used
`OPENROUTER_STUB=1`, so nothing here proves what a real model does with the
envelope — how well briefs plan, whether sections respect the ~1200-word
budget, or what a document actually costs. That is the next thing, and it wants
a human deciding the spend.

**Also not done: pushing, and merging to master.** `git push` was refused by the
sandbox, so every commit is local to this worktree. Master has since been merged
INTO this branch (it had moved five commits for AEH-232), so the branch is now a
clean fast-forward with no conflicts left to resolve — the only conflict was
this file, where both sides had rewritten the Current section, and both records
are kept below because both tickets really are in flight.

**Sequencing worth knowing before merging:** master's head is AEH-232, which is
deployed and still awaiting a human confirmation on prod. Merging AEH-239 on top
puts a second unconfirmed change into the same deploy. The schema is already
migrated everywhere and is additive, so there is no rush and no breakage either
way — but stacking the two is a decision, not a default.

**No Playwright spec.** The suite is red on master (AEH-282), so a new spec
could not be gated on anything; the live pass above covers the same ground by
hand. Worth writing when the suite is healthy — and with no seed, the spec has
to create a type through the admin UI first, which makes it a test of the
ticket's actual claim rather than of a fixture.

Two things a resuming session needs that are not obvious:

- **This worktree gets its own Postgres, and it is gone.** `docker compose up -d
  postgres` from here creates the compose project `aeh-239-artifacts`, a
  *different* volume from the main checkout's, so it comes up EMPTY — bring it
  to the current migration with `prisma migrate deploy` before running any
  DB-backed test. That isolation is deliberate, and it is why every command
  here passes an explicit
  `DATABASE_URL=postgresql://postgres:postgres@localhost:5433/ai_estimation`.
  It was torn down with `docker compose down -v` after the live pass, so a
  resuming session starts from nothing. Neon was never touched at any point.
- **The orphan-field gate is the schedule.** Five `@orphan-todo AEH-239`
  annotations remain in schema.prisma, each naming the slice that wires it. The
  audit's `stale-exemption-consumed` check fails the moment a field gains a
  real consumer while still annotated, so the annotations come off on their own
  schedule rather than on memory. Two already have. Run the gate with
  `pnpm --filter @repo/audit run audit` — plain `pnpm audit` is shadowed by
  npm's vulnerability audit and tells you nothing.

### The hard requirement, and the line it draws

"I shouldn't have to come back to the code to add support for a new artifact."
An artifact TYPE is a database row, never a Prisma enum and never a switch
statement. Two things are versioned text an admin edits: the PROMPT BRIEF, and
which CORPUS SECTIONS of the estimate the model is shown. That is the whole of
what defines a type.

One rule decides every boundary question in this design:

> **Anything specific to one artifact is data. Anything shared by every
> artifact is code.**

That is what puts the shell, the prompt envelope, the corpus builders and the
(now deleted) format axis on the code side, and the brief plus the section
selection on the data side. It is also the answer to "is X a code change?" for
whatever gets asked for next.

**The prompt is a code-owned envelope wrapped around an author-owned brief.**
The envelope carries the outline JSON contract, the fragment rules (return a
fragment, never a whole document), the selector-scoping rule, the CSS token
contract and the per-section budget. The brief says what THIS artifact is and
what it must show. The author never sees or touches the envelope, so a prompt
edit cannot break the machine's contract — which matters far more now that
every type is hand-authored with no seeded example to copy.

If the envelope itself ever wants tuning, lifting it into an admin-editable
versioned singleton (the `EstimationConfig` pattern) is a small follow-up. Not
built now.

### REVERSAL — the per-type HTML template is gone, and so is `renderTemplate`

An earlier draft of this plan had the model emit JSON and a per-type HTML
template render it, to keep output small enough for the 300s ceiling. Rejected,
for a good reason: a low-fidelity wireframe's LAYOUT IS ITS CONTENT. A fixed
template can hold an ERD or a journey diagram, and cannot hold a wireframe
without turning the interesting part back into a code change. The same
objection would have come back for every visually novel artifact after it.

`ArtifactFormat` goes with it. Once there is one shared shell, every artifact
is HTML — a prose-only tranche-impact narrative is just a section that happens
to be mostly text. The ticket's "a renderer chosen by format rather than by
type" resolves to: one renderer, chosen by nothing. One less dead axis.

### The ceiling, and why it needs no new infrastructure

The requester's reference artifact (`scope-atlas-agent-intelligence-v1.html` on
AEH-235) is 100,605 bytes — roughly 25,000 output tokens. `docs/DEPLOY.md`
records the ceiling: Hobby 300s default AND maximum; Pro 300s default, 800s max
with Fluid Compute. One model call cannot reliably emit 25k tokens inside 300s.

But `api/inngest/route.ts` already states the thing that solves this: **Inngest
invokes one `step.run()` per HTTP request, so each step gets its own 300s.**
That is precisely why `runEstimate` checkpoints per agent instead of running
the pipeline as one step. Artifact generation is the same problem and takes the
same answer. No new host, no new queue, no new deploy target.

### Outline, then sections, then assemble

    step 1        OUTLINE. The type's prompt + its corpus sections produce a
                  small JSON outline: the sections to write, each with an id, a
                  title and a brief, plus a shared vocabulary (anchor ids,
                  entity names, journey ids) every later call is written
                  against. It also carries a per-section output budget, so the
                  300s is a number the model PLANS AROUND rather than one we
                  hope it clears. ~1-2k tokens, seconds.

    steps 2..N+1  SECTIONS, one step each. Each call sees the type's prompt, the
                  corpus, the full outline, and the briefs (never the HTML) of
                  the sections already written. It returns an HTML fragment —
                  markup, style and script all model-authored, so a wireframe is
                  as bespoke as it needs to be. ~3-6k tokens each, 30-90s,
                  comfortably inside one step's budget. Each fragment is
                  upserted on (artifactId, sectionId) the moment it lands, so a
                  retry never duplicates and a failure at section 5 of 9 does
                  not lose sections 1-4.

    step N+2      ASSEMBLE. Fragments concatenated into ONE generic shell shared
                  by every type — design tokens, a small utility CSS contract,
                  the tab/nav chrome derived from the outline, and the CSP meta.
                  Each fragment is wrapped in a section element carrying its id,
                  and section prompts are told to scope selectors under it, so
                  section 3's `.entity` cannot fight section 5's. The token
                  contract is a floor, not a ceiling — a section may always
                  write its own CSS.

**This scales by content, with no special cases.** An ERD or a user journey is
a one-section outline: three steps total. A wireframe pack is a nine-section
outline: eleven steps. Same machinery, no per-type anything.

**Cross-section referencing** is the reason sections run sequentially rather
than in parallel, and it is the thing the wireframe artifact actually needs:
the outline fixes the shared nouns up front, and each call is told what the
completed sections cover, so section 5 can cite an entity section 2 introduced.
Parallelising is an easy later win that costs exactly this.

### Data model

    ArtifactType         id, key (slug, unique), name, description, enabled,
                         order, createdAt
    ArtifactTypeVersion  id, artifactTypeId, version, promptBody, modelString,
                         corpusSections String[], active, changeReason,
                         changeMotivation, createdAt, createdBy
    EstimateArtifact     id, estimateId, artifactTypeId, typeVersion Int,
                         title, outline Json?, content String?, inputs Json?,
                         status RunStatus, stage, pct, error,
                         startedAt, finishedAt, createdById
    ArtifactSection      id, artifactId, sectionId, order, title, brief, html,
                         createdAt, @@unique([artifactId, sectionId])

`ArtifactTypeVersion` is `PromptVersion` with two more fields and an FK instead
of an enum id — same single-active-per-parent invariant, held by the same
`$transaction` pattern as `activateVersion`.

**A second reversal, and the reason for it.** The earlier draft said "no status
column and no Inngest", borrowing the Cartographer's reasoning that there is
nothing durable to resume. With Inngest there now IS: an artifact is a
multi-step job whose partial output survives a failed step. So it gets progress
+ terminal status, and — following the scope-map route's own warning that a
third set of progress columns on `Estimate` would be a worse trade — they live
on `EstimateArtifact`, its own row, where they belong. The UX follows: poll,
like run and ingest, not SSE like the Cartographer.

`typeVersion` is snapshotted: a delivered document must still say which prompt
produced it after the type is edited. `inputs Json?` exists from day one
because re-allocation provenance and tranche impact both need to name a saved
`ScopeScenario`, and adding that column later is the migration this ticket
abolishes. Types are archived via `enabled`, never hard-deleted — generated
artifacts are client deliverables and must keep their lineage.

One-time enum work, not per-type: `UsageKind += ARTIFACT` and
`ModelUsage.artifactId`, so spend attributes to the document that caused it.
Status reuses the existing `RunStatus`. New Inngest event `EVENT_ARTIFACT`.

### The dossier

One `buildArtifactDossier(db, estimateId)` assembling independently selectable
named sections — sow, requirements, cards, roles, rollup, graph, hiddenWork,
scenarios, narrative. A type ticks the ones it needs. Adding a TYPE touches no
code; adding a SECTION does, and that is a change to what data exists at all,
not to artifact support.

A third corpus builder after `buildOracleCorpus` and `buildScopeCorpus` needs
the reason Cartographer wrote down for diverging: Oracle's omits `MenuItem.id`,
is explicitly marked as the seam Oracle's retrieval work will change, and is a
chat corpus rather than a selectable one. The dossier is section-addressable by
construction, which neither of the others is.

### Slices

  1  Schema + admin. Migration, then `/admin/artifact-types` — list, create,
     edit-creates-a-version, version history, activate. Create mirrors
     `/admin/presets` (prompts has no create); history mirrors
     `/admin/prompts/[kind]/[version]`. Model picker reuses
     `fetchModelOptions()`. Nothing generates yet.
     Tests: single-active invariant, slug derivation and collision.

  2  Dossier + the generation pipeline. `packages/agents/src/artifacts.ts` —
     `buildArtifactDossier`, `runArtifact({ step })`. Takes an injected
     `StepRunner` exactly as `runEstimate` does
     (`deps.step ?? ((_id, fn) => fn())`), so outline then sections then
     assemble is unit-testable inline and the Inngest function stays a thin
     wrapper like `runEstimateFn`. No UI.
     Tests: section selection, unknown-section tolerance, outline validation,
     budget enforcement, fragment scoping, assembly, section upsert idempotence
     under a replayed step, usage attributed to ARTIFACT + artifactId.

  3  Generate and view. `POST /api/estimates/[id]/artifacts` enqueues
     `EVENT_ARTIFACT` and returns immediately; the Inngest function drives it;
     the client polls `EstimateArtifact.status/stage/pct` the way the run does.
     Compact "Artifacts" card in the estimate rail — count, link, generate
     picker, nothing more, because AEH-302 is already about that rail being
     overloaded. Full view at `/estimates/[id]/artifacts/[artifactId]`.
     Stub provider under `OPENROUTER_STUB` mirroring `cartographer-provider.ts`
     and answering BOTH call shapes deterministically: an outline derived from
     the corpus it was handed, and one fragment per brief.

     Also an OUTLINE-ONLY DRY RUN, and it earns its place because of the
     no-seed decision. Authoring a prompt cold is iterative, and the outline
     step is one call and a couple of thousand tokens: it answers "did my brief
     produce a sensible section plan" in seconds, for a rounding error, before
     committing to nine sections of generation. It is the difference between
     tuning a prompt in a minute and tuning it in ten. Same pipeline, stopped
     after step 1, nothing written but the outline.

  4  The authoring surface, and proof. NO SEED SCRIPT — decided 2026-09-03,
     every artifact type is hand-authored through the UI by its owner. That
     turns prompt authoring from a convenience into the product surface, so
     this slice is what makes authoring cold possible:
       - `docs/artifact-types.md` documents THE MACHINE — every corpus section
         and what it contains, what the envelope guarantees, the outline
         contract, the CSS token contract. It deliberately carries no draft
         prompt bodies: the machine is documented, the content is the owner's.
       - The type editor shows the same contract in place, so a prompt is
         written next to the list of sections it can tick rather than against
         a README in another tab.
       - Honest empty states on the admin list and the rail card. A fresh
         install has zero artifact types and must say so, and say what to do.
       - Verify end to end against a type authored through the UI in dev.
     Then `graft build`, PROGRESS.md, and the implementation record onto the
     ticket.

### Rendering safely

An iframe with `sandbox="allow-scripts"` and the document in `srcdoc`.
`allow-scripts` WITHOUT `allow-same-origin` — the pair together defeats the
sandbox, and the frame must not reach our origin, cookies or DOM. The app sets
no CSP of its own, so the assembled document carries one in a meta tag
(`default-src 'none'`; `style-src 'unsafe-inline'`; `script-src
'unsafe-inline'`; `img-src data:`), making "self-contained" enforced rather
than hoped for. A Download button, because handing the file to a client is the
entire point. A staleness chip when `artifact.createdAt <
estimate.runFinishedAt`.

### Infrastructure — settled 2026-09-03, no new host

**Vercel Pro is ruled out until further notice.** So 300s per step is a hard
floor with no headroom behind it, and the checkpointing above is not an
optimisation — it is the only thing that makes this shippable. Nothing in this
design may assume a single call can run long.

**Inngest budget is 50,000 invocations/month, 5 concurrent.** The invocation
half is a non-issue and the concurrency half is the real constraint:

    a run        ~5 fixed steps + one per requirement (run-estimate.ts:288)
                 + one per hidden-work finding → ~35-40 on a 30-requirement SOW
    an artifact  N+2 → 3 for an ERD, ~11 for a wireframe pack

So an artifact is CHEAPER per unit than a run. 100 runs + 500 artifacts a month
is roughly 8k invocations against 50k. There is no quota problem here.

Concurrency is where it bites. An Inngest run holds a slot for its whole
lifetime, including between steps, so a nine-section artifact occupies one of
five slots for the ~10 minutes it takes. Three people generating wireframe
packs at once would leave two slots for estimate runs, which are the core of
the product.

**Therefore the artifact function is capped at `concurrency: 2`** (a plain
config field on `createFunction`, confirmed present in inngest 4.5.1). Three
slots stay free for runs, ingest, promote and embed no matter how many
artifacts are queued. Artifacts wait; estimates never do.

**Prompt caching is deferred by decision, not oversight.** N+2 calls re-send
the corpus N+2 times. `ChatOptions` in `packages/providers` carries no
`cache_control` and message content is not block-structured, so this is a
providers-layer change. Agreed 2026-09-03 to wait for measured spend before
allocating effort to it. Revisit when the token bill is real.

### Traps this plan already knows about

- `content` can be 100KB and `ArtifactSection.html` several KB each. Every list
  query selects everything BUT those columns.
- Inngest step return values are stored. Steps persist to `ArtifactSection` and
  return `{ sectionId, chars }` — never the HTML itself.
- AEH-306: every existing agent prompt still asserts the preset library is the
  P01-P45 ecommerce range, which is false. The artifact prompts describe no
  library at all, so they do not inherit it.
- The e2e suite is not green on master (AEH-282), so slice 3's spec may not be
  gateable. Unit coverage carries the weight, as it did on AEH-240.
- With no seed, a spec cannot assume any artifact type exists — it has to
  create one through the admin UI first. That is an improvement, not a cost:
  the spec then tests the actual claim of this ticket (a type is addable as
  data) instead of testing a fixture somebody seeded.
- Component tests still do not exist here. Logic stays out of components.

## Recently landed: AEH-316 — the export now says what it is doing

Merged to master as `4fb3c98` and pushed to both remotes on 2026-09-03, so it
is deploying. Branch `feat/aeh-316-export-feedback` is fully contained in master
and can be deleted. Jira left In Progress on purpose — see "Still open" below.
AEH-232 is Done and merged (`91dd5f0`); the export itself already worked in
production, this was the UX around it.

Raised because the export succeeded in prod and the user could not tell. It was
a bare form with a submit button: no pending state, no result, and a throw that
became Next's generic "Application error" page — which is very likely the
bare-domain crash that was blamed on the export config during AEH-232, since
there is no `error.tsx` boundary anywhere in the app.

Done: `exportSheetsAction` returns an outcome instead of throwing; a client
`ExportSheets` component with a pending label, a transient Exported beat, and
the spreadsheet link directly under the button; the button reads "Re-export to
Sheets" once a sheet exists and states that re-exporting replaces that same
file. State derivation is in `export-interaction.ts` with 11 tests, because
component logic is unreachable by this repo's test setup.

Two things the reporter believed were broken and are not — verified live, do
not rebuild them: re-export overwrites the same sheet (found by its Drive
`appProperties` tag), and a trashed or deleted sheet is recreated with the link
updated. The genuine gap, recorded on the ticket rather than fixed: nothing
reconciles `sheetUrl`, so a sheet deleted in Drive leaves a dead link on the
page until the next export.

### Watch out for this one

`packages/db/src/preset-code.test.ts` used to rewind the shared
`preset_code_seq` in `afterAll`. That re-issues numbers a concurrently running
test already has `Preset` rows for, and it surfaces as "Unique constraint
failed on the fields: (code)" in `writeback-promote.test.ts` — a different file
entirely. It is scheduling-dependent, so it stayed hidden until this ticket
added one unrelated test file and shifted the worker layout; master passed and
the same branch failed twice, which looks exactly like a regression and is not
one. The rewind is gone and the sequence is left advanced, which
`preset-code.ts` itself documents as correct ("a gap is harmless, a reissued
code would collide"). If a preset code collision ever reappears, suspect
sequence rewinding before suspecting the allocator.

### Still open

- Everything gated green before the merge and the merged tree was byte-identical
  to the gated one: 729 unit tests over 72 files, typecheck, lint on all five
  touched files, a full production build, and the Playwright spec
  `estimate-refine.spec.ts` (which clicks this exact button and asserts the
  sheet link appears) at 2.8 minutes.
- Not done, and the reason the ticket is not closed: the stale-link
  reconciliation. Nothing reconciles `sheetUrl`, so a sheet deleted in Drive
  leaves a dead link on the page until the next export. The options differ a lot
  in cost and none is obviously right, so it is written up on AEH-316 rather than
  guessed at. Also still wanted: one export clicked through the deployed app.
- No `error.tsx` anywhere in `apps/web`, so any server action throw still takes
  the whole page down with an opaque message. Raised with the user as a
  candidate for its own ticket; deliberately not folded into AEH-316.
- AEH-317 holds the spreadsheet layout rework, with the current shape documented
  as the baseline and the target left as an explicit open question.

## Left behind by AEH-235 (Done, on master)

**Component tests do not exist in this repo.** `vitest.config.ts` is
`environment: 'node'`, the include pattern is `*.test.ts` not `*.test.tsx`, and
neither jsdom nor testing-library is installed. So logic inside a React
component can only be reached by Playwright, at ~5 min per spec file and ~13 min
for the suite. Adding jsdom plus testing-library is the real fix and is an
untaken dependency decision.

**The e2e suite is not green on master.** `estimates-create.spec.ts:17` fails
reproducibly there; `oracle.spec.ts` fails non-deterministically with a
different set each run. Recorded on AEH-282 with detail.

**The "Load bearing" chip on the estimate screen is dead** and knowingly left
alone — `PresetDependency` is empty, so `notSafelyRemovable` is false for every
card. Accepted debt, wants its own ticket. See [[preset-graph-is-empty]].

**AEH-306 (High)** — every agent prompt still asserts the preset library is the
ecommerce/B2B range P01–P45. Voiding that library made it false in all ten, and
it degrades matching silently rather than erroring. Should be scheduled ahead of
the preset wave. The bodies exist only in Neon dev/main, so it is a data change
with a runbook, not a code edit. The CARTOGRAPHER prompt deliberately does not
repeat the mistake, and neither will the artifact prompts.

**Undecided from AEH-242:** it was §2 of six. §3 (AEH-243), §3b (AEH-245), §4
(AEH-246) and §5 each still want their own migration against a preset model that
is being reshaped anyway. Landing them as one reshape may be cheaper than four
sequential ones. Raised, never settled — worth deciding before the next starts.

**AEH-235 is Done**, merged and on master at `e3abf01`; its record lives on the
ticket. The branch `feat/aeh-235-scope-configurator` is contained in master and
can be deleted.

## Databases

    local docker  ai_estimation        35 migrations
    local docker  ai_estimation_test   35 migrations
    Neon test     (ep-wild-heart)      34 migrations  <- one behind (AEH-335)
    Neon dev/main (ep-polished-credit) 35 migrations

All four went to 31 on 2026-09-03 with `20260903103535_aeh_239_artifact_types`,
applied by `prisma migrate deploy` (never `migrate dev`, which can offer to
reset). The migration is purely additive — four new tables, one nullable column
on ModelUsage, one new UsageKind value — so **every schema is now AHEAD of the
deployed code, which is fine**: nothing reads the new tables until the AEH-239
code ships, and old code cannot see a column it does not select.

Neon dev/main was row-counted before and after and came back byte-identical:
7 estimates, 188 menu items, 4242 line items, 79 presets, 34 prompt versions,
599 usage rows, and the eleven hand-tuned active prompts still totalling 54,391
characters. That last figure is the sharpest check available that nothing
reverted them — see the seeding warning further down.

One thing that is genuinely one-way: `ALTER TYPE "UsageKind" ADD VALUE
'ARTIFACT'`. Postgres cannot drop an enum value without recreating the type, so
rolling the code back leaves the value in place. Everything else is droppable.

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
