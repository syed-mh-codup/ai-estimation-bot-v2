# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-235 planned, not started

The scope configurator. Planned 2026-09-02; ticket is In Progress. **No code
written yet** — the only change on master is this file. Next action: slice 1,
starting with the `Walkable` widening and the `hours.ts` / `toItemDTO`
extractions, which are independent of the schema.

Plan: `~/.claude/plans/federated-spinning-sundae.md` (approved). Findings and
scope decisions are on the ticket as the 2026-09-02 comment.

The one thing to not re-derive: **the preset dependency graph is empty.**
`PresetDependency` has 0 rows on Neon dev/main, and only 12 of 140 `MenuItem`
rows carry a `sourcePresetId`. So a cascade that walks the preset graph from
cards is inert on every estimate, and `notSafelyRemovable` is *structurally*
false everywhere — which makes the "Load bearing" chip, its disabled toggle and
the refusal branch in `setItemEnabled` all dead in production. Do not seed
`foundation` from it; `MenuItem.phase` is the honest seed. See the
[[preset-graph-is-empty]] memory.

Sequencing decision worth not undoing: slice 1 is the configurator over a
**hand-authored** graph with no LLM at all, slice 2 is the generating agent. The
agent's output is unverifiable until something can render a graph, and slice 1's
schema is what the agent must write into.

Three fixture traps in `docs/preset-dependency-reference.md`, all verified
against the file: it is 43 data rows though its own summary says 44; it already
contains a dangling target (`P06` blocks `P22`, which has no row); and the
`P34 -> P27 -> P38 -> P34` cycle only closes once `blocks` is normalised into
`requires`, so a builder reading only the `requires` column gets a clean DAG and
the cycle test passes vacuously.

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

    local docker  ai_estimation        26 migrations
    local docker  ai_estimation_test   26 migrations
    Neon test     (ep-wild-heart)      26 migrations
    Neon dev/main (ep-polished-credit) 26 migrations

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
