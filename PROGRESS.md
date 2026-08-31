# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-244 — preset concern split, second pass

**Status: complete and green, UNCOMMITTED.** Commit `8a64279` holds the first
pass (the original three-way split). Everything after it is working-tree only,
including the migration `20260831080000_version_retrieval_and_composition`,
which is **already applied to all four databases**. If this tree is lost, four
`_prisma_migrations` tables reference a file that exists nowhere. Commit first,
before anything else.

### What the second pass changed, and why

The first pass made `PresetRetrieval` and `PresetComposition` one-row-per-preset.
That silently removed version history from `name`, `description`, `keywords`,
`requires`, `blocks` and `canParallel` — the editor still promised "Nothing is
overwritten", and `diffVersions` still listed `name`/`keywords` while feeding
both sides the same row, so those comparisons could never fire.

Both are now **one row per version**, like `PresetAnchor`. And the retrieval
surface is **self-contained**: `notes` and `userStoryTags` moved off the anchor
onto retrieval, so all five fields `presetEmbeddingText` concatenates live on the
row whose vector they produce. No join to compute a row's own embedding text.

### The trap this ticket sprang twice

Per-version retrieval puts the embedding back on a per-version row, so a version
bump that does not carry the vector forward leaves the new active version with
`embedding IS NULL`. `findNearestPresets` filters on `embedding IS NOT NULL` for
the active version, so the preset silently drops out of Archivist retrieval — no
error, it just stops matching. Master had guarded this with a raw-SQL copy inside
the admin save's transaction; the first pass deleted that (along with the 26-line
comment explaining it) because a per-preset vector made it unnecessary, and the
second pass reintroduced the hazard without restoring the guard.

Now closed by `carryPresetVector` in `packages/db/src/vector.ts`, called by all
three writers — `savePreset`, `promoteMenuItemsToPresets`, `recordActuals` — each
inside its own transaction. `embeddingText` rides along unchanged on purpose:
that mismatch is what marks the vector stale for the backfill. A stale vector
keeps the preset findable; no vector makes it vanish.

Two tests in `writeback-promote.test.ts` guard it, and were verified to FAIL with
the carry disabled — not trivially-passing tests.

## Verified

    pnpm typecheck                            clean
    pnpm lint                                 clean
    pnpm test                                 54 files, 437 passed, 9 skipped
    pnpm --filter @repo/audit audit:fields    161 audited, 2 exempt, 0 findings
    pnpm --filter @repo/audit audit:exports   clean
    pnpm --filter web build                   exit 0
    pnpm test:e2e                             NOT RUN — see below

The e2e specs and `global-setup.ts` were migrated to the per-version shape but
never executed: AEH-282 is open against the suite and the user asked not to
chase it. `admin-presets.spec.ts` is the file that would prove a save does not
de-index a preset, so that specific guarantee rests on the two unit tests above,
not on e2e.

## Databases — all four migrated and verified

    local docker  ai_estimation        23 migrations, 51 presets
    local docker  ai_estimation_test   23 migrations
    Neon test     (ep-wild-heart)      23 migrations, 46 presets
    Neon dev/main (ep-polished-credit) 23 migrations, 45 presets

On dev/main — the real library — all 45 presets are searchable: every active
version has an anchor, a retrieval row, a composition row and a non-null vector,
with zero orphans. `notes`/`userStoryTags` are gone from `PresetAnchor` on all
four.

⚠️ Retrieval history starts now, not retroactively. The re-key gave a retrieval
row only to each preset's active (or latest) version, so older versions have no
retrieval row and their `notes`/`userStoryTags` are not recoverable. Harmless
here — dev/main is 45 presets / 45 versions, and the test DBs are seed-rebuilt —
but the editor's `previous.retrieval` guard is load-bearing for older presets.

## Next steps

- [ ] **Commit.** Nothing else should happen first.
- [ ] Run the e2e suite once AEH-282 has it healthy again.
- [ ] AEH-244 is still In Progress in Jira — no transition was agreed.

## Also fixed in passing

- `ws9.test.ts` seeded its vectors with `WHERE "presetVersionId" = <retrieval id>`
  — a mixed pairing that matched zero rows, so those embeddings never landed.
  Now `WHERE id`.
- `savePreset` lost TS narrowing inside the transaction closure (property
  narrowing does not survive a callback); the three rows are hoisted into locals.
- `packages/audit/src/prisma-schema.test.ts` asserted `notes`/`userStoryTags` on
  `PresetAnchor`; both moved to `PresetRetrieval`.
- Restored the `writeback-promote.test.ts` AEH-227 comment block, deleted in the
  first pass and unrelated to this ticket.

## Related tickets

**AEH-282** — the e2e suite. Open, and the reason the specs were not re-run.
**AEH-242 / AEH-243** — sections 2 and 3, which this unblocks. The anchor has its
own table and id, so the costed-work question in AEH-243 is now answerable.

## Traps this ticket proved

- A schema split turns one atomic row insert into N writes. Both pipeline writers
  had a version->anchor gap where an active version existed with no anchor, which
  made the preset vanish from search and 404 the editor. Every multi-table write
  is in a `$transaction` now.
- Deleting a "why" comment deletes the reason a guard exists. The de-indexing
  guard was removed with its comment when it became unnecessary, and nothing was
  left to warn the next change that reintroduced the hazard.
- `pnpm -r typecheck` stops at the first failing package. `@repo/agents` failing
  masked eight real errors in `apps/web` for a whole pass.

See the memories `next-build-is-the-only-real-check`, `e2e-suite-notes`,
`local-dev-env-traps`, `audit-gates-invocation`.
