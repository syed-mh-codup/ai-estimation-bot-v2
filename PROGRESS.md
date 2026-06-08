# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-06-08 — Full Run pipeline wired (stub-proven) + costed Menu Card UI + taxonomy. AI-testing-ready pending OpenRouter credits._

## ⚡ Ready for AI testing the moment credits land

The whole estimate pipeline is wired and proven offline with a stub LLM. When credits are added
(https://openrouter.ai/settings/credits):
1. `docker compose up -d` · `pnpm --filter @repo/db db:seed && pnpm --filter @repo/db db:seed:presets && pnpm --filter @repo/db db:seed:taxonomy`
2. `pnpm run dev` → http://localhost:3000 · log in `admin@codup.co` / `admin1234`
3. Open an estimate (or create one) → **Run estimate** → costed Menu Card renders (narrative,
   assumptions, complexity, per-role + grand totals).
4. Fine-tune: **Prompts admin** → edit any of the 9 agent prompts → Save (new active version) →
   re-run the estimate → compare. The run loads the ACTIVE prompt version of each agent.

Pre-credits, clicking Run shows a graceful "Run failed: …402…" banner — that error IS the proof the
wiring is correct and only awaiting money. What the stub proves: wiring (prompt-load → agent-exec →
parse → persist → render). What it does NOT prove: prompt quality or that REAL LLM output parses
against the Zod schemas — that's exactly what the credit window is for.

## Where we are

- **WS21-01** ✅ App shell: role-aware nav + shadcn theme + admin stubs.
- **WS21-02** ✅ Dashboard lists estimates (title/status/owner/created) → row click opens `/estimates/[id]` detail.
- **WS22-01** ✅ `/estimates/new` form (title + SOW) → server action creates DRAFT → redirects to detail.
- **WS24-01** ✅ Users admin (`/admin/users`): list + toggle role. **Live role invalidation** — the `jwt` callback in `auth.ts` (Node) re-reads role from DB each request, so a role change takes effect on the target's session after a plain reload (no re-login). **Self-demote guard** — acting admin's own demote button disabled + action refuses it.
- **WS24-02** ✅ MCP connectors admin (`/admin/mcp`): add → test → enable/disable. **Test is now LIVE** — `LiveMcpProvider` (packages/providers, official `@modelcontextprotocol/sdk`, Streamable HTTP/SSE) actually connects + lists tools; banner shows tools or error. Credential-free (MCP ≠ LLM).
- **WS1-10** ✅ Preset library: 45 presets seeded (`db:seed:presets`). Taxonomy derived + presets linked (`db:seed:taxonomy`: 6 categories, 31 leaf nodes). `embedding` still null (needs credits). DataVolume None/Medium/High → NONE/LOW/HIGH (ordinal).
- **WS22-02** ✅ Run pipeline: `runEstimate()` (packages/agents/run-estimate.ts) orchestrates Librarian→(Archivist)→Complexity→Specialists→Taxation→Architect→Rollup → persists a costed Menu Card. Stub-proven offline (run-estimate.test.ts) + verified against real seeded data + real-provider-402. Web: estimate detail has **Run estimate** button + results + graceful error. Archivist RAG gated behind `embeddingProvider`.
- **WS24-03** ✅ Presets admin (`/admin/presets` + `/admin/presets/[id]`): browse 45 presets, edit → new active version (transactional), version history + field-level diff.
- **WS26-01** ✅ Sample SOW fixtures (`@repo/shared` SAMPLE_SOWS: simple/integration/legacy) with expected complexity bands (agents/fixtures.test.ts) — seeded as DRAFT estimates ready to Run.
- **WS25-03** ✅ (already covered) versioning invariants — single-active/immutability/pin reproducibility in core `versioning.test.ts` (WS6-01/02/03); new admin versioning paths covered by their e2e.
- **WS28-02** ✅ One-command setup: root `pnpm db:setup` (migrate + seed all) / `pnpm db:seed` (chained); `docs/SETUP.md` runbook.
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
- **MCP**: add a connector with a real MCP URL → Test → banner shows connected tools (or the error). Try a Shopify storefront MCP: `https://<store>.myshopify.com/api/mcp`.
- **Prompts**: open LIBRARIAN → edit body → Save → version bumps, history grows.

## OpenRouter status (2026-06-08)

Key is in `apps/web/.env.local` (`OPENROUTER_API_KEY`). `GET /key` shows a $20 *limit* but
actual calls return **402 Insufficient credits** — the account has no loaded balance. So
chat (agent pipeline) AND embeddings are blocked until credits are added at
https://openrouter.ai/settings/credits. (NOTE: the `limit_remaining` field is a spend cap,
not balance — don't trust it; the smoke test is the truth.) MCP does NOT use OpenRouter.

## Gated on OpenRouter CREDITS (wiring done — just needs balance)

- **Run estimate** — wired + stub-proven; clicking Run pre-credits shows the 402 banner.
- **Preset embeddings** (WS1-10 step 6) → enables Archivist RAG. NOTE: Prisma can't write the
  `Unsupported("vector")` column via the typed client — use raw SQL `::vector` (`vectorToSql` in
  `packages/db/src/vector.ts`). Smoke-test ONE embedding before looping 45 (OpenRouter embedding
  routing is unproven). Then pass an `embeddingProvider` into `runEstimate` to turn on Archivist.

## Still open

- Credential-free: **WS25-01/02** (coverage passes to ≥90% on core engines / providers — pure QA
  metric work). **Detective** (external MCP/search) not yet in the run path (findings `[]`).
- Credit-gated: preset **embeddings** → Archivist RAG; **WS26-02/03** full-pipeline + validation-gate
  e2e; **WS27** determinism/cache evals.
- Deploy: **WS28-01/03/04** (prod env/secrets, deploy target, post-deploy smoke).

## DoD status

`pnpm --filter web exec playwright test` → **17/17 pass**; agents **115/115**; providers **22/22**.
Run pipeline proven offline (`run-estimate.test.ts`) + against real seeded data + real-provider 402.
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
