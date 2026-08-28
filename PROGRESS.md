# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-259 (Oracle) is DONE, but NOT PUSHED

Branch `feat/aeh-259-oracle`, off `master` at `9e3c9fa`. Working tree clean. Ticket closed. Pushing is still the user's call — nothing has left this
machine.

    git log --oneline master..feat/aeh-259-oracle

Three workstreams shipped, one commit per concern: Oracle itself, the
`/admin/prompts` model dropdown, and the agent catalogue.

## Verified

    pnpm typecheck                            clean
    pnpm lint                                 clean
    pnpm test                                 54 files, 429 passed, 9 skipped
    pnpm --filter @repo/audit audit:fields    161 audited, 2 exempt, 0 findings
    pnpm --filter @repo/audit audit:exports   clean
    pnpm --filter web build                   exit 0
    pnpm test:e2e                             48/48 — see the caveat below

⚠️ The e2e figure was measured at `959dea7`, one commit before the assumption
change. It has NOT been re-run since, on purpose: AEH-282 is open against the
suite and the user asked not to chase it. The `oracle.spec.ts` test covering
the suggested-assumption block has therefore never been executed. The
assumption behaviour was instead verified by the user driving it in the browser
against the real model, which is the check that mattered — whether Sonnet
actually emits the marker.

Plus live runs against the real model on the local DB: quote-then-explain,
a refusal that named the gap instead of guessing, ephemeral info correctly
declared as conversation-only with assumption wording offered, three citations
stored and all three verbatim, resolved model + tokens + real cost recorded
(~$0.019 for three turns), and the quote jump highlighting the right span. The
suggested-assumption block was confirmed separately by the user in the browser
after the marker was added.

⚠️ `pnpm audit` and `pnpm run audit` BOTH hit pnpm's built-in security audit,
not the repo's gates. Use the filtered form above. (The gates also run inside
`pnpm test`, so a green `pnpm test` already covers them.)

## Databases

Migration `20260828000000_oracle` is applied to the local docker
`ai_estimation`, the local `ai_estimation_test`, and the **Neon test** branch.

**NOT applied to Neon dev/main** — that is the shared dev database and nothing
in this session touched it. Before running the app against Neon:

    DATABASE_URL=<neon> DIRECT_URL=<neon> pnpm --filter @repo/db exec prisma migrate deploy
    pnpm db:seed:oracle      # NEVER pnpm db:seed — it reverts every live prompt

## Next steps

- [ ] Push, open a PR, or merge — not done, awaiting the user.
- [ ] Apply the migration + `db:seed:oracle` to Neon dev/main when deploying.
- [ ] Run the Oracle e2e specs once AEH-282 has the suite healthy again.

## Related tickets

**AEH-282** — the e2e suite. Open, and the reason the Oracle specs were not
re-run at tip.

## Filed, not built

**AEH-283** — review and fix the Supervisor. Its prompt is never loaded at
runtime and its gates warn rather than block. AEH-259 only LABELS it, in the
catalogue's REFERENCE track. The user is handling it separately.

## Traps this ticket proved

- `pnpm --filter web build` caught a client component pulling `@repo/agents`
  through to googleapis and `node:fs`; typecheck was clean. The pure citation
  logic lives in `@repo/shared` for exactly this reason.
- Three defects survived typecheck, lint and 429 unit tests and were only found
  by reading the diff: a `useCallback` that memoised nothing, an empty-thread
  fetch loop, and an SSR/client hydration mismatch invisible on Linux. See
  commit `50eb05e`.
- A PRE-EXISTING full-suite flake (run-estimate and evals both replacing the
  active EstimationConfig) is fixed with a Postgres advisory lock. Racing lines
  are verbatim on master; this branch's extra test files just widened the window.

See the memories `next-build-is-the-only-real-check`, `e2e-suite-notes`,
`local-dev-env-traps`.
