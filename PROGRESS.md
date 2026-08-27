# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: nothing in flight

**AEH-253 (clear the orphan register) is CLOSED and PUSHED.** Both remotes at
`a1b21a0`; 18 commits, `8546214..a1b21a0`. The implementation record — what
changed, why, and the findings worth keeping — is in AEH-253's description and
comments, not here.

Follow-ups filed and linked: **AEH-276** (post-delivery actuals loop),
**AEH-277** (field-audit attribution defect), **AEH-278** (runEstimate has no
cache).

## Verified state at that commit

    pnpm audit:fields         0 findings, 2 exempt (PresetVersion beHours/feHours)
    pnpm audit:exports        clean — 3 baseline entries, each reasoned
    pnpm test                 48 files, 346 passed, 0 failed
    pnpm --filter web build   exit 0 — every route compiles
    typecheck, lint           clean

Migration `20260827040000` is applied to all four databases (Neon dev/main, local
docker `ai_estimation`, local docker `ai_estimation_test`, Neon test). Presets
re-embedded on Neon dev/main only — the other three have never been embedded at
all, which predates this work.

## Outstanding

- [ ] **One e2e spec fix is UNCOMMITTED.** `apps/web/e2e/estimates-create.spec.ts`
      line 24 — a fourth instance of the expect-budget trap below, on
      `/estimates/new`, a route this ticket never touched. The three earlier
      instances are committed in `a1b21a0`.
- [ ] Full e2e re-run to confirm 40/40, then commit that fix and push.
- [ ] AEH-253 close-out comment drafted but NOT posted — the draft is in this
      session's scratchpad as `aeh-253-comment.txt`, already checked against the
      `jira-text` comment constraints. Post with `jira_add_comment`, then read it
      back and diff.

## The one trap to know before touching the e2e suite

`expect(...).toHaveURL / toHaveText / toHaveValue` use Playwright's **5s expect
budget**, not the 60s per-test budget. Any such assertion on the first test to
touch a route pays that route's cold compile and fails, while every later test
passes because the first one warmed it. Four specs needed
`{ timeout: COLD_COMPILE }`.

Everything else worth carrying from this work is in the memories:
`next-build-is-the-only-real-check`, `e2e-suite-notes`, `local-dev-env-traps`.
