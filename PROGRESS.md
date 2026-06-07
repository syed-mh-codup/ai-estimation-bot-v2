# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-06-07 — WS24-01/02/04/05 COMPLETE. 16/16 e2e pass. Live role invalidation + self-demote guard added._

## Where we are

- **WS21-01** ✅ App shell: role-aware nav + shadcn theme + admin stubs.
- **WS21-02** ✅ Dashboard lists estimates (title/status/owner/created) → row click opens `/estimates/[id]` detail.
- **WS22-01** ✅ `/estimates/new` form (title + SOW) → server action creates DRAFT → redirects to detail.
- **WS24-01** ✅ Users admin (`/admin/users`): list + toggle role. **Live role invalidation** — the `jwt` callback in `auth.ts` (Node) re-reads role from DB each request, so a role change takes effect on the target's session after a plain reload (no re-login). **Self-demote guard** — acting admin's own demote button disabled + action refuses it.
- **WS24-02** ✅ MCP connectors admin (`/admin/mcp`): add → test (stub sets `lastTestOk`) → enable/disable.
- **WS24-04** ✅ Config admin (`/admin/config`): edit % + JSON → new active `EstimationConfig` version (transactional, single-active preserved).
- **WS24-05/WS7-03** ✅ Prompts admin (`/admin/prompts` + `/admin/prompts/[kind]`): edit body/model → new active `PromptVersion` (transactional) + version history.
- **Login restyle** ✅ `/login` matches the app (centered card, styled inputs, loading state). h1 = "AI Estimation".
- **Auth port-agnostic** ✅ `trustHost: true` in `auth.config.ts`; no hardcoded `AUTH_URL`/`NEXTAUTH_URL`. Origin derived per-request → works on 3000 (manual) and 3001 (e2e); fixed the incognito "redirects to 3001" bug.
- **Bootstrap seed** ✅ `packages/db/src/seed.ts` (`pnpm --filter @repo/db db:seed`) — idempotent: admin+estimator users, active config v1, 2 estimates, LIBRARIAN+ARCHITECT prompts.

## ✅ Manually testable end-to-end (no external credentials needed)

Flows: **login → dashboard list → open detail**; **new → create draft → detail → list**;
**admin → Users / Config / MCP / Prompts** (each a full CRUD/versioning flow).

**To boot manually:**
1. Postgres must be up: `docker compose up -d` (pg on host **5433**).
2. Seed: `pnpm --filter @repo/db db:seed` (idempotent).
3. Dev server: `pnpm run dev` → **http://localhost:3000** (Playwright uses 3001; manual is 3000).
4. Log in: **admin@codup.co / admin1234** (ADMIN) or **estimator@codup.co / estimator1234** (ESTIMATOR).

### What an admin can test now
- **Users**: flip a user's role; note your own demote button is disabled. (Live invalidation: log a 2nd user in elsewhere, change their role, they reload → nav updates without re-login.)
- **Config**: change a % or JSON, Save new version → version badge bumps.
- **MCP**: add a connector → Test (status OK) → Enable.
- **Prompts**: open LIBRARIAN → edit body → Save → version bumps, history grows.

## NOT yet built (needs provisioning when we get there)

- **WS22-02** "Run estimate" (agent pipeline) — this is the ONLY near-term piece that needs **OpenRouter API key** (+ embeddings). Not blocked on it for the flow above.
- Full preset-library seed (WS1-10) — xlsx import of 45 presets + embeddings. Current seed is a minimal bootstrap only.

## DoD status

`pnpm --filter web exec playwright test` → **16/16 pass**
(3 auth + 4 role-shell + 2 list/detail [WS21-02] + 1 create [WS22-01] + 3 users-admin [WS24-01:
list/self-demote/live-invalidation] + 1 config [WS24-04] + 1 mcp [WS24-02] + 1 prompts [WS24-05]).
apps/web typecheck: only the 5 **pre-existing** TS2742 errors in `auth.ts`/`middleware.ts`
(next-auth v5 beta inference — tsc-only, do NOT block `next dev`). Zero new errors introduced.

## Key facts / gotchas

- Manual dev port **3000**; Playwright webServer port **3001**. DB **5433** (docker-compose, pgvector pg16).
- `Estimate.configVersion` is required → an active `EstimationConfig` must exist before any estimate can be created (seed + e2e global-setup both ensure one).
- e2e global-setup (`apps/web/e2e/global-setup.ts`) seeds e2e users + config + one fixed estimate (`e2e-seed-estimate`).
- Create action does NOT import `@repo/core` (its `versioning.ts` has pre-existing Prisma JsonValue type errors that would pollute web typecheck) — it queries the active config directly.
- Routes with Nav: `/dashboard`, `/admin/*`, `/estimates/*` each have a layout rendering `<Nav/>`.
- Branch: `master` (PRs target `main`). `.claude/settings.json` is untracked (permission allowlist from /fewer-permission-prompts) — intentionally not committed with WS slices.

## Versioning admin pattern (used by Config + Prompts; reuse for Presets)

Inline the version bump in the server action (do NOT import `@repo/core` — its `versioning.ts`
has Prisma JsonValue type errors that pollute web typecheck): find max version → `$transaction`
[`updateMany active:false`, `create version=max+1 active:true`] → `revalidatePath`. e2e global-setup
must delete+recreate the versioned rows each run so version-number assertions stay deterministic.

## NEXT WORKSTREAMS

- **WS22-02** — "Run estimate" trigger + live progress. depends WS22-01 (done), WS8-04.
  **BLOCKED on OpenRouter credential** (routes through supervisor → model provider). User's devops
  team to provision the key (expected ~2026-06-08). This is the provisioning ask before wiring run.
- **WS24-03** Presets admin — browse/edit/version/activate/history. Deferred: needs real preset
  data (WS1-10 xlsx import of 45 presets). Same versioning pattern as Config/Prompts once data exists.

## Next action on resume

Admin flows (Users/Config/MCP/Prompts) all committed + tested. For the run pipeline (WS22-02) use
the OpenRouter key once provisioned. WS24-03 (Presets) is the remaining credential-free flow but
wants the preset library seeded first.
