# WORKLOG — open feature backlog

> **Last groomed 2026-08-20.** This file holds **open work only**. Resolved and
> superseded entries were moved to PROGRESS.md ("Resolved WORKLOG entries —
> original analysis") with their full write-ups intact, because several of them
> diagnosed real bugs the implementation then confirmed, and one records a
> decision that went the *other* way to the request.
>
> Anything you find here is not done.

## Sequencing (agreed 2026-08-20)

Not a strict order — but this is the reasoning, so nobody has to reconstruct it.
Full prioritisation is being done separately.

**Do first — these protect everything after them, and they're cheap:**
1. **Round-trip test** (WBS → promote → retrieve → assert). Would have caught the
   1.4× inflation on day one. See *Never let the WBS and the preset library
   drift apart again*.
2. **Shared costed-work type — FOCUSED.** Kills the twelve-files-per-field
   mechanism that produces drift.
3. **No orphaned backend work** — orphan-field audit + zero-caller check. Every
   failure this backlog records was *silent*; this is the general fix.

**Then, whichever is more urgent commercially:**
- **Dependency edges** (in *Preset model rework* §2) — the hard prerequisite for
  the configurable-estimate menu card. Do this if presales is the priority.
- **The comparison-delta fix** (§3) — the item most likely to improve estimate
  quality on its own, and a plausible contributor to the calibration gap. Do this
  if accuracy is the priority.

**Deliberately deferred:** *Shared costed-work type — FULL*. It should be
answered by the preset rework, not decided ahead of it.

## Index

**Open — infrastructure / correctness**
- Never let the WBS and the preset library drift apart again
- Shared costed-work type — FOCUSED
- Shared costed-work type — FULL unification *(deferred)*
- No orphaned backend work
- Detective's spike-preset range is hardcoded
- `nonDev` in supervisor-gates includes DEV
- Fix the Google Sheets export *(never run live)*
- Review and revise the agent prompts *(live prompts have drifted from the repo)*

**Open — product**
- Configurable estimate — a menu card the client picks from
- Estimate lineage — successors and branches
- Multi-level approval on estimates
- AI-assisted WBS editing
- Artifact generation alongside the WBS *(ERD / user flow / wireframes, UI-extensible)*
- Custodian on estimates, with deadlines and reminders
- Preset model rework
- Steering input for estimates

**Elsewhere**
- Resolved + superseded entries, and the "seeded 45 keep their ids" decision →
  **PROGRESS.md**, "Resolved WORKLOG entries".

---

## Steering input for estimates (requested 2026-07-08)

**What:** Let the user supply "steering" guidance on an estimate — specific
instructions on how to plan/execute a particular requirement — instead of
leaving every execution decision entirely up to the LLM. Example: telling the
system "use the existing auth service, don't build a new one" or "this
integration should be a thin polling adapter, not a real-time webhook" for
one specific requirement within a larger BRD.

**Why:** Right now the agents (Librarian → Specialists → Architect) infer
approach entirely from the SOW/BRD text. When the estimator already knows a
constraint or preference the document doesn't state explicitly, there's no
way to feed that in — the only lever is editing the source document itself,
which is often not desirable (the BRD is the client's document, not scratch
space for internal planning notes).

**Key design constraint (explicitly flagged by the requester):** steering
must be scoped and tactful — it must not "derail" or dominate the whole
estimate. A steering note aimed at one requirement should not bleed into how
unrelated requirements are planned. This is the same class of failure this
codebase already hit once: see the estimate-quality-prompt-code-drift memory
and PROGRESS.md's "generalize classification vocabulary" work, where a
strong global signal (the ecommerce preset library baked into every prompt)
skewed classification for everything, not just the cases it legitimately
applied to. Steering input needs to avoid repeating that mistake — it should
be a targeted, bounded signal, not a global system-prompt addition.

**Possible integration point (not committed to, just a starting thought):**
the pipeline already calls SPECIALIST_DEV/QA/PM/BA once per requirement
(`packages/agents/src/specialist.ts` → `buildUserMessage`), so a
per-requirement `steeringNotes` field threaded only into that specific
requirement's specialist call would be naturally scoped — it wouldn't touch
the prompt/context for any other requirement. This would likely mean:
- A new optional field on `Requirement` (`packages/shared/src/schemas.ts`)
  and the corresponding DB column.
- A UI surface for the user to attach steering text to a requirement, most
  naturally after the Librarian has decomposed the SOW (so the user is
  steering an actual identified requirement, not guessing at decomposition
  in advance) — likely a review step between Librarian and the rest of the
  pipeline, which doesn't fully exist yet (today the pipeline runs straight
  through Librarian → Specialists with no pause for human input).
- Explicit instruction to the Specialist prompt that steering is a
  constraint on ONE requirement's execution approach, not a signal about the
  rest of the project — i.e. avoid the same over-generalization failure mode
  as the closed-vocabulary bug.

**Status:** NOT STARTED — the one open item in this file. Still needs the
Librarian-review pause step that doesn't exist yet; see the design risk above.

---


---


---


---


---

# Carried over from the 2026-08-07 session

Three known-but-unfixed things, recorded so they don't die with the entries that
raised them.

## Detective's spike-preset range is hardcoded (found 2026-08-07)

`packages/agents/src/detective.ts:102` shows the model this JSON contract:

```
"spikePresetId": "P01".."P06" | omit
```

A literal range in a prompt string. Nothing validates that P01–P06 *are* the
spike presets — PROGRESS.md has flagged that mapping as never cross-checked
since 2026-07-08 — and it silently rots the moment the library is re-imported or
a spike preset is added. `PresetVersion.spikeNeeded` already exists and is the
real source of truth, so this should be derived (query the spike presets, list
their codes in the prompt) rather than written by hand.

Related: `packages/shared/src/schemas.ts:199` repeats the range in a doc comment,
and six live DB prompts name "P01–P45" in prose. The prose is descriptive and
harmless; this one is functional.

**Status:** not started.


## `nonDev` in supervisor-gates includes DEV (found 2026-07-17, still unfixed)

`packages/agents/src/supervisor-gates.ts`:

```ts
const nonDev = totalsByRole.DEV + totalsByRole.QA + totalsByRole.BA;
```

The name says non-DEV; the arithmetic includes DEV. The *behaviour* is correct —
the warning text says "% of DEV+QA+BA" and the ratio below recomputes the same
sum inline, so nothing is miscalculated. It's a misnomer plus a duplicated
expression, and it reads as a bug every time someone opens the file. Worth
renaming to `pmDenominator` and using the variable in the ratio.

**Status:** not started. Cosmetic, but it's cost reading time twice already.

---

# Requested 2026-08-20

Nine new items. Grounding below is real where it's stated as fact; anything that
still needs a decision says so rather than guessing.

## Review and revise the agent prompts

**What:** a proper pass over all 9 agent prompts.

**Why now, with evidence:**
- **The live prompts have drifted from the repo.** Active versions in Neon are
  v3/v4, and strings that exist in the DB (e.g. "Anchor preset IDs (P01–P45)…")
  appear **nowhere** in `packages/db/src/seed-prompts.ts` or
  `scripts/prompts-export.json`. So the prompts actually running are not the
  prompts in version control. Re-seeding would silently revert them.
- **A known drift bug**: PROGRESS.md records the live SPECIALIST_DEV body still
  asking for `{baseHours, rationale, assumptions}` — a shape `specialist.ts` no
  longer parses. It only works because the real contract rides in the user
  message.
- **The calibration gap.** QA/PM/BA have been out of the proportionality band on
  *every* live run so far (BA 52–95% of DEV, PM 30–44%), and `sow-simple`
  produced ~160–190h for a ~30–60h job. PROGRESS.md attributes this to prompt
  adherence, not a code bug — so this is the item that would actually fix it.
- Prompts are DB-versioned (`Prompt`/`PromptVersion`) and editable at
  `/admin/prompts`, so revising them needs no deploy. **But** there is no way to
  export the live set back into the repo, which is why they drifted. Worth
  fixing as part of this.

**Status:** not started.

## Multi-level approval on estimates

**What:** a sequential approval chain of named roles — e.g. estimator submits →
lead approves → director signs off — each step recorded with who and when, and
the estimate locked at the end.

**Current state:** `Estimate.status` is a flat `DRAFT | REVIEW | FINALISED`, and
`finaliseAction` flips it with no record of who did it. `Role` is only
`ADMIN | ESTIMATOR`, so there is no "lead" or "director" to approve as — the
role model has to grow first, or approval steps reference users directly.

**Shape of the work:** an ordered approval-step table (estimate, step index, role
or user, decision, actor, timestamp, comment), a configurable chain definition
(so the sequence isn't hardcoded), and a guard making FINALISED reachable only
when every step has passed. Note `deleteEstimate` and the editing actions already
refuse to touch a FINALISED estimate, so the lock has somewhere to hook.

**Status:** not started.

## AI-assisted WBS editing

**What:** everything to do with revising the menu card with the model's help, not
just regenerating it. Specifically requested:
- natural-language revision ("make QA lighter", "assume auth already exists")
- re-run part of it — one card, one role — in place, keeping the rest
- explain and challenge a number, without editing
- **structural edits**: add a section the crew missed, restructure a section,
  split one into several, merge several into one
- revise hours, revise descriptions

**Current state:** the run is all-or-nothing. `runEstimate` regenerates the whole
menu card and `run-estimate.ts` deletes and recreates every `RoleLineItem` in a
transaction, so there is no way to touch part of an estimate with the model.
Manual editing exists and is good (inline titles, hours, sections, drag-and-drop
via `MenuCardEditor` + `ledger-context`) — this item is about giving the model the
same reach a human already has.

**The hard part** isn't the prompting, it's scoping: the pipeline is
requirement-driven (Librarian → Specialists → Architect), so "re-do this one
card" needs a way to run a slice of it against existing state rather than from
the SOW. `SupervisorInput` already has `mode: 'full' | 'refine'` and
`changedMenuItemIds` — declared but never used. That's the intended seam.

**Status:** not started. Biggest item in this file.

## Estimate lineage — successors and branches (clarified 2026-08-20)

**One feature, not two.** Versioning and branching are the same idea: start a new
estimate *with an existing estimate as its reference*, instead of from a blank
SOW. An estimate is either a **successor** of another (the client came back with
revised requirements) or a **branch** of it (explore a different scope, outcome,
or subset in parallel).

**The load-bearing requirement:** the earlier estimate stays valid. It is still
good as a set of work items — just not for this client, or not for this round.
Both remain live and independently usable; nothing is archived or superseded.

That rules out the pattern used everywhere else in this system.
`PresetVersion`/`PromptVersion`/`EstimationConfig` are single-active + immutable
history, which assumes one current truth. Here there is no single truth — two
estimates from one ancestor are both current. So this is a **lineage graph**, not
a version chain: a parent pointer, a relationship kind (SUCCESSOR | BRANCH), and
a deep copy of sections/menu items/line items at fork time.

Typical deltas the fork has to survive, per the request: a complete system
overhaul, a smaller subset of requirements, a few extra modules, or a different
business outcome. So the copy must be fully editable afterwards with no link back
to the parent's numbers — reference means provenance, not inheritance.

**Current state:** nothing. `Estimate` has no parent pointer and nothing
references an estimate from another estimate.

**Two things that need deciding:**
- **Approvals must not be inherited** by a fork (see the approval entry) — a copy
  of an approved estimate is not itself approved.
- **Preset write-back.** Promotion is keyed on `(sourceEstimateId,
  sourceMenuItemId)`, so two branches of one ancestor would each promote their
  copy of the same card as separate presets. Probably wrong — the library would
  fill with near-duplicates of the same work. Needs a rule: promote only from one
  designated lineage member, or dedupe on lineage.

**Status:** not started. This supersedes the earlier separate "Versioned
estimates" and "Branching estimates" entries.

## Artifact generation alongside the WBS

**What:** produce supporting artifacts from an estimate, not just numbers.
Confirmed wanted: **ERD, user-flow diagram, low-fidelity wireframes** — and more
later.

**Hard requirement from the request:** artifact types must be **addable through
the UI**, without a code change. "I shouldn't have to come back to the code to
add support for a new artifact." So an artifact type is *data*, not a switch
statement.

**The pattern to reuse is already here.** Agent prompts are exactly this: a
DB-versioned record (`Prompt`/`PromptVersion`) with an admin editor at
`/admin/prompts`, loaded at run time by `loadActivePrompt`. An artifact type
wants the same — name, the prompt that generates it, expected output format,
active version — plus a renderer chosen by format rather than by type. Note
`AgentKind` is a Prisma **enum**, so artifact types must NOT be modelled that
way; adding an enum value is a migration, which is the thing being ruled out.

**Open:** what does an artifact render as (Mermaid text, SVG, image, markdown),
and is it generated on demand or as part of a run?

**Status:** not started.

## Configurable estimate — a menu card the client picks from (clarified 2026-08-20)

**What:** the estimate is presented as a menu of modules the customer chooses
from. A business analyst toggles menu items on and off at will during presales,
the total updates live, and because modules genuinely depend on each other,
switching one ON pulls in whatever it requires. Point of the whole thing: take
the guesswork out of presales.

**Reference:** the requester has a Claude artifact demonstrating the intended
interaction — get it before designing the UI.

**A surprising amount already works.** This is not a build-from-scratch item:
- `MenuItem.enabled` and `onToggleItem` — toggling exists.
- **Totals already update live.** `ledger-context.tsx:153` recomputes the rollup
  on every toggle ("disabled items are priced but never counted"), and
  `RollupCard.tsx:70` already shows the `excluded` hours.
- **The pipeline already computes a requires-chain.** `architect.ts:242-255`
  derives `notSafelyRemovable` from `sequencing.requires` and sets
  `toggleable: !notSafelyRemovable`.
- The preset library holds a **real dependency graph**: `PresetVersion.requires`
  and `.blocks`, 43 version rows, 40 distinct ids referenced, 0 dangling. Every
  card carries `sourcePresetId`, so cards can be mapped onto it.

**The three actual gaps:**

1. **The dependency data is computed, persisted, and then ignored.**
   `run-estimate.ts:288-290` writes `toggleable`/`notSafelyRemovable`/`thinSlice`
   into `MenuItem.meta` (a JSON blob) and the editor's `ItemDTO` never reads
   `meta` at all. So the UI lets a BA switch off a foundation card that three
   others depend on, with no warning, even though the pipeline knows. Surfacing
   this is the cheapest first win.
2. **`notSafelyRemovable` is a boolean, not edges.** It answers "risky to
   remove?" but not "if I switch this ON, what else must come on?" — which is the
   behaviour actually wanted. Needs real per-card dependency edges, derivable
   from the preset graph via `sourcePresetId` plus the Architect's own
   `sequencing.requires`.
3. **No cascade.** Enabling an item must enable its dependencies (and probably
   warn, rather than silently disable dependents, when switching one off).

**Open:** when a cascade adds items the client didn't pick, how is that shown —
auto-added and flagged, or offered for confirmation? And does `blocks` mean
mutually exclusive options (pick one of two approaches), which is a different
interaction from `requires`?

**Status:** not started. Distinct from the earlier reading of this item as
"per-estimate config overrides", which is not what was meant.

## Custodian on estimates, with deadlines and reminders

**What:** a named custodian responsible for an estimate, a deadline, and
reminders as it approaches.

**Current state:** `Estimate.ownerId` is the only person on an estimate, and it
means "who created it" — it's set once at
`api/estimates/ingest-create/route.ts` and never changes except through the new
admin reassignment. There is no deadline field and no due-date concept anywhere.

**Notes:** custodian and owner should probably be separate — reassigning
ownership when someone leaves is a different act from handing over day-to-day
responsibility. Email infrastructure exists and works (`lib/email.ts`:
`sendEmail`, `estimateUrl`, and the existing run/ingest notifications), so
reminder content is easy. **What's missing is a scheduler**: every Inngest
function today is event-triggered, there are no cron functions, so a daily
"what's due" sweep is genuinely new plumbing (Inngest supports crons; it just
isn't used here).

**Status:** not started.

## Fix the Google Sheets export

**What:** the live export path has **never actually worked** — it has only ever
run against the stub.

**Evidence:** `createSheetsProvider()` returns `StubSheetsProvider` unless both
`GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_DRIVE_FOLDER_ID` are set. Every test
and every documented run has taken that path. When the e2e suite *did* pick up
real credentials from `.env.local` on 2026-08-07, the live provider failed
immediately with **"The caller does not have permission"** — the first time the
live path had been exercised at all. (The suite now blanks those vars
deliberately; e2e should not call a third party's Drive.)

**So the work is a first live verification, not a regression fix:** confirm the
service account can write to the target folder, that the folder id is right, and
that `LiveSheetsProvider.createSpreadsheet` produces what's expected end to end.

**Also check while in there:** `sheets-export.ts` builds one tab per `RoleKind`
with columns `Item | Line Item | Taxonomy Key | Base Hours | Taxed Hours | Notes`.
That survived the dev-hours consolidation (it reads line items, not preset
BE/FE), but it has never been eyeballed in a real spreadsheet.

**Status:** not started.

---

# Requested 2026-08-20 (second pass)

## Preset model rework — it's someone else's spreadsheet schema

**Framing:** `PresetVersion` is a direct transcription of
`docs/Estimate Presets (ISM).xlsx`, designed by someone else for a different
purpose. Treat it as legacy. ~25 fields, of which the retrieval path selects
twelve, and only a handful influence an estimate.

### 1. Split three concerns that are currently one flat row

- **Retrieval surface** — what makes a preset findable: `name`, `description`,
  `keywords`, `embedding`, `embeddingText`. This is the *entire* matching
  mechanism; the embedding is literally `name + description + keywords`.
- **Estimate anchor** — what it contributes: dev hours, side flags, and the
  comparison signals below.
- **Composition rules** — how it relates to other modules: `requires`, `blocks`,
  `canParallel`.

They're conflated today, which is why the third silently rotted: nothing
consumes it, so nothing keeps it honest.

### 2. Dependency edges become first class

`requires: String[]` / `blocks: String[]` of preset codes: no FK, no direction
beyond convention, no reason attached, no way to say "these two are
alternatives". Replace with real edges — `(fromPresetId, toPresetId, kind)` where
kind is `REQUIRES | BLOCKS | ALTERNATIVE_TO`, plus an optional note.

Then a cascade is a graph walk instead of string matching, referential integrity
is enforced, **and the graph can be visualised** — which is wanted.

This is the prerequisite for the configurable-estimate menu card, not a cleanup.

**Also settles an open question:** nothing in the codebase reads `blocks` at all,
so whether it means "must not coexist" or "must come after" has never been
decided *or* validated against the 24 presets that use it. Decide it here.

### 3. The comparison signals are not inert — they're unused as deltas

**Correction to an earlier reading of this file.** `integrationCount`,
`dataVolume`, `projectSizeFit`, `aiAssist`, `risk` are genuine signals — they are
exactly what lets a model judge between two presets matching similar
requirements. They should NOT be dropped.

The real defect is that the comparison never happens. `archivist.ts:127-128`:

```ts
dataVolume:       req.dataVolume,        // from the REQUIREMENT
integrationCount: req.integrationCount,  // from the REQUIREMENT
aiAssist:         toImpactLevel(meta.aiAssist),  // from the preset
risk:             toImpactLevel(meta.risk),      // from the preset
```

The field is called `adjustments` and the prompt calls them "Adjustment signals"
(`specialist.ts:58`) — but two of the five are the requirement's own values handed
straight back. **Nothing is adjusted, because nothing is compared.** The preset's
`integrationCount` and `dataVolume` are selected out of the database and dropped.

So the model is told "integration_count: 4" with no baseline to judge it against.
The intended meaning — *this preset was built at 1, your requirement is 4, scale
up* — was never implemented. Fix: compute and pass the delta. Plausibly a
contributor to the calibration gap PROGRESS.md tracks, since every run has been
handing the model reference-free numbers.

### 3b. Controlled vocabulary that can grow without a deploy

`category` / `reqType` / `platform` are free strings. They were deliberately
opened up from enums (see the long comment in `packages/shared/src/schemas.ts`)
because a closed **ecommerce-specific** enum forced every requirement into the
nearest wrong label. That diagnosis was right; the remedy overshot.

What's wanted is closed-but-curated: a vocabulary you own, extensible without a
migration. A Prisma enum can't do that. **The pattern already exists here twice**
— `TaxonomyNode`/`TaxonomyNodeVersion` and `Prompt`/`PromptVersion`: DB-backed,
admin-editable, single-active, loaded at run time.

So: a `VocabularyTerm` table keyed by kind (`CATEGORY`, `REQ_TYPE`, `PLATFORM`),
the active list injected into the Librarian's prompt at run time (prompts already
load at run time — same seam), and validation against the DB rather than a zod
enum.

**Decided:** when the Librarian wants a term that isn't in the list, **accept it
and queue it as `pending`** for admin review — approve, merge into an existing
term, or reject. The vocabulary grows out of real work instead of guesses, and a
bad fit is visible rather than silently absorbed. Needs a review surface in
`/admin`.

### 4. `notes` — two fields, kept separate

**Decided.** Split into:
- a pipeline-owned field populated at promotion from the estimate's relevant
  `assumptions[]`, so "last time we assumed X" comes back as an anchor
- a human-authored field an estimator writes and a promotion never overwrites

Today `notes` is editable in the admin form
(`admin/presets/[id]/page.tsx:280`) but **nothing populates it and nothing reads
it** — the most useful column in the original spreadsheet is inert in both
directions. Whichever field it becomes must reach the specialist prompt.

### 5. Separate estimated from actual hours

`devHours` is one number doing two jobs: the original estimate, and — after
`recordActuals` — the delivered figure. Recording actuals **overwrites** the
estimate, so the comparison is destroyed by the act of recording it.

**Confirmed this feeds all three of:** calibration/accuracy tracking (per preset
and per estimator), ingestion of actuals from an external system (Jira,
timesheets) rather than manual entry, and commercial margin/pricing analysis.
All three need estimate and actual side by side, with attribution and a date —
so this is a related-records problem, not an extra column.

**Status:** not started. Item 2 is the prerequisite for configurable estimates;
item 3 is the one most likely to improve estimate quality on its own.

## Never let the WBS and the preset library drift apart again

**Hard requirement.** The WBS promotes to presets and presets populate the WBS.
That loop has drifted before and must not again.

**Why it drifted, precisely:** promotion was tested, retrieval was tested, and
the **round trip** was not. Neither `ws20.test.ts` nor `writeback-promote.test.ts`
mentions `runArchivist` or `ArchivistMatch` — they assert what promotion writes
and stop. That is exactly the gap `beHours = Σ DEV; feHours = round(BE * 0.4)`
lived in for months: a 1.4× inflation on every promoted preset, invisible because
nothing ever read one back.

**Decided — both guards, because they catch different classes of failure:**

1. **Structural drift** → a shared costed-work type so a mapping mismatch cannot
   compile. Split into two separately-sized items below ("focused" and "full").
2. **Semantic drift** → a **CI-blocking round-trip test**: estimate → promote →
   retrieve as an anchor → assert the anchor equals what was estimated.

**Why both, stated plainly:** a shared type could not have caught the bug that
actually hurt. `feHours = round(beHours * 0.4)` was perfectly type-correct — two
`Int`s, no mismatch anywhere. Types check shape, not meaning. Only a round trip
notices that the number coming back out is 1.4× the number that went in.

**Status:** not started. Do the round-trip test and the focused refactor before,
or alongside, the preset rework — not after.

## Shared costed-work type — FOCUSED (do this one)

**What:** collapse the duplicated representations of "a costed unit of work" down
to one definition, and the duplicated Prisma-row mappings down to one function.
Deliberately scoped to stop the bleeding, not to redesign the model.

**The problem, measured.** Four separate hand-written types describe the same
thing, none derived from another:

| Type | Where | Used by |
|---|---|---|
| `SpecialistLineItem` | `shared/src/schemas.ts:289` | what a specialist emits |
| `RoleLineItem` (zod) | `shared/src/schemas.ts:333` | what the pipeline passes around |
| `RoleLineItem` (Prisma) | `db/prisma/schema.prisma:388` | the database row |
| `LineItemDTO` | `estimates/[id]/actions.ts:20` | what the editor reads |

Same story one level up: `MenuItemSchema`, the Prisma `MenuItem`, and `ItemDTO`.
And **at least three near-identical Prisma-row → `MenuItem` mappings**, each
independently maintained:

- `apps/web/src/app/estimates/[id]/page.tsx:61` (the Sheets export action)
- `apps/web/src/inngest/functions.ts:256` (the promote function)
- `packages/agents/src/rollup.ts:85`

**Evidence this is the drift mechanism, not a tidiness complaint.** Adding
`touchesFrontend`/`touchesBackend` — *two booleans* — required changes in twelve
files (`eceb937`): schemas, specialist, architect, run-estimate, taxation, audit,
actions, page, ledger-context, MenuCardEditor, SideTag, migration. The compiler
caught only some of it: `taxation.ts` and `audit.ts` surfaced only on a full
typecheck, and the Sheets export DTO in `page.tsx` needed a *separate* fix
afterwards because it is a second mapping inside the same file. Had I stopped at
the first green typecheck, the flags would have silently vanished from the export
path.

Six-plus places to update is not a discipline problem, it is arithmetic: a field
eventually lands in five of them.

**The work:**
- One canonical shape for a costed unit of work (and for a card) in
  `@repo/shared`.
- DTOs become **derived** types (`Pick`/`Omit`) rather than fresh declarations, so
  adding a field either propagates or fails to compile.
- **One** `toMenuItem(prismaRow)` / `toLineItem(prismaRow)` helper; the three
  existing copies call it.

**Explicitly out of scope:** changing the database model, and deciding whether
`PresetVersion` should *be* a costed-work record. See the FULL item below.

**Status:** not started. Recommended: do this as part of the anti-drift work —
most of the protection for a fraction of the cost, and it makes the preset rework
materially safer to attempt.

## Shared costed-work type — FULL unification (decide later, not now)

**What:** one canonical model of costed work from which the database, the
pipeline, the DTOs **and the preset library** are all derived — including
answering whether `PresetVersion` should be a costed-work record rather than a
parallel schema that happens to hold hours.

**Why it's a genuine question and not just "more of the above":** a preset and a
menu card are arguably the same object at different lifecycle stages. A card is
costed work for one client; a preset is costed work generalised for reuse.
Today they are unrelated schemas joined by a hand-written mapping in
`writeback.ts`, which is exactly where the 1.4× inflation lived. Unify them and
that class of bug becomes unrepresentable.

**Why NOT now:**
- It touches the pipeline, the DB, every DTO and the preset library at once —
  much larger blast radius than the focused item, with the same specific
  protection already achieved by it.
- It should be **answered by** the preset rework, not bundled ahead of it. The
  rework splits `PresetVersion` into three concerns (retrieval surface / anchor /
  composition rules); once that shape is settled, whether the anchor half *is* a
  costed-work record becomes an obvious yes or an obvious no. Deciding it first
  means guessing.

**Status:** not started, deliberately deferred. Revisit once the preset rework
has settled the anchor's shape.

## No orphaned backend work (requested 2026-08-20)

**The rule:** a field or capability that exists on the backend must have a
frontend implementation, unless it is *explicitly* recorded as backend-only.
CRUD on the backend is not CRUD on the frontend. A column is not a feature.

**This is a systemic pattern here, not a one-off.** Found in a single session:

| Orphan | Where |
|---|---|
`toggleable`, `notSafelyRemovable`, `thinSlice` | Architect computes them, `run-estimate.ts:288-290` persists them into `MenuItem.meta`, the editor DTO never reads `meta`. The UI lets a BA switch off a foundation card the pipeline knows is unsafe to remove. |
`requires`, `blocks`, `canParallel` | Selected by the Archivist, carried into `ArchivistMatch.sequencing`, then only `requires` is used — flattened to one boolean. `blocks` and `canParallel`: zero consumers. |
`SupervisorInput.mode`, `changedMenuItemIds` | Declared in the schema; appear nowhere else in the codebase. The intended seam for partial re-runs, never wired. |
`promoteMenuItemsToPresets` | A complete, unit-tested feedback loop with **zero callers** outside tests, for months. |
`preset.notes` | Editable in admin, read by nothing. |
`userStoryTags`, `projectSizeFit` | Only ever copied forward in `writeback.ts`; never read for a decision. |
"reassign or remove them first" | A tooltip promising a feature that did not exist anywhere in the codebase. |
Preset embeddings | `seed-presets` wrote none and no backfill existed, so retrieval silently matched nothing. |

**Proposed mechanism — make orphans loud instead of relying on discipline:**
- **Orphan-field audit**, CI-blocking: for every persisted column, assert it is
  referenced somewhere in `apps/web/src`, with an explicit allowlist for
  deliberate backend-only fields. A new unallowlisted orphan fails the build; the
  allowlist is where "purposely not on the frontend" gets *recorded* rather than
  assumed.
- **Zero-caller export check**: exported functions in `packages/*` with no
  non-test caller. Would have caught `promoteMenuItemsToPresets` immediately.
- Same idea as `embeddingText` and the round-trip test above: the failures that
  hurt here are all **silent**, so the fix is always to make the invisible
  visible.

**Status:** not started. Applies far beyond presets — worth doing early, since
every item in this file adds surface where this can happen again.
