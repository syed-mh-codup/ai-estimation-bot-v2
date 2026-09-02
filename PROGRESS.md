# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-235 slices 1 and 2 built

The scope configurator. Green: typecheck, lint, `pnpm test` (64 files, 577
passing), `audit:fields`, `audit:exports`, `pnpm --filter web build`, and
`e2e/scope.spec.ts` (4 specs).

⚠️ The e2e SUITE has pre-existing flakiness unrelated to this work.
`estimates-create.spec.ts:17` fails reproducibly on clean master;
`oracle.spec.ts` fails non-deterministically with different specs each run. Both
verified by stashing this branch and re-running. Belongs on AEH-282.

⚠️ **Do not reach for e2e to test UI logic here.** The full suite is ~13 min and
even one spec file is ~5. There are no component tests in this repo at all —
`vitest.config.ts` is `environment: 'node'`, the include pattern is
`*.test.ts`, and there is no jsdom or testing-library — so anything left inside
a component can ONLY be covered by Playwright. The answer is not to add a
browser test, it is to keep the logic out of the component:
`scope-interaction.ts` and `scope-dto.ts` are pure, and their 27 tests run in
~150ms versus minutes. e2e now holds only the claims a browser has to make (a
real round trip, a reload, the estimate staying untouched).

Adding jsdom + @testing-library/react would let the components themselves be
tested and is probably worth doing — a dependency + config decision nobody has
taken yet.

### The framing, which is the thing not to undo

**The estimate owns its dependency graph.** Dependencies are a property of the
project being built, so they are computed for that project and stored on it
(`MenuItemDependency`, keyed to the estimate, edges between its own cards).

The preset library's graph is a **record, not a source**. Promotion preserves an
estimate's graph into it (`carryEstimateGraphToPresets` in `writeback.ts`) so the
knowledge is not lost, and the library reads it for its own views — delivery
waves, the critical path. **Nothing reads it back into an estimate**, and there
is deliberately no mechanism to: every project is different, so one project's
ordering is not evidence about another's. Decided 2026-09-02, and it is why
`DependencySource` has only INFERRED and MANUAL — a `PRESET` value existed
briefly and was dropped in migration 29.

Nothing in the configurator requires a preset. That is not a nicety — only 12 of
140 cards carry a `sourcePresetId`, so a preset-gated configurator would be
unavailable on every real estimate. `estimate-graph.test.ts` sets
`sourcePresetId: null` on every fixture card deliberately, so a regression that
reintroduced the requirement fails rather than passing on a helpful fixture.

Superseded by this: the approved plan at
`~/.claude/plans/federated-spinning-sundae.md` still describes the older
`ScopeMap`-owns-everything design, where the graph was a configurator artifact
derived as a workaround for the empty preset library. Read the framing above
instead. What survives from the plan: the cascade semantics, `Walkable`, the
three guards, the fixture traps, and slice-1-before-the-agent.

### Still true and worth not re-deriving

`PresetDependency` has 0 rows on Neon dev/main. So `notSafelyRemovable` is
*structurally* false everywhere, which makes the "Load bearing" chip, its
disabled toggle and the refusal branch in `setItemEnabled` all dead in
production. `MenuItem.foundation` is a real column now; never seed it from that
flag. See [[preset-graph-is-empty]].

Slice 2 (CARTOGRAPHER) is built: it fills the same `MenuItemDependency` rows
with `source: INFERRED` through the same `replaceEstimateGraph` guards, so a
derived graph and a typed one are held to one standard.

On demand via `POST /api/estimates/[id]/scope-map`, not part of a run — heavy
model, and most estimates are never configured. **The cost of that:** a re-run
replaces every card and so drops the graph, which then has to be asked for
again. If the spend is ever judged worthwhile, calling `runCartographer` from
the run's persist step is the whole change.

Prompt install is `pnpm db:seed:cartographer` (or `db:seed:prompt <KIND>`).
`seed-prompt-oracle.ts` was generalised into `seed-prompt-one.ts` rather than
copied — a second agent needing the same careful install is exactly when
duplicating it starts the drift that file exists to prevent.

Three fixture traps in `docs/preset-dependency-reference.md`, all verified
against the file: it is 43 data rows though its own summary says 44; it already
contains a dangling target (`P06` blocks `P22`, which has no row); and the
`P34 -> P27 -> P38 -> P34` cycle only closes once `blocks` is normalised into
`requires`, so a builder reading only the `requires` column gets a clean DAG and
the cycle test passes vacuously.

### Two migrations, all four databases

`20260902105647_aeh_235_estimate_dependency_graph`,
`20260902110953_aeh_235_scope_scenario`,
`20260902133000_aeh_235_drop_preset_dependency_source` and
`20260902142404_aeh_235_cartographer_agent`, all applied to local
`ai_estimation`, local `ai_estimation_test`, Neon test and Neon dev/main (30
migrations each). The first two purely additive; the third rebuilds the
`DependencySource` enum to drop `PRESET` (Postgres cannot remove a value in
place), verified as zero-row on all four before applying. Neon dev/main verified intact afterwards: 140 cards, 33
prompt versions, 79 searchable preset versions.

Also still open from AEH-242:

**AEH-306 (High)** — every agent prompt still asserts the preset library is the
ecommerce/B2B range P01–P45. Voiding that library makes it false in all ten, and
it degrades matching silently rather than erroring. Should be scheduled ahead of
the preset wave, not after it. The bodies exist only in Neon dev/main, so it is
a data change with a runbook, not a code edit.

**Undecided:** AEH-242 was §2 of six. §3 (AEH-243), §3b (AEH-245), §4 (AEH-246)
and §5 each still want their own migration against a preset model that is being
reshaped anyway. Landing them as one reshape may be cheaper than four sequential
ones. Raised, never settled — worth deciding before the next one starts.

## Databases

    local docker  ai_estimation        30 migrations
    local docker  ai_estimation_test   30 migrations
    Neon test     (ep-wild-heart)      30 migrations
    Neon dev/main (ep-polished-credit) 30 migrations

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
