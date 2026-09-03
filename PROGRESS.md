# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

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

    local docker  ai_estimation        31 migrations
    local docker  ai_estimation_test   31 migrations
    Neon test     (ep-wild-heart)      31 migrations
    Neon dev/main (ep-polished-credit) 31 migrations

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
