# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-242 — dependency edges become first class (PLANNING, v2)

Status stays **Selected for Development**. Nothing is coded. Two decisions for
the user are at the bottom; neither blocks starting the schema.

Re-planned 2026-09-02 on new direction: **the xlsx goes away and the existing
preset library is void** — a wave of fresh preset work follows. The graph must
serve the AEH-235 presales configurator *and* resource planning, and it must be
editable through a genuinely smooth UI.

That direction deletes the v1 plan's only blocker. The P27/P34/P38 cycle was a
defect in seeded data that is now being discarded; there is no edge migration
left to get right.

### Why this ticket exists — one paragraph

The AEH-235 reference artifact (`~/Downloads/scope-atlas-agent-intelligence
v1.html`, attached to that ticket) already caught a real scoping error with
exactly this graph. Loading its "T1 Continuity" starting point pulls in M38 as
an unavoidable prerequisite, because M45 (in-platform notifications, in T1)
depends on M38 (email infrastructure, in T2). **T1 as scoped is not
dependency-closed** — 1,100–1,181 hours quoted, 1,216–1,302 hours real. A
dependency graph is not modelling for its own sake; it catches quotes that are
wrong before they leave the building.

### What the reference implementation settles

Its data model, read from the file (~57 modules, 72 edges, ~1.3 edges/node):

    const DEP = { M06:['M05'], M09:['M08'], M45:['M38'], ... }   // child -> prerequisites
    const CORE = ['M01','M03','M04','M05'];                       // always included
    resolveUp(codes)        // transitive prerequisite closure, then add CORE
    dependents(code,within) // transitive reverse closure, restricted to `within`

Toggle on -> `resolveUp`, auto-added, no confirmation. Toggle off -> delete the
transitive dependents, then the node. Group-level "select all". Named starting
configurations (`PRE`).

**One relation. No `blocks`, no `ALTERNATIVE_TO`.** The reference arrived
independently at the design the v1 plan recommended, which is now settled rather
than proposed.

### Design

Single edge kind, so no `kind` column — a one-value enum is an invitation to put
`BLOCKS` back, and adding the column later is trivial.

    dependentVersionId   -> PresetVersion.id   (the version declaring the need)
    prerequisitePresetId -> Preset.id          (stable target, real FK)
    note                 String?               (why — the ticket asked for it)
    @@unique([dependentVersionId, prerequisitePresetId])

Declaring side is the version, preserving the per-version history AEH-244 added.
Target is the stable preset id, so an edge survives the target being versioned.
Names chosen so direction cannot be misread — "requires" on a row is exactly the
ambiguity this ticket exists to kill. `canParallel` stays on `PresetComposition`
as a node hint, unchanged.

**Resource planning falls out of the DAG — no second edge kind.** Topological
levels are delivery waves; the longest path weighted by `devHours` is the
critical path; the width of each level is how much can run concurrently. One
relation, two consumers. Assigning actual people is a later ticket.

**`CORE` does not become a preset flag.** Foundation-locking in the artifact is
per-project — that client's skeleton. A library spanning Shopify builds and
e-learning platforms has no universal foundation. Locked cards belong in AEH-235
as a per-estimate decision, exactly like "Start from" configurations.

**Redundant edges are shown, never auto-deleted.** The reference keeps them
(`M16:['M14','M15',...]` alongside `M15:['M14']`). Transitive reduction is
fragile under editing: drop `M15->M14` later and M16 silently loses M14. Detect
and label ("also implied via M15"); let the human decide.

**The graph primitive takes a scope set.** `prerequisitesOf(preset, within?)`
and `dependentsOf(preset, within?)`, cycle-safe. Edges are between presets, but
the configurator walks an estimate's *cards*, which reach the graph through an
optional `sourcePresetId`. Without the `within` parameter AEH-235 rebuilds
these. Contract handed over: cards with no `sourcePresetId` are unconnected, and
what to do when a prerequisite has no card in the estimate is AEH-235's call.

### UX — what makes it smooth

The problem with graph editing is that a graph is non-local: to add an edge
safely you must know the whole graph. Four rules remove that burden.

1. **Always edit from one node's point of view.** Never a global "add edge"
   form. On preset X you answer one question a human can answer without holding
   the graph: *what must exist before X?*
2. **The picker cannot offer an invalid choice.** Everything downstream of X is
   excluded from the candidate list, so a cycle is unrepresentable rather than
   validated-against. This is the single biggest win.
3. **Show the consequence at the moment of the decision.** Hovering a candidate
   shows "adds 17 prerequisites" and names them. The closure is computed for
   them, so it is never carried in their head.
4. **The reverse direction is read-only.** "What breaks if this goes" is always
   shown, never edited here — one direction of truth.

Plus a **layered DAG view**, laid out by topological depth rather than
force-directed. It earns its place for resource planning: the layers *are* the
delivery waves.

The strongest idea, deliberately **not** in this ticket: a workbench where you
edit the graph by *using* it — the configurator itself, pointed at the library,
where an admin toggles a preset, sees what came with it, and corrects an edge
inline. That is AEH-235's configurator with a source switch. Build it once,
there, rather than twice.

### Scope

In: schema + migration; the edge writers and carry-forward (`carryPresetEdges`
mirroring `carryPresetVector` — AEH-244's record says this hazard class has bitten
twice); readers (`archivist` select, `presetCaveatsFor`, `SequencingSchema`);

**Every fixture writing the arrays breaks the moment the columns drop** — fix
them in the same commit or the first `pnpm typecheck` is how you find out:
`apps/web/e2e/global-setup.ts:188`, `packages/agents/src/wbs-preset-round-trip.test.ts:280`,
`writeback-promote.test.ts:128`, `ws9.test.ts:109,155`, `ws11.test.ts:93`,
`preset-embedding.test.ts:66`, `packages/db/src/changelog.test.ts:42`,
`packages/db/src/index.test.ts:66`, plus `writeback.ts` itself.

Also in:
scope-aware cycle-safe graph queries; a DAG invariant test; the node-local
editor with rules 1-4; the layered view; retire the xlsx and `seed-presets.ts`.

Out: the configurator workbench and per-card cascade (AEH-235); resource
assignment.

**The architect fix stays in, and now needs a real fixture.**
`computeRequiredRequirementIds` (architect.ts:91-97) adds `sequencing.requires`
— preset codes — to a set tested against `card.requirementIds`, which are
`REQ-001` ids. They never match, so `notSafelyRemovable` is **always false in
production**; `ws16` passes only on a hand-fed `['REQ-001']` the Archivist never
produces. New shape: a card is not safely removable when another card's
`sourcePresetId` has this card's `sourcePresetId` in its prerequisite closure.
Live data will be empty after the void, so the test must build the fixture.

### The old library is reference only (confirmed 2026-09-02)

The presets are being **deleted**, not migrated, and the schema is being
reshaped as well. So: no columns to preserve, no carry-forward of old edges, no
four-database data verification. The edge table is designed against the new
schema rather than bolted onto the current one.

Their only remaining use is as **a sample of the kind of work we do** — a real
portion of it, so worth keeping for two purposes and nothing else:

- Designing the editor against realistic shapes: ~1.3 edges per node, heavy
  fan-in to a few foundations, chains up to 10 deep, ~44 of 79 presets carrying
  any edge at all. The reference artifact independently lands at the same
  density (57 modules, 72 edges), so that is the shape to build for.
- Test fixtures — including the `P27 -> P34 -> P38 -> P27` cycle, which is worth
  encoding deliberately as the case the DAG invariant must catch.

Nothing else about them is binding. The 88 edges are saved as reference data.

**The DAG invariant test therefore runs against fixtures, not live data** —
live will be empty. Same for the architect fix's `notSafelyRemovable` case.

Still true, and it is why AEH-306 exists: retiring the seed touches root
`package.json:19` (`db:seed` chains `db:seed:presets`), `packages/db/package.json:17`
and its `xlsx` dependency, `docs/SETUP.md:34,49`,
`docs/02_PRISMA_DATA_MODEL.md:5,62,78,234`, `docs/01_ARCHITECTURE.md:24`,
`docs/00_BUILD_GUIDE.md:10`, `docs/04_WBS.md:26,295,306`, and the `Preset.id`/`code`
schema comments citing P01–P45 as load-bearing.

### Open question raised 2026-09-02, not yet decided

AEH-242 is §2 of six sections. If the preset schema is being reshaped anyway,
§3 (AEH-243), §3b (AEH-245), §4 (AEH-246) and §5 each want their own migration
against a table that is still moving. Landing the model changes as **one**
reshape may be cheaper than four sequential ones. Against it: 242 is what
unblocks AEH-235, and presales is the priority. Undecided — plan either way.

### Decisions taken (2026-09-02, all confirmed by the user)

1. **"Always included" lives per-estimate in AEH-235**, not as a preset flag.
   Foundations are a property of one project's scope; a library spanning
   Shopify builds and e-learning platforms has no universal foundation.
2. **Minimal-smooth UX in this ticket** — node-local picker, cycle-impossible
   candidates, live closure preview, layered DAG view. The
   configurator-as-editor workbench is AEH-235's, built once with a source
   switch rather than twice.
3. **Prompt preamble rot is AEH-306**, created at High under AEH-6 and linked
   to this ticket. Out of scope here by decision; sequence it ahead of the
   preset wave.

### Verification (AEH-244's list, verbatim)

`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter web build`,
`pnpm run audit:fields`, `pnpm run audit:exports`, migration applied on all four
databases. Trap: `pnpm -r typecheck` stops at the first failing package, so a
later package's errors stay invisible until the earlier one is green.

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
