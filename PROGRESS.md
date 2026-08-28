# PROGRESS

Session continuity only — what a fresh session needs to pick up where this one
stopped. **Not a record of completed work:** that lives in the Jira ticket, and
durable environment lessons live in the project memories. Prune it when a ticket
closes.

On resume: read this, then `git status` and `git log --oneline -5`.

---

## Current: AEH-259 — Oracle

Branch `feat/aeh-259-oracle` off `master` at `9e3c9fa`. Ticket is In Progress.
**The approved plan is the spec — read it first:**
`~/.claude/plans/crispy-skipping-pony.md`

Three workstreams under one ticket, commits scoped per workstream:

1. **Oracle** — read-only chat over one estimate's corpus, floating notch/FAB on
   `/estimates/[id]`, SSE streaming, persisted threads, citation jump into `#sow`.
2. **Model dropdown** — `/admin/prompts` model field becomes a searchable list of
   live OpenRouter models instead of free text.
3. **Agent catalogue** — one `AGENT_CATALOGUE` in `packages/db`, describing every
   agent and grouping them by track (run crew / supplemental / reference).

## Done so far

- Branch created, AEH-259 → In Progress.
- **AEH-283 filed** (supervisor review) and linked "relates to" AEH-259. Explicitly
  NOT built here — the user is dealing with the supervisor separately.
- Scoping amendments posted as a comment on AEH-259 (comment 106401), read back
  and verified clean.

## Next step

Nothing committed yet. Start at plan §11 (`packages/db/src/agent-catalogue.ts`),
because it collapses the four hardcoded `AgentKind` arrays and every later step
adds `ORACLE` through it.

## The three corrections that drove the plan

The ticket description predates the tree on all three; verified, not assumed.

- **`Estimate.sowHash` is gone** (dropped in `20260827040000` with the cache
  layer). Hash `sowText` at message-write time and store it on the message.
- **`promptVersionsPinned` is gone.** Nothing pins prompt versions, for any agent.
- **`coversRiskFlags` is never persisted** — `specialist.ts` produces it,
  `audit.ts:87` consumes it in memory, then it is discarded. Fix: add
  `claimedRiskFlags` to the `agentState` literal at `run-estimate.ts:459-467`
  (and the `RunDiagnostics` type at `:110-126`, and the persisted-key-set
  assertion at `run-estimate.test.ts:270-280`).

## Traps that will bite this ticket specifically

- **`pnpm --filter web build` is the only real check.** Typecheck, lint and the
  whole unit suite are blind to a `'use server'` module exporting a non-async
  function. Hence `oracle-actions.ts` (actions only) vs `oracle-dto.ts` (mappers).
- **Never run `pnpm db:seed`** to install Oracle's prompt — `seed.ts:168-183`
  deactivates every active `PromptVersion` and overwrites v1's body. Use the new
  targeted `pnpm db:seed:oracle`.
- **Field audit is a vitest test**, so a new column nothing *reads* is a red
  build. The `/admin/oracle` surfaces are the readers for the token columns.
- **Oracle must mount OUTSIDE `LedgerProvider`** — it is keyed at `page.tsx:191`
  on the joined item ids, so `router.refresh()` after a run remounts that whole
  subtree and would wipe an open conversation. In-ledger entry points reach it by
  `window` CustomEvent, the `CollapseAllButton.tsx:7` idiom.
- **The 5s expect budget.** `/estimates/[id]` is the heaviest route; the first
  Oracle assertion in e2e needs `{ timeout: COLD_COMPILE }`.

See the memories `next-build-is-the-only-real-check`, `e2e-suite-notes`,
`local-dev-env-traps`.
