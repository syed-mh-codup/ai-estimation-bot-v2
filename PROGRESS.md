# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-06-07 — WS24-01 COMPLETE. 11/11 e2e pass. Login restyled; auth made port-agnostic (trustHost)._

## Where we are

- **WS21-01** ✅ App shell: role-aware nav + shadcn theme + admin stubs.
- **WS21-02** ✅ Dashboard lists estimates (title/status/owner/created) → row click opens `/estimates/[id]` detail.
- **WS22-01** ✅ `/estimates/new` form (title + SOW) → server action creates DRAFT → redirects to detail.
- **WS24-01** ✅ Users admin (`/admin/users`): lists users; admin toggles a user's role via server action (re-checks admin via `requireAdmin()`, `revalidatePath`). Role change shows on list immediately; target user's SESSION updates on next login (JWT bakes role at login — see auth.config callbacks).
- **Login restyle** ✅ `/login` now matches the app (centered card, styled inputs, loading state). h1 = "AI Estimation".
- **Auth port-agnostic** ✅ `trustHost: true` in `auth.config.ts`; removed hardcoded `AUTH_URL`/`NEXTAUTH_URL` from `apps/web/.env.local`. Origin derived per-request → works on 3000 (manual) and 3001 (e2e); fixed the incognito "redirects to 3001" bug.
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

`pnpm --filter web exec playwright test` → **11/11 pass**
(3 auth + 4 role-shell + 2 list/detail [WS21-02] + 1 create [WS22-01] + 1 users-admin [WS24-01]).
apps/web typecheck: only the 5 **pre-existing** TS2742 errors in `auth.ts`/`middleware.ts`
(next-auth v5 beta inference — tsc-only, do NOT block `next dev`). Zero new errors introduced.

## Key facts / gotchas

- Manual dev port **3000**; Playwright webServer port **3001**. DB **5433** (docker-compose, pgvector pg16).
- `Estimate.configVersion` is required → an active `EstimationConfig` must exist before any estimate can be created (seed + e2e global-setup both ensure one).
- e2e global-setup (`apps/web/e2e/global-setup.ts`) seeds e2e users + config + one fixed estimate (`e2e-seed-estimate`).
- Create action does NOT import `@repo/core` (its `versioning.ts` has pre-existing Prisma JsonValue type errors that would pollute web typecheck) — it queries the active config directly.
- Routes with Nav: `/dashboard`, `/admin/*`, `/estimates/*` each have a layout rendering `<Nav/>`.
- Branch: `master` (PRs target `main`). `.claude/settings.json` is untracked (permission allowlist from /fewer-permission-prompts) — intentionally not committed with WS slices.

## NEXT WORKSTREAMS

- **WS22-02** — "Run estimate" trigger + live progress. depends WS22-01 (done), WS8-04.
  **BLOCKED on OpenRouter credential** (routes through supervisor → model provider). This is the
  provisioning ask to give the user before wiring the run end-to-end.
- Credential-free admin flows still open: **WS24-02** (MCP connectors), **WS24-03** (Presets),
  **WS24-04** (Config), **WS24-05** (Prompt admin link). Any is a next testable flow without a key.

## Next action on resume

WS24-01 committed. For the run pipeline (WS22-02) ask the user for an OpenRouter key. Otherwise
continue with another WS24 admin flow (all credential-free, same pattern as WS24-01).
