# AEH-236 — Estimate lineage: successors and branches

Plan settled by a grill-me interview on 2026-09-10. Every decision below was
made by the user during that interview; where I assumed something, it says so.

---

## What this is

Start a new estimate **with an existing estimate as its reference** instead of
from a blank SOW, then have the crew reconcile it against what changed.

Two kinds, one mechanism:

- **Successor** — the client came back with revised requirements. The parent's
  work breakdown holds; the pass changes only what the new material forces.
- **Branch** — a different stack or an alternate route to the same outcome. The
  parent's hours are an **anchor the pass may depart from**, with a reason.

The parent stays live, untouched and independently usable. Nothing is archived
or superseded.

### The shape of the feature, end to end

```
  Acme CRM — round 1  (FINALISED, 47 cards, 183 lines)
        │
        │  Fork ──▶  kind: successor
        │           title: "Acme CRM — September"
        │           steer: "client dropped reporting, added a loyalty
        │                   scheme with tiers, and now needs iOS"
        │           docs:  change-request.pdf        (optional)
        ▼
  Acme CRM — September  (DRAFT)
        │
        │   1. deep copy      47 cards, 183 lines, assumptions, narrative,
        │                     risk findings, scope scenarios — all carried,
        │                     all marked as carried
        │   2. ingest         change-request.pdf appended to the parent's SOW
        │                     under a labelled separator
        │   3. re-read        Librarian reads the combined brief
        │   4. diff           which requirements are new, changed, gone
        │   5. reconcile      per affected card, conservatively
        │   6. propose        a per-card diff you accept or reject
        ▼
  A September estimate that reads as one document, not as a June estimate
  with an appendix bolted on.
```

---

## Decisions from the interview

| # | Question | Decision |
|---|---|---|
| 1 | What a fork delivers | Copy **and** an AI reconciliation pass. Not a bare copy, not a destructive re-run. |
| 2 | Staging | **Build it whole, ship when done.** Nothing half-usable in the meantime. |
| 3 | Fork dialog | Title, kind, steering instruction, optional documents. **Same form for both kinds** — the kind changes the pass's posture, not what you're asked for. |
| 4 | SOW | **Append.** Parent's brief, then the new material, labelled. A change request only means something read against the original. |
| 5 | Conservatism | Conservative but **not frozen**. "If anything in the 47 *needs* to change, it should. It should read well." |
| 6 | Locks | Do **not** carry. A lock means a human OK'd the hours *on the estimate it sits on*. It carries only as **evidence** for the verified mark. |
| 7 | Carried marks | A **continuity rule in the left margin**. Green = carried and signed off on the parent. Taupe = carried, never checked. Absent = new in this round. |
| 8 | Subset forks | Fork takes **everything**. The pass proposes removals with a reason, so a dropped module is a recorded decision rather than a silent gap. |
| 9 | Statements | Narrative and assumptions carry across, under the same conservative rule — modified only if needed, otherwise left alone. |
| 10 | Also copied | Detective's risk findings; scope scenarios. |
| 11 | Not copied | Oracle threads, deadline, custodian, artifacts, exports, model usage, locks, lock events, edit history, reminders, uploaded files. |
| 12 | Diff grain | **Per card, with its lines shown.** Not per line — a card re-priced as a whole goes incoherent if you take half of it. |
| 13 | Rejections | **Discarded but recorded**, so "why is this still 18h when the brief changed" stays answerable. |
| 14 | Preset write-back | **Carry the parent's promotion forward.** A card already promoted from the parent points the copy at that preset, so promoting the fork *versions* it instead of creating a near-duplicate. |
| 15 | Lineage UI | All four surfaces: the fork, the parent, the dashboard, and a lineage view. |
| 16 | Dashboard | **A row is a project now.** One estimate in the family → open it directly. More than one → open the lineage view and choose. |
| 17 | Re-runs | Blocked by **children or siblings**, allowed with a parent alone. See below. |
| 18 | Linking existing estimates | A **link action** sets lineage on estimates that already exist, copying nothing. From the Supplying Demand scenario. |
| 19 | Carried marks | **Three** states, not two — the third is "carried, since amended". From the Supplying Demand scenario. |
| 20 | Pass scope | A **triage step** reads the steering prose and returns the cards in play. Not keyed to the fork kind. |
| 21 | Expansion posture | **No third posture.** Steer plus per-card rejection expresses it. Settled. |

### 17 — Re-running an estimate that is tied to another

`run-estimate.ts:484-486` deletes every `menuItem`, `roleLineItem` and
`scopeScenario` before rebuilding. Whether that is acceptable depends on what
else in the lineage is leaning on those rows.

**The rule: an estimate with children, or with siblings, cannot be re-run.
Having a parent alone does not block it.**

```
        Acme round 1  ──────────── has children      ✗ no re-run
              │
      ┌───────┴───────┐
      │               │
  September       Rails route   ──── have siblings   ✗ no re-run
      │
   Sept rev.b       ─────────── parent only, no      ✓ re-run allowed
                                siblings, no children
```

- **Children block it** because their rows' `carriedFromId` point at yours. A
  re-run deletes the rows every downstream margin mark refers to, so the whole
  family's provenance would start claiming things about rows that no longer
  exist.

- **Siblings block it** because a family of branches exists in order to be
  compared. Re-running one member rebuilds it from the SOW with no reference to
  the shared parent — it is no longer a variant of anything, and the lineage
  view would sit there comparing two things that are no longer comparable.

- **A parent alone does not block it.** Nothing depends on this estimate's rows,
  and the parent is untouched either way. The re-run does clear every carried
  mark it had — those rows are gone — leaving an estimate that records where it
  came from without claiming any of it still matches. That is accurate, and it
  is recoverable: fork the parent again.

Refused with a plain reason naming which of the two conditions applies. Want a
clean run against the same material? Fork a branch off an estimate that has no
other children and run that.

This is a deliberate holding position, not a design. Re-runs are trivial today
and are being reworked in their own work stream (AEH-367 covers the corpus half:
source documents do not survive the ingest). This ticket does not attempt that.

---

## Where this sits against other tickets

**AEH-241 — Steering input for estimates. Partly delivered, partly absorbed here,
one third still open.** A comment on it from 2026-09-08 records scope growth from
real users: it now carries three asks, not one.

*Delivered by AEH-238.* Per-requirement steering. AEH-241 proposed its own
integration point — *"a per-requirement `steeringNotes` field threaded only into
that specific requirement's specialist call would be naturally scoped"* — and
that is verbatim what shipped: `ledger-edit.ts:788` passes `steer: edit.prompt`
into `runSpecialist` for one card × role, and `specialist.ts:162` injects it into
that requirement's prompt. Its stated blocker (a review step so a person steers
an identified requirement rather than guessing at decomposition) is cleared more
completely than it asked: you steer a card you can see, with its hours in front
of you.

*Absorbed by this ticket.* Steering between runs. The fork takes an instruction
at creation, stores it as `forkPrompt` so it survives rather than being retyped,
and drives the reconciliation with it. The between-rounds case arrives as
lineage rather than as a re-run.

*Still open.* Steering a brand-new estimate before its first run. Nothing builds
it and nothing here plans it.

**Why `forkPrompt` does not repeat the mistake AEH-241 warns about.** AEH-241's
core constraint is that a steering note must not "derail or dominate the whole
estimate", and `forkPrompt` is estimate-level — exactly the shape it cautions
against. It is legitimate here for a reason that does **not** generalise to
initial steering: every change it produces surfaces as a per-card proposal a
human accepts or rejects. The check is the review, not the scoping. Initial
steering has no such review, so it cannot borrow this justification.

**AEH-367 — re-run against an updated corpus.** Adjacent, not overlapping. It is
about source documents not surviving the ingest; this is about a second estimate
that references a first. The re-run holding position above defers to it.

**AEH-237 — multi-level approval.** The ticket flagged that approvals must not be
inherited by a fork. Nothing to do: approvals do not exist yet, and `status`
resets to `DRAFT`, so a fork of an approved estimate is not approved by
construction. Worth a note on AEH-237 so it stays true when approvals land.

---

## Data model

### Lineage on `Estimate`

```prisma
enum LineageKind {
  /// The client came back with revised requirements for the same job.
  SUCCESSOR
  /// A different stack, or a different route to the same outcome.
  BRANCH
}

model Estimate {
  // ...
  /// The estimate this one was forked from. Null for an original.
  ///
  /// SetNull, not Cascade, and that is the ticket's load-bearing requirement:
  /// deleting round 1 must not destroy round 2. A child that loses its parent
  /// becomes an original — it keeps every card, line and hour it ever had.
  parentId    String?
  parent      Estimate?    @relation("EstimateLineage", fields: [parentId], references: [id], onDelete: SetNull)
  children    Estimate[]   @relation("EstimateLineage")
  /// Successor or branch. Null when parentId is null.
  lineageKind LineageKind?
  /// What the person said this fork was for, verbatim. Drives the
  /// reconciliation pass and is the only record of WHY it exists.
  forkPrompt  String?

  @@index([parentId])
}
```

### Carried-forward marks

Two new columns rather than new `LineProvenance` values, because these are a
**different axis**. `provenance` records how a number was *arrived at* (crew,
hand, steered); a carried row was arrived at one of those ways **on the parent**,
and overwriting it would lose that. Origin and lineage are orthogonal, so they
get separate columns and separate display channels.

```prisma
model RoleLineItem {
  // ...
  /// The row on the parent estimate this was copied from. PERMANENT — it is a
  /// fact about where this row came from, not a claim that it still matches.
  /// Nulling it on an edit collapsed "was in the parent's price, has since
  /// moved" into "new", which is the distinction that matters most when the
  /// parent has been quoted to a client. See scenario validation, defect 2.
  carriedFromId   String?
  /// False once anything changes the row's hours, title or existence. This is
  /// what the margin rule reads for solid versus dashed.
  carriedIntact   Boolean @default(true)
  /// True when the source row was LOCKED on the parent — a human had signed
  /// those hours off. The lock itself does not carry: a lock is a statement
  /// about the estimate it sits on. This is only the evidence it existed.
  carriedVerified Boolean @default(false)

  @@index([carriedFromId])
}

model EstimateStatement {
  // ... same two columns, same rules
  carriedFromId   String?
  carriedVerified Boolean @default(false)
}
```

Card-level and section-level state is **derived from the rows**, not stored. A
card whose rows all carry is "carried"; one with a mix is "carried, N changed";
one with no carried rows at all is new. Storing it would be a second source of
truth that goes stale the moment a row is edited.

### The reconciliation proposal

`LedgerEdit` is one envelope, one write set. A reconciliation is *many* per-card
dispositions each independently accepted or rejected, so it needs its own shape.

```prisma
enum ReconciliationStatus { QUEUED RUNNING PROPOSED APPLIED FAILED }
enum ProposalKind         { ADD MODIFY REMOVE }
enum ProposalDecision     { PENDING ACCEPTED REJECTED }

model EstimateReconciliation {
  id         String   @id @default(cuid())
  estimateId String   // the fork
  estimate   Estimate @relation(fields: [estimateId], references: [id], onDelete: Cascade)
  actorId    String
  /// The fork's steering instruction, copied here so the record is self-contained.
  prompt     String
  /// SUCCESSOR holds tight; BRANCH treats the parent's hours as an anchor.
  posture    LineageKind
  status     ReconciliationStatus @default(QUEUED)
  stage      String?
  pct        Int      @default(0)
  error      String?
  /// The pass's own account of what it did and why. The evidence for the numbers.
  reasoning  String?
  /// max(updatedAt) across the fork when the pass started, compared before the
  /// write. Same concurrency rule LedgerEdit already uses.
  fingerprint DateTime?
  proposals  ReconciliationProposal[]
  createdAt  DateTime @default(now())
  appliedAt  DateTime?

  @@index([estimateId, createdAt])
}

model ReconciliationProposal {
  id               String   @id @default(cuid())
  reconciliationId String
  reconciliation   EstimateReconciliation @relation(fields: [reconciliationId], references: [id], onDelete: Cascade)
  /// The card this is about. Null for ADD — the card does not exist yet.
  menuItemId       String?
  /// The cards this proposal replaces, when it subsumes several. A stack change
  /// collapses three custom cards into one plugin-configuration card; without
  /// this the review shows three unexplained removals and an unexplained
  /// addition — four decisions where there is one. See defect 4.
  supersedesMenuItemIds String[]
  kind             ProposalKind
  /// The card's title, so a REMOVE still reads properly after the card is gone.
  title            String
  /// Why the pass proposes this, in its own words. Survives a rejection —
  /// this is the half of the record that cannot be reconstructed.
  rationale        String
  /// The proposed rows. Never selected by default: same rule as LedgerEdit's
  /// snapshots, for the same reason.
  payload          Json
  decision         ProposalDecision @default(PENDING)
  decidedAt        DateTime?
  decidedById      String?

  @@index([reconciliationId, decision])
}
```

---

## The fork operation

`apps/web/src/app/estimates/[id]/fork-actions.ts`

### Refusals, returned not thrown

A thrown refusal becomes React boilerplate once deployed, and e2e runs
`next dev` so it cannot catch it. Every refusal is a typed return value.

- parent `runStatus === 'RUNNING'` → refuse; a mid-run copy gets half a ledger
- parent `ingestStatus === 'RUNNING'` → refuse; the SOW is still being written
- no title → refuse

### The copy itself

**Not a nested create in a `.map()`, and not a per-row loop.** O(rows) round
trips inside a transaction blow Prisma's 5s default against Neon and never
locally — 183 line items is exactly the size that passes on a laptop and fails
on the deploy.

```
  1. read the parent graph            ~6 queries, no N+1
  2. generate cuids up front          so sectionId, dependentId, prerequisiteId
                                      and menuItemId can all be remapped before
                                      a single row is written
  3. estimate.create                  the shell only
  4. createMany × 8                   sections, menuItems, roleLineItems,
                                      menuItemDependencies, estimateStatements,
                                      hiddenWorkFindings, scopeScenarios,
                                      scopeScenarioPicks
  5. all inside one $transaction      with an explicitly raised timeout
```

Assert the query **count** in a test, not just the result — that is the only
thing that catches a regression back to per-row writes.

**Four foreign keys have to be remapped through the id maps, not copied.** Miss
one and the fork silently points at the parent's rows:

| Table | Column | Remap through |
|---|---|---|
| `MenuItem` | `sectionId` | the section map |
| `MenuItemDependency` | `dependentId`, `prerequisiteId` | the card map |
| `ScopeScenarioPick` | `scenarioId`, `menuItemId` | the scenario and card maps |
| `HiddenWorkFinding` | **`menuItemId`** | the card map |

`HiddenWorkFinding.menuItemId` is the easy one to miss — it is nullable, set
only on a costed finding (`run-estimate.ts:516`), so a fork that skipped it
would look correct on any estimate whose findings were all still OPEN.

Two more on findings: `riskFlag` copies **verbatim** (the `@@unique([estimateId,
riskFlag])` cannot collide — the fork has a new `estimateId`), and `outcome`
copies as-is rather than resetting to OPEN. A risk somebody dismissed with a
reason on the parent was dismissed on its merits, and making them re-answer it
would be the finalise gate nagging about a decision already taken.

`ScopeScenario.createdById` is a required Cascade FK to `User`. It takes **the
person who forked**, not the parent's author — they are the one who now owns
these scenarios, and pointing at the original author would cascade-delete the
fork's scenarios if that person were ever removed.

### What the shell carries

| Column | Value | Why |
|---|---|---|
| `title` | from the dialog | |
| `sowText` | parent's, verbatim | new material appends to it |
| `status` | `DRAFT` | a copy of an approved estimate is not itself approved |
| `configVersion` | **copied** | the copied `taxedHours` were computed under exactly this config |
| `pmCommunicationTaxPctOverride` and the other two | **copied** | copying the hours without the rates that produced them makes the numbers lie |
| `overheadRatesStale` | copied | |
| `complexityScore` | copied, recomputed by the pass | |
| `agentState` | copied | `librarianOutput` is what the Oracle and the edit engine read; the pass replaces it |
| `ownerId` | whoever forked | |
| `custodianId`, `dueAt` | **null** | a new round is a new deadline |
| run / ingest fields | reset | |

### Carried marks, set at copy time

For every copied line item: `carriedFromId = <source row id>`, and
`carriedVerified = true` iff a `LedgerLock` existed on the source row. Same for
statements against `StatementLock`.

`carriedIntact` is set false by **every** write path that changes a row —
`updateLineItem`, the ledger-edit applier, the reconciliation applier.
`carriedFromId` is never cleared. Miss a write path and the margin rule starts
claiming a row still matches its parent when it does not; grep every
`roleLineItem.update` and `roleLineItem.updateMany` after writing this.

### Preset write-back, at copy time

For each copied card, look for a `PresetVersion` with
`sourceEstimateId = <parent>` and `sourceMenuItemId = <source card>`. If there
is one, set the copy's `sourcePresetId` to that preset and `matchScore` to 1.0.

`promoteMenuItemsToPresets` then takes its existing strong-match path
(`writeback.ts:137`, threshold 0.75) and writes **a new version of that preset**
rather than creating a near-duplicate. No new table, no new rule — it reuses
machinery that is already there and already tested.

Only overwrite `sourcePresetId` when a promotion actually exists; otherwise
leave the parent's Archivist match alone.

**Known limit: the rule is order-dependent.** It reads the promotion state *at
copy time*, so if the fork is finalised before the parent ever was, no
`PresetVersion` exists to point at and both estimates promote independently —
the near-duplicate the ticket warned about. This is the accepted cost of a rule
that needs no new table and no designated-writer flag. The common case is
forking from delivered work, where the parent was promoted first. If duplicates
show up in practice, the fix is a lineage-aware dedupe at promotion time rather
than a change here.

---

## The reconciliation pass

`packages/agents/src/reconcile.ts`, dispatched as an Inngest function.

### What triggers it, and what you see while it runs

**A button, not an automatic dispatch.** The fork lands as a normal DRAFT with
its copied ledger fully readable, and a rail action says *Reconcile against the
new brief*. Two reasons it is not automatic: the ingest of the attached
documents finishes asynchronously, so an auto-dispatch would race it; and a
person who forked to hand-edit should never have a model rewrite their estimate
because they attached a file.

The button is disabled with a reason while `ingestStatus === 'RUNNING'`.

**Progress has nowhere to live today.** `RunControls` reads `estimate.runStatus`,
and a reconciliation is not a run — its status is on `EstimateReconciliation`.
So the fork page polls the reconciliation the way `RunControls` polls the run:
a new `/api/estimates/[id]/reconcile/status` route and a strip in the same
vocabulary as the Run Crew strip, naming the stages it actually goes through
(re-reading the brief → matching requirements → re-pricing N cards → writing
the proposal). Reusing `runStatus` would be wrong: an estimate can legitimately
have never run *and* be reconciling.

### Inputs

- the fork's whole ledger — every card, line and statement
- the fork's `sowText` — parent's brief **plus** the new material
- the parent's requirements, from the copied `agentState.librarianOutput`
- the fork's steering instruction (`forkPrompt`)
- the posture, from `lineageKind`

### The requirement-id problem

Copied `HiddenWorkFinding` rows carry a `requirementId` that keys into
`agentState.librarianOutput`. The pass re-reads the brief and produces a **new**
requirement set — and Librarian ids are regenerated per run, so every carried
finding would point at a requirement that no longer exists.

The fix falls out of work the pass has to do anyway: `diff-requirements` already
matches the parent's requirements against the new ones, so it emits that mapping
and the applier re-keys each carried finding to its matched new requirement. A
finding whose requirement has **gone** from the brief is not deleted — it is
left pointing at nothing and surfaced in the review as *"this risk was raised
against a requirement the new brief drops"*, which is a thing a human should
see rather than a row to quietly sweep up.

`agentState` keeps **both** sets: `librarianOutput` becomes the new one (what
every existing reader expects), and the parent's is retained alongside it as the
anchor the diff and the branch posture both need.

### Stages, each an Inngest step

The 300s ceiling is per step, and both existing pipelines already checkpoint
per-unit (`run-estimate.ts:307` per requirement, `ledger-edit.ts:781` per
card×role). This does the same, so no stage can outgrow the ceiling.

```
  librarian              re-read the combined brief → requirements
  diff-requirements      new / changed / gone, against the parent's set
                         ── the hard step; see below ──
  triage                 read the steer + the diff + the ledger context and
                         return the cards in play. THE ONLY thing that decides
                         the pass's scope — a diff-driven loop alone is empty on
                         a stack change, whose brief never changed. See defect 3.
  reconcile:<cardId>     one step per card triage selected
  reprice:<cardId>:<role>  the specialist council, per affected card × role
  statements             narrative + assumptions, conservatively
  propose                write EstimateReconciliation + its proposals
```

Nothing writes to the ledger. The pass **only** produces proposals.

**`diff-requirements` is the step that will need iteration.** Librarian ids are
regenerated on every read, so "new / changed / gone" cannot be an id comparison —
it is semantic matching between two requirement sets, which is Archivist-shaped
work (the Archivist already matches requirements against preset descriptions,
and the same embedding-plus-judgement approach applies). Budget for prompt
iteration here specifically: everything downstream inherits its mistakes, and
its characteristic failure is quiet — a requirement matched to the wrong
predecessor produces a plausible re-pricing of the wrong card.

### The two postures

Same pipeline, different instruction to the council.

**SUCCESSOR** — the parent's breakdown is the working assumption. A card is
touched only where the new material forces it, and the pass must say what forced
it. Untouched is the default and needs no justification; a change does.

**BRANCH** — the parent's hours are an anchor, not a target. The pass re-conceives
the work against the steering instruction and may depart wherever departing is
right, but every departure carries a reason and the anchor is shown beside it.

Both are held to the same bar the user set: **the result must read well.** New
cards land in the section they belong to, not appended at the end; assumptions
that contradict the new brief get rewritten rather than left to contradict it.

### What the pass may do that the existing engine cannot

The steered-edit engine conserves lines — the Curator prompt ends *"Every one of
the N lines above must appear exactly once across your cards"* (`curator.ts:124`).
It partitions and re-prices; it cannot invent work.

The reconciliation pass must **add** cards for genuinely new requirements and
**remove** cards the brief dropped. That is the new capability, and it is why
this is a new agent path rather than a fifth `LedgerEditMode`.

---

## The review

`apps/web/src/app/estimates/[id]/ReconciliationReview.tsx`

One decision per card, its lines shown but not individually tickable:

```
┌ PROPOSED — 47 cards, 12 changed ────────────────────────┐
│                                                         │
│  Refund flow                              [ ✓ accept ]  │
│    iOS refunds need a native sheet                      │
│    DEV   18h → 26h                                      │
│    QA     6h →  9h                                      │
│                                                         │
│  Reporting dashboard                      [ ✓ accept ]  │
│    Dropped in the September brief                       │
│    remove card                    − 60h                 │
│                                                         │
│  Loyalty tiers                            [ ✓ accept ]  │
│    New requirement R-52                                 │
│    DEV 24h   QA 8h   PM 4h              (new)           │
│                                                         │
│              [ Accept 12 ]        [ Reject all ]        │
└─────────────────────────────────────────────────────────┘
```

**Applying** writes accepted proposals in one transaction, clears
`carriedFromId` on every row it touches, and records the whole thing as a
`LedgerEdit` so it lands in the existing Steered edits panel with its snapshots
and its revert.

**Rejecting** sets `decision = REJECTED` and writes nothing to the ledger. The
proposal and its rationale stay readable in the edit history — that was the
explicit ask: the reasoning survives even when the number does not move.

**Concurrency.** `fingerprint` is compared before the write, the same rule
`LedgerEdit` already uses. Estimates are edited live; a pass that ran for four
minutes cannot assume the ledger stood still.

---

## UI surfaces

### The margin rule — the signature element

A 3px rule in the left margin of each line item row. Costs no horizontal space
and no words, which is the point: the row already carries eleven things
(BE/FE, description, envelope tag, lock badge, lock button, provenance word,
delete, base hours, buffer hint, taxed hours) and a twelfth was the wrong move.

```
  ┃  BE FE  Build the SSO handshake      40   +20% →   48
  ┃  BE FE  Token refresh + rotation     16   +20% →   19
  ┃  BE FE  Session store                12   +20% →   14
  │  BE FE  Stripe integration           32   +20% →   38
  │  BE FE  Refund flow                  18   +20% →   22
     BE FE  Tier calculation             24   +20% →   29
     BE FE  Tier expiry job              10   +20% →   12
  │  BE FE  Data migration               25   +20% →   30

  ┃  green  (accent)     carried, signed off on the parent
  │  taupe  (line-soft)  carried, never checked
     none                new in this round
```

Read down the left edge and you see the shape of the change without reading a
word: where the rule runs unbroken this round matches the last, where it breaks
new work entered. The full sentence — which estimate, which row, whether it was
locked there — is on hover.

**When the parent has been deleted** its rows cascade away, but `carriedFromId`
is a plain column and keeps its value. The rule stays honest — the row *was*
carried, and that is still true — so it still draws, and the hover degrades to
*"carried from an estimate that has since been deleted"* rather than failing to
resolve. The claim the mark makes is about this row's history, not about a
document that still has to exist.

Uses existing Warm Ledger tokens (`green`, `line-soft`). No new palette.

### Lineage, on four surfaces

**On the fork** — under the title: `Successor to Acme CRM — round 1 ↗`

**On the parent** — a rail block listing what came out of it, so opening round 1
tells you round 2 exists before you quote a superseded number.

**On the dashboard** — a row is a **project**. One estimate in the family opens
it directly; more than one opens the lineage view.

```
  Acme CRM                    3 estimates    → lineage
  Brightwell portal               DRAFT      → the estimate
  Halden migration            FINALISED      → the estimate
```

Grouping is computed in memory by walking `parentId` — the dashboard already
loads every estimate with no pagination, and a denormalised `rootId` column
would go stale the moment a `SetNull` fires.

**The lineage view** — `apps/web/src/app/estimates/[id]/lineage/page.tsx`. The
family and what differs: totals side by side, which cards each has, so choosing
which version to send a client is a comparison rather than two tabs.


---

## Validation against two real scenarios

Walked through on 2026-09-10 against the two client situations that prompted the
ticket. Five defects found; all five are folded into the sections above.

### Supplying Demand — an expansion of an existing scope

Two standalone estimates already on the platform: WordPress (complicated
architecture) and Shopware. The client now wants the **Shopware** scope expanded
with further system components, and the existing hours are the committed basis.

Fork Shopware as a SUCCESSOR, attach the new scope documents, steer that this is
an expansion. The copy supplies the basis, the margin rule separates what was
already quoted from what the expansion adds, and the per-card review means no
existing card moves without somebody accepting it. That much works as designed.

**Defect 1 — lineage can only be created by forking.** WordPress and Shopware
are alternates of each other, which is a BRANCH by this plan's own definition,
but they already exist and nothing can say so. The dashboard would show two
unrelated projects with the same client name, then a third.

*Fix:* a **link-to-existing action** setting `parentId` and `lineageKind` on an
estimate that already exists, copying nothing. No carried marks result, and that
is honest — Shopware was not derived from WordPress, it is a parallel take.
Belongs in build stage 4 with the lineage UI.

**Defect 2 — "was quoted, and has since moved" is unsayable.** Clearing
`carriedFromId` on any edit collapses an amended carried row into looking new.
Against a baseline that has been priced to a client, that is the distinction
that matters most.

*Fix:* `carriedFromId` becomes permanent — it is a fact about where a row came
from, not a claim that it still matches — and a new `carriedIntact Boolean`
carries the equality. Three margin states, not two:

```
  ┃  solid green    carried, untouched, signed off on the parent
  │  solid taupe    carried, untouched, never checked
  ┆  dashed         carried, since amended — was in the parent's price
     none           new in this round
```

**Settled — "expansion" is not a third posture.** The requirement was phrased as
the earlier hours being *required* as the basis, which is stronger than
SUCCESSOR's "minimize impact". Confirmed on 2026-09-10: no third posture. The
steering instruction plus a per-card rejection express it, and a frozen mode was
explicitly rejected during the interview.

### AIS — a reduced scope, then a stack change

Original: full custom build on NestJS/NextJS with integrative AI work and admin
automations. Then a reduced scope, **estimated off-platform**. Then a stack
change to WordPress with plugins.

The off-platform reduced-scope estimate does **not** come into the platform as a
lineage node. It arrives as **presets** — its work items are promoted into the
library and reach a future estimate through Archivist matching. An import path
for off-platform estimates is therefore out of scope here, and an earlier draft
of this section proposing it be attached as a source document has been dropped.

What this ticket covers for AIS is the stack change itself, forked from what is
already on the platform:

```
  AIS — full scope
  └── AIS — WordPress    branch      (stack change)
```

**Defect 3 — a branch with no new documents is a no-op.** The pipeline was driven
by the requirement diff. A stack change carries **the same brief** — what the
system must do is unchanged, only how changes — so `diff-requirements` returns
nothing new and nothing gone, the per-requirement loop is empty, and the pass
proposes nothing while reporting success.

Note precisely what fails: **control flow, not signal.** A steer reading
"changing stack from Shopware to Shopify" is entirely sufficient for the council
to know what to do. It is never read, because `for (const req of changed)` over
an empty array makes no model call at all.

*Fix — a triage step, not a posture-keyed loop.* The first draft made BRANCH
iterate every card unconditionally. That is wasteful and wrong-headed: not every
branch is a platform change, and "swap the payment provider to Stripe" is a
branch that touches three cards. Instead, one cheap call reads the steer, the
requirement diff and the compact ledger context `renderLedgerContext` already
builds, and returns the cards in play.

```
  "changing stack from Shopware to Shopify"   →  every card
  "swap the payment provider to Stripe"       →  the 3 payment cards
  a successor with new documents              →  the diff, widened by the steer
```

This unifies both postures rather than hard-coding iteration to the kind, and it
is what makes the steering prose load-bearing instead of decorative. Bias toward
inclusion on a BRANCH: an over-wide envelope costs model calls, an under-wide one
silently leaves the estimate half-converted. What triage selected is shown in the
review, so a wrong call is visible and the pass can be re-run with a sharper
steer.

Cost follows honestly at the top end: a whole-platform branch is a full
re-estimate's worth of calls, because a stack change *is* a re-estimate — one
that keeps the copy as its starting point and produces a reviewable diff instead
of deleting everything.

**Defect 4 — the proposal shape cannot express a collapse.** WordPress with
plugins does not re-price the NestJS cards, it dissolves them: custom auth,
custom admin workflows and the API layer become one "configure and extend
WooCommerce" card, while plugin evaluation, licensing, theme work and hardening
appear with no predecessor. As written that is three unexplained REMOVEs and one
unexplained ADD — correct in the ledger, incoherent in the review, and four
decisions where there is really one.

*Fix:* `supersedesMenuItemIds String[]` on `ReconciliationProposal`, so a
collapse is one reviewable decision naming what it replaces. The Curator already
holds this idea from the other direction — `reuseMenuItemId`, where a split keeps
one real card.

**Defect 5 — the parent is a reference corpus, not an hour-anchor.** "The
parent's hours are an anchor it may depart from" gives the council almost nothing
when nearly every hour departs. WordPress with plugins may well dissolve every
single card in a NextJS estimate — and the parent is *still* worth reading, for
three reasons that survive a total rebuild:

- **the card descriptions carry domain detail the brief never states.** What the
  admin workflow actually does, which reports matter, what the AI work touches.
  That knowledge is platform-independent and it is recorded nowhere else.
- **integrations often survive a stack change outright.** A third-party shipping
  API or a payments processor is the same integration whoever hosts it.
- **the original sizing calibrates** how big this team judged the work to be,
  which is a better prior than none even when delivery changes completely.

*Fix:* the requirement is binding; the parent's hours are context, never a
target; and the prompt says which is which.

**And the pass must classify survivors rather than sweeping them into the
rebuild.** An integration present in both scopes is either genuinely untouched
(same API, same auth model) or quietly impacted (different platform SDK,
different webhook surface) — different answers, and a human needs to see which.
That is exactly what the intact/amended split from defect 2 records:

```
  survives untouched    no proposal    carriedIntact stays true   → solid rule
  survives, impacted    MODIFY         carriedIntact false        → dashed rule
  dissolved into another card          named in supersedesMenuItemIds
  gone entirely         REMOVE
  no predecessor        ADD                                       → no rule
```

One display consequence. On a branch where 44 of 47 cards change, the 3 that
carry through untouched are **significant news**, and a card with no proposal
would say nothing at all. The review states survivors affirmatively — "3 cards
carry through unchanged" — rather than leaving them as silence.

---

## Build order

Sequential — each stage is a prerequisite for the next. Nothing is usable until
the last one lands; that was the explicit choice.

1. **Schema + migration.** Additive nullable columns and two new tables only.
2. **The fork operation.** Copy, marks, preset carry-forward, refusals. Tested
   at production size — 47 cards, 183 lines, ~190 assumptions.
3. **The margin rule + lineage on the fork and parent.** The copy becomes
   legible before anything AI touches it.
4. **Dashboard as projects + the lineage view + the link-to-existing action.**
5. **The reconciliation pass.** New agent path, both postures, checkpointed.
6. **The review UI + the applier.**
7. **Disable the destructive Run on a fork.**

---

## Traps this has to clear

Every one of these has bitten this repo before.

- **`next build` is the only real check.** Typecheck, lint and tests all pass on
  code that cannot build.
- **Per-row loops in a transaction** blow Prisma's 5s default against Neon and
  never locally. Assert query count; test at production size.
- **Prisma nested create in a `.map()`** passes `tsc` with a stale field name and
  fails at runtime. Grep after every rename.
- **Migration blast radius, both directions.** Dev/main is shared Neon. A pending
  migration breaks pages that merely JOIN a new table; a DROP applied before the
  code ships takes the live platform down. Additive nullable only, and pass
  `DATABASE_URL` explicitly — `packages/db/.env` points at real data.
- **Never derive a shadow database URL** from a real one. Prisma drops it.
- **Server action throws are redacted in prod.** Return typed refusals.
- **Estimates are edited live.** Snapshot in one transaction; compare the
  fingerprint before writing.
- **The repo is not prettier-clean.** Hand-format; compare `git diff -w --stat`.
- **Stale `dist` shadows source.** `tsc -b`, not bare `tsc --noEmit`.
- **Branch from `origin/master`.** The current branch is one commit behind it.

## Test plan

- fork at production size, asserting **query count** as well as result
- fork of a fork — lineage two deep
- delete the parent; the child keeps every card, line and hour
- a locked parent row → `carriedVerified` true, and **no lock** on the fork
- edit a carried row → `carriedFromId` clears → the margin rule drops
- promote a fork whose parent was promoted → **a version**, not a duplicate
- refuse to fork mid-run and mid-ingest
- re-run refusals: blocked with children, blocked with siblings, **allowed** with
  a parent alone — and that allowed re-run clears the fork's carried marks
- a costed risk finding's `menuItemId` lands on the fork's own card, not the
  parent's
- a carried finding is re-keyed to its matched new requirement after the pass
- reconciliation adds, modifies and removes; rejections write nothing but stay
  readable
- **a branch with no new documents proposes something** — the AIS stack-change
  case, and the one that fails silently if triage is missed
- triage narrows: a "swap the payment provider" steer selects the payment cards,
  not all 47
- an integration surviving a stack change untouched keeps its solid rule, and the
  review says so affirmatively rather than staying silent
- a collapse proposal supersedes several cards and reads as ONE decision
- an amended carried row draws the dashed rule, not "new"
- link two existing estimates; the family reads correctly and no marks appear
- e2e: fork, reconcile, accept some and reject some, then edit **both** estimates
  independently and confirm neither moves the other
