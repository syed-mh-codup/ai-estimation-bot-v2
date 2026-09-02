# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-242 — dependency edges become first class (IN PROGRESS)

Branch `feat/aeh-242-dependency-edges`, committed at `9caa213`. Not merged, not
pushed. The plan that produced it is in this file's git history at the previous
revision if the reasoning is needed.

### What shipped

`PresetDependency` replaces `PresetComposition.requires` and `.blocks`:

    dependentVersionId   -> PresetVersion.id   (declares the need; keeps history)
    prerequisitePresetId -> Preset.id          (stable target; survives versioning)
    note                 String?
    @@unique([dependentVersionId, prerequisitePresetId])

One directed kind, no `kind` column — the two arrays said the same thing from
opposite ends, and keeping them apart is what let them drift (35 of 88 edges
existed only in `blocks`, 19 only in `requires`, and the union held a cycle).

Graph walks live in `packages/shared/src/preset-graph.ts`, loading and carrying
in `packages/db/src/preset-graph.ts`. That split is load-bearing: importing a
walk from `@repo/db` pulls Prisma into the client bundle, and **only
`next build` catches it** — typecheck, lint and tests all passed on the version
that could not build. Sharing the walks is also what stops the admin picker
offering an edge the server action then rejects.

UI: dependency editor on each preset page (`dependency-editor.tsx` +
`dependency-actions.ts`), and a layered delivery-wave view at
`/admin/presets/graph` carrying waves, total hours and the critical path.

### Two bugs fixed on the way

`computeRequiredRequirementIds` compared preset codes against `REQ-001`-shaped
ids, so `notSafelyRemovable` was false for **every card in production** and the
editor offered to remove foundation work. Its test passed only by hand-feeding a
shape the Archivist never emits. Renaming the DTO field to
`prerequisitePresetIds` is what made the compiler point at it.

`syncPresetCodeSequence` was orphaned by deleting the seed. Rehomed into the
bootstrap seed — the xlsx importer that called it is gone, the code collision it
prevents after a restored backup is not.

### Verification

typecheck, lint, `pnpm test` (60 files, 506 passed, 9 skipped),
`pnpm --filter web build`, `audit:fields` (167 audited, 0 findings),
`audit:exports` clean.

Three tests were verified to fail against the old behaviour and pass against the
new, rather than merely asserted: the `notSafelyRemovable` case, and both
`carryPresetEdges` cases. The export audit earned its keep here — it caught the
client re-implementing two walks the server already exported.

### Left open

- **Neon dev/main has NOT been migrated.** The migration drops two columns
  holding real data. Local `ai_estimation`, local `ai_estimation_test` and Neon
  test (the e2e database) are all done. Needs a go-ahead before it runs against
  dev/main, even though the presets there are being discarded.
- Not merged or pushed.
- The other preset-rework sections (AEH-243/245/246 and §5) each still want
  their own migration against a table that is still moving. Worth deciding
  whether they land as one reshape — raised, not settled.

## Databases

    local docker  ai_estimation        26 migrations
    local docker  ai_estimation_test   26 migrations
    Neon test     (ep-wild-heart)      26 migrations
    Neon dev/main (ep-polished-credit) 25 migrations  ⚠️ BEHIND — AEH-242 not applied

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
