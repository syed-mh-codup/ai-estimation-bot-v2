# Progress (session continuity only)

_No backlog or completion state here — that lives in Jira. This file is
just working notes for whatever's in flight right now._

## Current session

Nothing in flight.

Last shipped: AEH-226 (merged to master, CI run 32479730964 — test job green).
The WBS ⇄ preset round-trip guard lives in
`packages/agents/src/wbs-preset-round-trip.test.ts`; CI is now three
independent jobs so that guard reports on its own merits.

Two things to know before picking anything up:

- **lint and typecheck are red on master** — 18 and 47 pre-existing errors,
  all inventoried in AEH-248. The test job is green and independent. Two of
  three red is recorded debt, not a regression.
- **A bare `pnpm --filter @repo/db exec prisma migrate deploy` targets Neon**,
  not local — `packages/db/.env` points there and Prisma loads it. Root
  `db:setup` has the same reach. Pass `DATABASE_URL`/`DIRECT_URL` explicitly,
  the way `scripts/setup-test-db.sh` does.

The loop asymmetries found while mapping AEH-226 (QA/PM/BA dropped on
promotion, per-card promote vs per-requirement anchor, the inert
`baseline-*` guard, orphaned `perItemMultipliers`) are recorded in the
AEH-226 Jira comment.
