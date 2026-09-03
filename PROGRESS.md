# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-239 — artifact generation alongside the WBS (PLANNED, awaiting approval)

Branch `feat/aeh-239-artifacts`. Nothing implemented yet — this is the agreed
shape, written down before any code so a crashed session can resume from it.

### The hard requirement, and what actually satisfies it

"I shouldn't have to come back to the code to add support for a new artifact."
So an artifact TYPE is a database row, never a Prisma enum and never a switch
statement. Three things have to be data for that to hold, and all three are
versioned text an admin edits:

  the prompt          what the model is asked to produce
  the corpus sections which slices of the estimate it is shown
  the render template the self-contained HTML shell its output drops into

What stays code, deliberately: the FORMAT. A format is a renderer, and a new
renderer is a code change by definition. The ticket says as much — "a renderer
chosen by format rather than by type". Two formats ship (HTML, MARKDOWN); the
six artifact types named on the ticket all fit inside them, which is the point.

### The 300s ceiling decides the generation shape

The requester's own reference artifact, scope-atlas-agent-intelligence-v1.html
on AEH-235, is 100,605 bytes. That is roughly 25,000 output tokens. On Vercel
Hobby's hard 300s per-step ceiling a heavy model cannot reliably stream that in
one call — it is 300-500s at realistic rates. Asking the model to write the
whole page is therefore not a safe default.

So the model produces DATA, and a template renders it:

  1. The active type version's prompt + selected corpus sections go to the
     model. It returns JSON — 35 entities, 12 journeys, whatever the type is
     about. Call it 6-10k output tokens, comfortably inside the ceiling.
  2. That JSON is substituted into the type's render template at the literal
     placeholder `__ARTIFACT_DATA__`, inside a
     `<script type="application/json">` tag. The template's own script renders
     it. One string replace, no templating engine, no new dependency.
  3. The result is one self-contained HTML document, stored whole.

The ~90KB of tabs, styling and click-to-trace behaviour lives in the template,
written once and reviewed once, instead of being re-hallucinated per estimate.
A typo in the layout is fixed by editing the template — no model call, no spend.

A type may leave `renderTemplate` null, in which case the model's output IS the
document. That is the escape hatch for small artifacts (a one-page tranche
impact narrative) where 25k tokens is not in question. Which path a type takes
is data, not code.

### Data model

  ArtifactType         id, key (slug, unique), name, description, format,
                       enabled, order, createdAt
  ArtifactTypeVersion  id, artifactTypeId, version, promptBody, modelString,
                       corpusSections String[], renderTemplate String?, active,
                       changeReason, changeMotivation, createdAt, createdBy
  EstimateArtifact     id, estimateId, artifactTypeId, typeVersion Int,
                       format, title, content String, inputs Json?,
                       createdAt, createdById

`ArtifactTypeVersion` is `PromptVersion` with three more fields and a FK
instead of an enum id — the same single-active-per-parent invariant, held by
the same `$transaction` pattern as `activateVersion`.

`typeVersion` is snapshotted on the artifact: a delivered document must still
say which prompt produced it after the type is edited. `inputs Json?` exists
from day one because re-allocation provenance and tranche impact both need to
name a saved ScopeScenario, and adding that column later is exactly the
migration this ticket is trying to abolish.

No status column and no Inngest. Same reasoning as the Cartographer: there is
nothing durable to resume, so the row is written on success and the failure
goes down the stream. Types are archived via `enabled`, never hard-deleted —
generated artifacts are client deliverables and must keep their lineage.

One-time enum changes, not per-type: `ArtifactFormat { HTML, MARKDOWN }`,
`UsageKind += ARTIFACT`, and `ModelUsage.artifactId` so spend attributes to the
document that caused it.

### The dossier

One `buildArtifactDossier(db, estimateId)` assembling independently selectable
named sections — sow, requirements, cards, roles, rollup, graph, hiddenWork,
scenarios, narrative. A type ticks the ones it needs. Adding a TYPE touches no
code; adding a SECTION does, and that is a change to what data exists at all,
not to artifact support.

A third corpus builder, after `buildOracleCorpus` and `buildScopeCorpus`, needs
the reason Cartographer wrote down for diverging: Oracle's corpus omits
`MenuItem.id`, is explicitly marked as the seam Oracle's retrieval work will
change, and is a chat corpus rather than a selectable one. The dossier is
section-addressable by construction, which neither of the others is.

### Slices

  1  Schema + admin. Migration, then `/admin/artifact-types` — list, create,
     edit-creates-a-version, version history, activate. Create flow mirrors
     `/admin/presets` (prompts has no create); history mirrors
     `/admin/prompts/[kind]/[version]`. Model picker reuses
     `fetchModelOptions()`. Nothing generates yet.
     Tests: single-active invariant, slug derivation and collision.

  2  Dossier + generator. `packages/agents/src/artifacts.ts` —
     `buildArtifactDossier`, `renderDossier`, `runArtifact`. Loads the active
     type version, builds only the ticked sections, calls the model, records
     usage against ARTIFACT + artifactId, substitutes the template, writes the
     row. No UI.
     Tests: section selection, unknown-section tolerance, template
     substitution, placeholder-absent handling, fence stripping, the
     null-template direct path.

  3  Generate and view. SSE `POST /api/estimates/[id]/artifacts`, shaped like
     scope-map down to the 401/404/409/503 ladder and errors-in-the-stream.
     Compact "Artifacts" card in the estimate rail — count, link, generate
     picker, and nothing more, because AEH-302 is already about that rail
     being overloaded. Full view at `/estimates/[id]/artifacts/[artifactId]`.
     Stub provider under `OPENROUTER_STUB`, mirroring
     `cartographer-provider.ts`, deriving from the corpus it was handed rather
     than returning a canned payload.

  4  Seed the six types as data, and prove one end to end. Targeted script
     `db:seed:artifact-types` — never the bootstrap seed, which would revert
     ten live prompts to their v1 bodies. `graft build`, PROGRESS.md, and the
     implementation record onto the ticket.

### Rendering safely

`<iframe sandbox="allow-scripts" srcdoc={content}>`. `allow-scripts` WITHOUT
`allow-same-origin` — the pair together defeats the sandbox entirely, and the
frame must not be able to reach our origin, cookies or DOM. The app sets no CSP
of its own, so the generated document carries its own in a `<meta>` tag
(`default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';
img-src data:`), which makes "self-contained" enforced rather than hoped for.

A Download button, because handing the file to a client is the entire point.
A staleness chip when `artifact.createdAt < estimate.runFinishedAt`: the run
that produced this artifact's numbers has since been superseded.

### Traps this plan already knows about

- `content` can be 100KB. Every list query selects everything BUT `content`.
- AEH-306: every existing agent prompt still asserts the preset library is the
  P01-P45 ecommerce range, which is false. The new artifact prompts must not
  repeat that mistake — they describe no library at all.
- The e2e suite is not green on master (AEH-282), so slice 3's spec may not be
  gateable. Unit coverage carries the weight, as it did on AEH-240.
- Component tests still do not exist here. Logic stays out of components —
  `artifact-dto.ts` and a pure template-substitution module, testable in ms.

### Still carried forward (not AEH-239's, but still true)

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
