# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-08-07 — the whole prioritised WORKLOG except #8 is DONE and on `master`: #1 delete authz, #2 preset embedding lifecycle, #3 profile, #4 FE/BE flags, #5 disable+reassign, #6 finalise→preset library, #7 preset creation. Plus Tavily grounding, preset consolidation to one dev figure, and sequence-allocated preset codes. 284 unit tests. See the two sections below._

## 2026-08-07 (later) — preset model overhaul + remaining WORKLOG items

**Decisions taken this session (company-level, worth knowing before changing any of it):**
- **Dev effort is ONE number.** Frontend/backend are no longer estimated
  separately — delivery is full-stack, and the split only ever existed to
  allocate work across separate FE/BE resources. Flags record which sides work
  covers, for if that changes.
- **Preset codes are uniform `P###`, auto-allocated**, with provenance in a
  column (`Preset.origin`: SEEDED | FINALISED | MANUAL) rather than in the code
  prefix. Numbers are free-flowing (no padding, no fixed width).

**The bug that drove most of this** — `writeback.ts` wrote
`beHours = Σ DEV; feHours = round(beHours * 0.4)`: all of DEV to backend *plus
another 40% on top*, so a promoted preset stored **1.4× the estimate it came
from**. Since `specialist.ts` feeds a preset's hours back as the next estimate's
anchor, it compounded (100h → 140 → 196 → 274). `recordActuals` did the same to
*measured delivered hours* — the calibration path made the library worse than
not calibrating. Note the trap: the library's real FE share is 32% and
0.4-as-markup implies 28.6%, so the **ratio was nearly right** and fixing only
the ratio would have left the 1.4× untouched. The defect was that FE was
*additive*, not that the constant was wrong. Consolidating to one figure removed
the need for any ratio at all — `LIBRARY_FE_SHARE`, the 50/50 halving of
full-stack items and `splitDevHours` are all deleted.

**Landed (each its own commit):**
- `bd5b5fb` **Tavily wired in.** `runEstimate` hard-defaulted to
  `StubSearchProvider`, so Detective findings were model-only with no citations.
  Now `createSearchProvider()`. Key in git-ignored `apps/web/.env.local`.
- `eceb937` **#4 FE/BE flags on `RoleLineItem`.** `RoleKind` untouched, so none
  of the traps in the worklog entry applied (no gate denominators, no taxation,
  no ROLES tuple, no new AgentKinds). Specialist tags each atomic DEV item;
  non-DEV roles forced untagged.
- `f0b1c07` **#6 finalise → preset library.** `promoteMenuItemsToPresets` had
  ZERO callers outside tests. Now hooked via `after()` → `estimate/finalised` →
  a `estimate-promote` Inngest fn (promote, then embed, separately retried).
  **Hybrid promotion:** match ≥ **0.75** versions the matched preset (carrying
  its metadata forward); below that mints a new one. 0.75 is deliberately
  strict — live scores run 0.46–0.62 on ordinary SOWs.
- `5cdd883` **Presets consolidated to `devHours`** + `touchesFrontend/Backend`.
  `beHours`/`feHours` KEPT but nullable — the decision may be revisited and the
  ISM xlsx split can't be reconstructed. NULL means "not tracked". Backfill was
  exact (45/45, 964h preserved).
- `875a21f`, `ea10878` **Preset codes.** `Preset.id` → cuid; `code` allocated
  from a **Postgres sequence** (`nextval`), not `max()+1` — allocation is
  concurrent and max+1 races. `syncPresetCodeSequence` clears codes arriving
  another way and is idempotent. The seeded 45 keep their ids: `requires`/`blocks`
  form a real dependency graph (43 rows, 40 ids, 0 dangling), 10 MenuItems point
  at them, and 6 live prompts name the P01–P45 range.
- `71d5f2f` **#7 preset creation.** `/admin/presets/new`; never asks for a
  number. Rejects a thin description because name+description+keywords ARE the
  embedding text — a vague preset never matches. Queues embedding on create.
- `63344b0` **#5 disable + reassign.** `disabledAt` and `passwordChangedAt`, both
  read by the DB-backed jwt callback (rule extracted to `lib/session-rules.ts`
  so its tests exercise the real function). **This is what ends a LIVE session** —
  `strategy: 'jwt'` means there's no session table to revoke, so refusing in
  `authorize()` would only block new logins. Reassignment is standalone, not
  buried in deletion.

**Consequence to know:** changing a password now signs out *every* device
including the one you changed it on. Copy updated to say so.

**Still open:** #8 steering input (not started, per instruction). From the
inventory: `detective.ts:102` hardcodes `"spikePresetId": "P01".."P06"` — should
derive from presets flagged `spikeNeeded`. Whether to renumber the seeded 45 is
still an open call (cost: rewrite 43 requires/blocks arrays, 10 MenuItem refs,
6 prompt bodies, in lockstep).

**Local-environment traps that cost real time this session:**
- **Restart `pnpm dev` after any `prisma generate`.** A running server holds the
  old client and new columns silently read `undefined`.
- **Never run `pnpm dev` and `pnpm test:e2e` together**, or two `test:e2e` runs
  at once — they share `apps/web/.next` and corrupt each other's build cache.
  Symptom: `net::ERR_ABORTED` or `Cannot find module './vendor-chunks/...'`.
- Neon's direct endpoint degraded to ~4.4s/query mid-session, which made the
  90-round-trip preset seed look like a hang.

## 2026-08-07 — WORKLOG #1–#3 landed on master

`feat/honor-prompts-4h-decomposition` and `design/warm-ledger` are both merged
(`git branch --no-merged master` is empty); the note further down about the
former being unmerged is stale.

**#1 — estimate deletion was unauthenticated in effect** (`209f6cc`).
`deleteEstimate` only called `requireSession()`, so any signed-in user could
destroy any estimate. There was also a *second* delete path
(`dashboard/page.tsx`) calling prisma directly, which is how it stayed
invisible. Both now go through one owner-or-admin chokepoint; new
`requireUser()` in `lib/rbac.ts`. **Editing stays open on purpose** — the
dashboard shows every estimate to everyone and that shared ledger is the
product; only destruction needs an accountable actor.

**#2 — the preset library could silently vanish from the Archivist** (`694a056`).
Retrieval filters `embedding IS NOT NULL`, so an un-embedded preset never
matches and never errors. `savePreset` created each new version with a null
embedding, deferring to a backfill that **did not exist anywhere in the repo** —
so a routine admin edit permanently de-indexed that preset.
- New `PresetVersion.embeddingText` records the exact string a vector came
  from, making staleness decidable.
- `savePreset` carries the old vector forward *inside* an interactive
  transaction (no window where the new version lacks one), then queues a
  refresh via a new `preset-embed` Inngest function.
- `backfillPresetEmbeddings()` + `pnpm db:embed:presets` (with `--dry-run`,
  `--force`, per-id filtering) is the recovery path that was missing.
- **Verified against Neon: 45/45 active presets embedded and tracked**, second
  run a clean no-op. Note the pre-existing 45/45 was a one-off nothing in the
  repo could reproduce — that's now fixed, not just documented.
- Latency bug found and fixed en route: the Inngest SDK retries a failed send
  with backoff, so awaiting it inline froze an admin save for ~20s whenever
  the event bus was down. Moved into `next/server` `after()`.

**#3 — no user could see their own name or change their own password**
(`fe68a60`). The admin create-user dialog promised both in writing and neither
existed; every account was stuck forever on the temp password an admin typed.
New `/profile` (details, editable name, change-password requiring the current
password). `MIN_PASSWORD_LENGTH` moved to `lib/password.ts` so self-set and
admin-set passwords share one rule. The DB-backed `jwt` callback now carries
`name` alongside `role`, so a rename lands live. Nav shows the name and links
to the page.
- **Known limitation, deliberately not built:** `strategy: 'jwt'` means there
  is no session table to revoke, so changing a password does not invalidate
  that user's other live sessions until their token expires. The natural fix
  is a `passwordChangedAt` comparison in the same jwt callback — it should
  ride along with WORKLOG #5's user-disable check, which needs the identical
  hook.

**Test state:** 250/250 unit (up from 236), **e2e 25 passed / 3 failed** — the
3 are the documented pre-existing failures (see the e2e-preexisting-failures
memory), unchanged. Two *other* specs (`admin-prompts`, and `profile` on its
first run) were flaking purely on cold route compile under `next dev`; both now
wait with an explicit budget (`ed72952`, `95ca525`). Lint unchanged at its
18-error baseline; `apps/web` typecheck clean.

**Next:** WORKLOG #4 is scoped down — DEV stays a single combined number, with
a frontend/backend *flag* on line items instead of a split. That decision gates
#6 (finalise → preset library), because the flag is what makes the writeback
FE/BE math exact instead of fabricated. Then #5 (disable + optional reassign)
and #7 (preset creation). #8 (steering input) is explicitly not started.

## 2026-07-08 — honor-prompts-4h-decomposition: COMPLETE + second live-verify pass (MERGED to master)

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

**`sow-simple` was the weakest possible test of this** (0 requirements
matched a preset, complexity stayed at 1, 0 Detective risks) — advisor
review flagged that the Archivist RAG path (Phase 7, real embedding spend)
had **zero live evidence it ever produces a match**, and that specialist
JSON-envelope robustness was untested under a heavier requirement set. A
second live run on a preset-adjacent SOW (Shopify B2B storefront + Celigo/P21
ERP sync + Klevu search + 90k-SKU PIM migration — deliberately chosen to hit
the preset library's actual domain) surfaced two more real, live-discovered
bugs, both now fixed and covered by unit tests:

1. **`packages/agents/src/specialist.ts` — envelope too strict for
   well-formed model output.** The live run failed twice: once when
   gpt-4o-mini emitted a legitimate `hours: 0` "not needed" item (e.g. "no
   integration testing required") that the schema's `min(0.25)` rejected
   outright, and once when it emitted a 6h item despite the explicit HARD
   CAP instruction, which `max(4.0)` also rejected — both killed the whole
   run via the no-silent-fallback policy (`withRetry` with `temperature: 0`
   just repeats the same "failure" deterministically). Fixed by relaxing the
   LLM-facing schema and normalizing in code instead of rejecting: 0h items
   are dropped, oversized items are deterministically split into ≤4h chunks
   that chain via `dependsOn` (`splitOversizedHours`). This is a more
   faithful enforcement of the four-hour rule than throwing — the system's
   job is to make the invariant hold, not just detect violations of it.
2. **`packages/agents/src/architect.ts` — real Archivist matches never
   reached the MenuItem.** Diagnostic script confirmed the retrieval itself
   was fine all along (8–9 of 10 real requirement embeddings scored 0.6–0.83
   cosine similarity against the right presets — e.g. "Klevu-powered faceted
   search" → preset P42 at 0.81, "Sync pricing... via Celigo" → preset P09 at
   0.77), but `runArchitect`'s card assembly only ever used
   `archivistMatches` for `sequencing.requires` chains — it never wrote
   `sourcePresetId`/`matchScore` onto the `MenuItem`, so every card showed
   `sourcePreset=none` regardless of a real match underneath. Fixed with
   `bestMatchForCard` (strongest non-`none` match across the card's
   requirements). Re-ran live after the fix: all 8 menu cards now carry a
   real `sourcePresetId` + `matchScore` matching the diagnostic scores
   exactly (P32/0.82, P09/0.77, P02/0.45, P31/0.71, P36/0.78, P35/0.72,
   P42/0.81, P12/0.61).

Both fixes are covered by new unit tests (`ws13.test.ts`: drops 0h items,
splits oversized items with correct dependsOn chaining; `ws16.test.ts`:
surfaces/omits sourcePresetId+matchScore based on match coverage). Full
suite is now **137/137 passing**.

**Known-remaining calibration gap (not a code bug, not fixed this pass):**
the `sow-simple` live run's total hours look inflated for the SOW's actual
scope (~160–190h for a landing page with a hero/features/testimonials/
contact form — more like a 30–60h job) — the model pads with items like "add
error handling for hero section" despite the prompt's explicit no-padding
rule. The gate-warning system correctly caught the symptom (BA at
52–95% of DEV, PM at 30–44%, both flagged as out of proportionality band on
every live run so far) but nothing auto-corrects it. This is a
prompt-adherence/model-capability limitation (gpt-4o-mini not fully honoring
the envelope's constraints), not something a schema or code fix closes — it
would need prompt tuning and/or a stronger specialist model.

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
  session's live runs were smoke tests (does it work, is it sane, does the
  data actually flow end to end), not a quality regression suite.
- The QA/PM/BA over-proportion calibration gap above — needs prompt tuning,
  not a code fix.

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
