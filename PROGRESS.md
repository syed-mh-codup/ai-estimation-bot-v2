# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-07-08 — `feat/honor-prompts-4h-decomposition` DONE (all 10 phases). Prompt/code drift closed and live-verified against a real OpenRouter run: DEV line items are now real ≤4h decomposed units (not flat 30h), narrative is a genuine 8-sentence story, 45 presets are embedded. Not yet merged to master. See below._

## 2026-07-08 — honor-prompts-4h-decomposition: COMPLETE

**Outcome:** every phase (1–10) landed as its own commit on this branch, all
133 agents tests + 19/19 e2e pass, apps/web typecheck is clean (only the 5
pre-existing next-auth TS2742 errors remain), and a **live run against the
real OpenRouter API** (not the stub) on `sow-simple` produced:
- DEV line items decomposed into 7–13 real atomic units per menu card, every
  one ≤4h (max observed 3.5h) — this is the actual fix for "every estimate
  is flat DEV=30h."
- A genuine 8-sentence cohesive narrative (not the old `"Implement X."`
  fallback).
- 41 specific, non-generic assumptions.
- The new deterministic gate-warning system correctly flagged a real
  proportionality issue (PM/BA % out of band) without blocking the run.
- Taxation preserved 0.25h granularity end to end (2h→2.5h QA, not the old
  whole-hour `Math.round`).

**What's still open** (deliberately deferred, see advisor consult below):
- The full SUPERVISOR reject-and-retry-per-stage gate loop. What's shipped
  is the honest subset — deterministic invariant checks that surface
  warnings (`agentState.gateWarnings`, server logs), not per-stage rejection
  with retry. Needs its own retry-plumbing design.
- Detective's search/MCP grounding is real but currently backed by
  `StubSearchProvider` in production unless `TAVILY_API_KEY` is set — set it
  to get real citations instead of model-only claims.
- Spike-preset mapping (P01–P06) referenced in the DETECTIVE prompt isn't
  cross-validated against the real preset IDs.
- Real-model evals (comparing against a golden/expected output) — this
  session's live run was a smoke test (does it work, is it sane), not a
  quality regression suite.

**Root cause + phase-by-phase work is preserved below** for anyone picking
this up; the plan as originally written was followed almost exactly.

## 2026-07-08 (superseded by "COMPLETE" above) — honor-prompts-4h-decomposition

**Root cause** (diagnosed prior session): `specialist.ts` asks for one number per
role instead of decomposing to ≤4h line items per the real prompts; `librarian.ts`/
`architect.ts` discard the richer envelope; `complexity.ts` is regex keyword
matching; DETECTIVE/ARCHIVIST/SUPERVISOR prompts are dead code (never wired).
Pulled the LIVE active prompts from Neon (not the seed defaults) — they specify a
full JSON envelope: controlled vocabulary (category/req_type/platform/phase/
project_size/data_volume/ai_assist/risk), requirement_id/menu_card_id/
line_item_id/risk_id/question_id conventions, a Supervisor-gated 4-stage pipeline
(Librarian → Detective+Archivist parallel → 4 Specialists parallel → Architect),
and 5 GLOBAL INVARIANTS (four-hour rule, taxonomy validity, traceability, role
independence, no padding).

**Scope decision** (per advisor consult): don't implement every clause — close the
drift on the phases that fix the actual symptoms (shallow/flat estimates), keep
schema changes minimal in DB/UI (JSON blobs + relaxed constraints, not a full
relational redesign), defer Detective/Supervisor gate-loop to last since they're
lowest value / highest effort (need search+MCP providers, retry-loop plumbing).
DB has only 4 test estimates — schema migrations are safe.

**Phase plan** (tracked as Tasks #1–#10, committing after each):
1. Rewrite `@repo/shared` Zod schemas to match the real envelope (mandatory —
   can't honor a prompt without a schema that parses what it asks the LLM to emit).
2. Prisma migration: RoleLineItem gets multiple rows per role (drop the
   `@@unique([menuItemId,role])` constraint) + `title`/`meta Json?`; MenuItem gets
   `category`/`phase`/`meta Json?`.
3. Librarian: real structured requirements (category/req_type/platforms/
   project_size/data_volume/integration_count/candidate_menu_card_id/ambiguities).
4. Specialists: LLM decomposition into ≤4h atomic line items per role — **this is
   the actual fix for DEV=30h-everywhere**.
5. Architect: one real 8–15 sentence narrative + menu-card assembly from
   Librarian's candidate cards, replacing the "Implement X." fallback.
6. complexity.ts: derive score from the richer per-requirement signals instead of
   regex keyword sniffing.
7. Archivist: per-requirement coverage full/partial/none + wire
   `embeddingProvider` into the production Inngest run + embed the 45 presets.
8. Detective + Supervisor gates — deferred to last, lowest value/effort ratio.
9. Fix `rollup.ts`/`taxation.ts`/web UI for multiple line items per role (currently
   `.find()`-assumes exactly one row per role — must become filter/sum).
10. Live-verify against a real OpenRouter run on the smallest sample SOW (not just
    the stub-LLM tests) — loud parse-failure errors during verification, since the
    old silent JSON-parse-fallback is exactly what hid this drift for so long.

Resume point: see `git log --oneline` on this branch for phases completed so far;
each phase is its own commit. Task list (TaskList) has live phase status.

## 2026-06-15 (latest) — Inngest durable jobs (serverless-ready)

Run + ingest are now durable **Inngest** functions instead of detached promises
(which die on serverless). Proven end-to-end against Neon via the Inngest dev
server: a real `sow-simple` run went Librarian→Complexity→Specialists 1–10→
Architect→Saving→**DONE** with factual per-stage status, persisting a 10-item
Menu Card. (This also finally proved REAL LLM output parses the Zod schemas.)

- `apps/web/src/lib/inngest.ts` client; `app/api/inngest/route.ts` serve endpoint
  (public in auth.config); `src/inngest/functions.ts` = `estimate-run` +
  `estimate-ingest`, each with onProgress→DB status + onFailure→FAILED.
- Triggers now emit events: `POST /run` and `/ingest-create` send Inngest events.
- Uploaded files persisted to `UploadedFile` (bytea) so the ingest function can
  read bytes after the request returns (serverless-safe). Deleted after ingest.
- **Run-pipeline fix:** the persist `$transaction` got `{ maxWait:15s, timeout:60s }`
  — Neon latency was blowing Prisma's default 5s tx timeout.
- **Test-infra fix:** agents DB-integration tests + root suite now pin
  `DATABASE_URL` to LOCAL via `vitest.setup.ts` (Prisma auto-loads packages/db/.env
  = Neon, which was making integration tests hit Neon and time out — and earlier
  polluted Neon prompts with `stub/model`; re-seed fixed it).
- pnpm gate: `protobufjs: false` in pnpm-workspace.yaml (inngest transitive dep).

**Local dev now needs two processes:** `pnpm dev` (app) + `pnpm dev:inngest`
(Inngest dev server) with `INNGEST_DEV=1` in apps/web/.env.local. **Prod (serverless):**
set `INNGEST_EVENT_KEY` + `INNGEST_SIGNING_KEY`.

## 2026-06-15 (later) — Neon + e2e isolation

- **DB is on Neon now.** App runtime → POOLED endpoint (`-pooler`, `&pgbouncer=true`);
  CLI/migrate/seed → DIRECT endpoint. Prisma datasource gained `directUrl`. Verified:
  migrate deploy + full seed (9 prompts, 45 presets, taxonomy, config) ran clean,
  pgvector installed, pooled connectivity works, app boots + `/api/health` = ok.
  Env lives in git-ignored `apps/web/.env.local` (pooled+direct) and
  `packages/db/.env` (direct). Local docker pg now only used by e2e.
- **e2e is isolated** (commit 228730e). Runs against `TEST_DATABASE_URL`
  (`ai_estimation_test` locally; can be a Neon branch). `global-setup` THROWS if it's
  unset, so it can never wipe the dev/main DB again. It seeds the SAME 9 prompts as
  prod (shared `packages/db/src/seed-prompts.ts`). `pnpm test:e2e` provisions +
  runs. Verified 19/19 in ~1min with dev DB untouched.
- **Still TODO: Inngest** — serverless deploy chosen, so detached promises MUST become
  durable Inngest functions (run + ingest) with step-level status. Needs INNGEST_EVENT_KEY
  + INNGEST_SIGNING_KEY for prod; local uses `npx inngest-cli dev`.

## 2026-06-15 session — run UX + document ingestion

OpenRouter credits landed (live chat + embeddings work now; the old 402 is gone).
Two user-driven features shipped this session:

- **Background run + reload-safe progress** (commit ab4aeb1). Run no longer blocks
  synchronously with zero feedback. `Estimate.runStatus/runStage/runPct/runError` +
  `RunStatus` enum; `runEstimate` takes an `onProgress(stage,pct)` hook; `POST
  /api/estimates/[id]/run` fires it in the background (guards double-run) and `GET
  .../status` is polled by the `RunControls` client component — button disabled
  while RUNNING, live stage + bar, refreshes into the Menu Card on done. Survives a
  hard reload (all state DB-backed).
- **Multimodal ingestion**. `/estimates/new` now accepts PDF / DOCX / images
  (png/jpg/webp) / text + paste. `packages/agents/ingest.ts` parses each to text;
  `POST /api/estimates/ingest-create` creates the DRAFT instantly then ingests in
  the background with polled progress (`ingestStatus/Stage/Pct/Error`). Provider
  extended to multimodal `content` parts + `plugins` passthrough.
  - **Model gotcha (live-verified):** OpenAI models read IMAGES but REFUSE the
    file-parser's parsed PDF text; Anthropic models read parsed PDFs but reject
    image input. So images → `openai/gpt-4o-mini` (vision); PDFs →
    `anthropic/claude-3.5-haiku` + `file-parser` engine `mistral-ocr` (OCR, reads
    scans/diagrams), fallback `pdf-text`. Both proven end-to-end against the live key.
  - DOCX: mammoth text + embedded images vision-transcribed.

NOTE: the background jobs are detached promises — fine for `next dev`/`next start`
(long-lived Node); a real deploy (serverless/multi-instance) needs a queue.

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

## Recently completed (full WBS push)

- **WS23** ✅ Menu Card refinement UI (toggle/recompute, edit hours, change-log, export, finalise).
- **WS25-01/02** ✅ coverage — engines ~100%, providers 96% lines.
- **WS26-03 / WS27-02** ✅ already covered by `ws15.test` (gate block→unblock) / `ws8.test` (cache-hit=0 calls).
- **WS26-02 / WS27-01 / WS27-03** ✅ offline (stub-LLM) evals in `agents/evals.test.ts` (pipeline→card→export, determinism ×3, config-change→predictable). Eval vs REAL model output stays credit-gated.
- **WS28-01** ✅ env/secrets contract (`src/lib/env.ts`, `.env.production.example`).
- **WS28-03** ✅ `/api/health` (public, DB+env probe). **WS28-04** ✅ `scripts/smoke.sh` (any URL). `docs/DEPLOY.md` runbook.

## Truly still open (need credits or hosting — cannot complete here)

- **Preset embeddings** → Archivist RAG (OpenRouter embedding credits). Pass `embeddingProvider` to `runEstimate` once present.
- **Real-model evals**: WS26-02/WS27 against actual LLM output (vs the offline stub versions above).
- **Actual deployment**: WS28-03/04 config + probes + smoke are ready; deploying needs hosting/secrets access. Detective (external MCP/search) not yet in the run path (findings `[]`).

## DoD status

`pnpm --filter web exec playwright test` → **19/19 pass**; agents **118/118**; providers **31/31**; core **13/13**.
Run pipeline proven offline + against real seeded data + real-provider 402.
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
