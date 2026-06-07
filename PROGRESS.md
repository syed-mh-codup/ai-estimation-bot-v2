# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-06-07 — WS21-02 + WS22-01 COMPLETE. 10/10 e2e pass. Bootstrap seed added._

## Where we are

- **WS21-01** ✅ App shell: role-aware nav + shadcn theme + admin stubs.
- **WS21-02** ✅ Dashboard lists estimates (title/status/owner/created) → row click opens `/estimates/[id]` detail.
- **WS22-01** ✅ `/estimates/new` form (title + SOW) → server action creates DRAFT → redirects to detail.
- **Bootstrap seed** ✅ `packages/db/src/seed.ts` (`pnpm --filter @repo/db db:seed`) — idempotent: admin+estimator users, active EstimationConfig v1, 2 sample estimates. Real unblock for manual UI testing (DB starts empty).

## ✅ The app is now manually testable end-to-end (no external credentials needed)

Flow: **login → dashboard list → open detail**, and **new → create draft → detail → back in list**.

**To boot manually:**
1. Postgres must be up: `docker compose up -d` (pg on host **5433**, already running this session).
2. Seed: `pnpm --filter @repo/db db:seed` (idempotent).
3. Dev server: `pnpm --filter web dev` → defaults to **http://localhost:3000** (NOTE: Playwright uses 3001; manual `next dev` is 3000).
4. Log in: **admin@codup.co / admin1234** (ADMIN) or **estimator@codup.co / estimator1234** (ESTIMATOR).

## NOT yet built (needs provisioning when we get there)

- **WS22-02** "Run estimate" (agent pipeline) — this is the ONLY near-term piece that needs **OpenRouter API key** (+ embeddings). Not blocked on it for the flow above.
- Full preset-library seed (WS1-10) — xlsx import of 45 presets + embeddings. Current seed is a minimal bootstrap only.

## DoD status

`pnpm --filter web exec playwright test` → **10/10 pass**
(3 auth + 4 role-shell + 2 list/detail [WS21-02] + 1 create [WS22-01]).
apps/web typecheck: only the 5 **pre-existing** TS2742 errors in `auth.ts`/`middleware.ts`
(next-auth v5 beta inference — tsc-only, do NOT block `next dev`). Zero new errors introduced.

## Key facts / gotchas

- Manual dev port **3000**; Playwright webServer port **3001**. DB **5433** (docker-compose, pgvector pg16).
- `Estimate.configVersion` is required → an active `EstimationConfig` must exist before any estimate can be created (seed + e2e global-setup both ensure one).
- e2e global-setup (`apps/web/e2e/global-setup.ts`) seeds e2e users + config + one fixed estimate (`e2e-seed-estimate`).
- Create action does NOT import `@repo/core` (its `versioning.ts` has pre-existing Prisma JsonValue type errors that would pollute web typecheck) — it queries the active config directly.
- Routes with Nav: `/dashboard`, `/admin/*`, `/estimates/*` each have a layout rendering `<Nav/>`.
- Branch: `master` (PRs target `main`). `.claude/settings.json` is untracked (permission allowlist from /fewer-permission-prompts) — intentionally not committed with WS slices.

## NEXT WORKSTREAM: WS22-02 — "Run estimate" trigger + live progress (agent step states)
depends: WS22-01 (done), WS8-04. **Needs OpenRouter credential to actually run.**

## Next action on resume

WS21-02 + WS22-01 are committed. If continuing: WS22-02 needs an OpenRouter key — ask the user
to provision it before wiring the run trigger end-to-end.
