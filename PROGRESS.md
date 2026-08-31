# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: nothing in flight

**AEH-244 (preset concern split) is CLOSED, DOCUMENTED and COMMITTED.** Two
commits on `feat/aeh-244-preset-concern-split`: `8a64279` (the split) and
`21d6eb0` (versioning the retrieval surface and composition rules, plus the
hardening). The implementation record — what shipped, why, the trap worth
remembering and the verification actually performed — is in AEH-244's
description and comment, not here.

Not yet done: the branch is **not merged and not pushed**. That is the only
outstanding action on this work.

## Databases

All four are at 23 migrations, including the three AEH-244 ones. Verified: zero
orphaned rows, and on Neon dev/main all 45 presets searchable with a non-null
vector on every active version.

    local docker  ai_estimation        23 migrations
    local docker  ai_estimation_test   23 migrations
    Neon test     (ep-wild-heart)      23 migrations
    Neon dev/main (ep-polished-credit) 23 migrations

⚠️ Still true from AEH-259: seed Neon dev/main with targeted scripts only, never
`pnpm db:seed`. It carries hand-tuned prompts at v3 and v4 whose text exists
nowhere in the repo, and the bootstrap seed would revert all nine to their
two-sentence v1 bodies.

## Related tickets

**AEH-282** — the e2e suite. Open, and the reason AEH-244's e2e specs were
migrated but never executed. Re-run `admin-presets.spec.ts` once it is healthy:
it is the test that proves an admin save does not de-index a preset.

**AEH-242 / AEH-243** — sections 2 and 3 of the preset rework, both unblocked by
AEH-244. The anchor now has its own table and id, so AEH-243's costed-work
question is answerable.

**AEH-283** — review and fix the Supervisor. Filed, not built; the user is
handling it separately.

## Traps worth keeping

- A schema split turns one atomic row insert into N writes. Wrap every
  multi-table write in a `$transaction` — a half-written version made presets
  vanish from search and 404 the editor.
- Deleting a "why" comment deletes the reason a guard exists. AEH-244 removed a
  de-indexing guard with its comment when it became unnecessary, then
  reintroduced the hazard a pass later with nothing left to warn it.
- `pnpm -r typecheck` stops at the first failing package, which masked eight
  real errors in `apps/web` for a whole pass. A green partial run is not green.

See the memories `next-build-is-the-only-real-check`, `e2e-suite-notes`,
`local-dev-env-traps`, `audit-gates-invocation`.
