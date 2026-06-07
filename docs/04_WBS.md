# AI Estimation Agent — Work Breakdown Structure

**Read `00_BUILD_GUIDE.md` first.** Every task ≈ **4h human effort**, has a **DoD with a test**,
and names its **dependencies**. `[SLICE]` = thin vertical slice (build first). `∥` = parallel-safe.
Build top-to-bottom; within a workstream, tasks with satisfied dependencies may run in parallel.

---

## WS0 — Monorepo & Infrastructure Foundation

- **WS0-01 [SLICE]** Init pnpm-workspace monorepo (`apps/web`, `packages/{db,agents,core,providers,shared}`). — depends: none
  DoD: `pnpm install` succeeds; `pnpm -r build` runs clean on empty packages; tsconfig project refs resolve.
- **WS0-02 [SLICE]** Tooling baseline: TypeScript strict, ESLint, Prettier, Vitest at root. — depends: WS0-01
  DoD: `pnpm lint` and `pnpm test` pass on a trivial sample test in each package.
- **WS0-03 [SLICE]** Local Postgres + pgvector via `docker-compose`; `.env.example`. — depends: WS0-01
  DoD: `docker compose up -d` starts Postgres; `CREATE EXTENSION vector;` succeeds; connection string documented.
- **WS0-04 ∥** GitHub Actions CI: install, lint, typecheck, test on push. — depends: WS0-02
  DoD: CI workflow green on a clean commit.
- **WS0-05 ∥** `packages/shared`: Zod schemas + types for all agent IO + domain objects from `03_AGENT_SPECS.md`. — depends: WS0-02
  DoD: schemas exported; round-trip parse test passes for each.

## WS1 — Data Layer & Schema

- **WS1-01 [SLICE]** Prisma init in `packages/db`; datasource + generator; pgvector preview flag. — depends: WS0-03
  DoD: `prisma generate` succeeds; client importable.
- **WS1-02 [SLICE]** Model: `User` + `Role`; `Preset` + `PresetVersion` (all xlsx-mirrored fields). — depends: WS1-01
  DoD: migration applies; create/read a PresetVersion in a test.
- **WS1-03** Model: `TaxonomyNode` + `TaxonomyNodeVersion` + `ChangeMotivation` enum. — depends: WS1-01
  DoD: migration applies; node + version CRUD test passes.
- **WS1-04** Model: `Prompt` + `PromptVersion` (+ `AgentKind`). — depends: WS1-01
  DoD: migration applies; one active version per kind enforced in a test.
- **WS1-05** Model: `EstimationConfig` (complexity/taxation/baseline JSON). — depends: WS1-01
  DoD: migration applies; active-version uniqueness test passes.
- **WS1-06** Model: `McpConnector`. — depends: WS1-01
  DoD: migration applies; CRUD test passes; secret stored as ref not plaintext.
- **WS1-07 [SLICE]** Models: `Estimate`, `MenuItem`, `RoleLineItem` (+ enums), indexes incl. `sowHash`. — depends: WS1-02, WS1-03
  DoD: migration applies; create estimate → 1 menu item → 4 role line items test passes.
- **WS1-08** pgvector column on `PresetVersion.embedding` via `Unsupported`; raw-SQL ANN helper. — depends: WS1-02
  DoD: insert a vector and run `<=>` nearest-neighbour query returning ordered rows in a test.
- **WS1-09** `ChangeLog` read model (union of all version-create events). — depends: WS1-02..WS1-05
  DoD: query returns chronological feed with who/when/why/motivation across entity types (test with seeded rows).

## WS2 — Auth & RBAC

- **WS2-01** Auth.js credentials provider; Postgres session store; password hashing. — depends: WS1-02
  DoD: register + login + logout flow test passes; bad creds rejected.
- **WS2-02** Role claim + server-side `requireRole()` guard for API handlers. — depends: WS2-01
  DoD: estimator blocked from an admin-only route (403) in a test; admin allowed.
- **WS2-03 ∥** UI auth screens (login) + session provider in `apps/web`. — depends: WS2-01
  DoD: Playwright: login redirects to dashboard; protected page redirects when logged out.

## WS3 — Provider Layer (swappable)

- **WS3-01 [SLICE]** `ModelProvider` over Mastra model router with **OpenRouter** gateway; `chat()` + `embed()`; per-call model string. — depends: WS0-05
  DoD: integration test (mockable) returns a completion and an embedding; model string swap changes target without code change.
- **WS3-02 [SLICE]** `EmbeddingProvider` (delegates to ModelProvider.embed); dimension config. — depends: WS3-01
  DoD: embeds a string to a vector of configured dimension; test asserts length.
- **WS3-03** `SearchProvider` interface + one default web-search adapter. — depends: WS0-05
  DoD: `search("...")` returns normalised results; adapter swap covered by a contract test.
- **WS3-04** Provider fallback config (backup model on error). — depends: WS3-01
  DoD: simulated primary failure routes to fallback in a test.

## WS4 — MCP Connector Subsystem

- **WS4-01** `McpProvider`: instantiate Mastra MCP client per **enabled** `McpConnector`; expose tools. — depends: WS1-06, WS0-05
  DoD: against a test MCP server, tools are discovered and listed; disabled connectors excluded.
- **WS4-02** Connection-test routine (`testConnector(id)` → ok/error, writes `lastTestOk`). — depends: WS4-01
  DoD: valid server → ok; unreachable → typed error; field updated (test).
- **WS4-03** Encrypted secret storage for `authRef` (env-keyed). — depends: WS1-06
  DoD: secret round-trips encrypted at rest; never logged (test asserts ciphertext in DB).
- **WS4-04 qa** Contract test: tool list from a stub MCP server matches expected shape. — depends: WS4-01
  DoD: test green; failure if tool schema drifts.

## WS5 — Web Search Tool wiring

- **WS5-01** Wrap `SearchProvider` as a Mastra tool for the Detective. — depends: WS3-03
  DoD: tool callable from an agent stub; returns structured results in a test.

## WS6 — Versioning Subsystem (reusable)

- **WS6-01** Generic `versionedCreate(entity, payload, {reason, motivation, by})` + `setActive`. — depends: WS1-02..WS1-05
  DoD: creating a version increments number, single active enforced, prior versions immutable (tests).
- **WS6-02** `resolveActiveVersions()` + `pinVersions()` helpers for estimates. — depends: WS6-01, WS1-07
  DoD: estimate stores pinned version map; later "active" change doesn't alter the pinned estimate (test).
- **WS6-03 ∥** Diff helper: human-readable change between two versions of any entity. — depends: WS6-01
  DoD: diff of two preset versions lists changed fields (test).

## WS7 — Prompt Management (editable + versioned)

- **WS7-01** Service: load active `PromptVersion` (body + modelString) by `AgentKind`. — depends: WS1-04, WS6-01
  DoD: returns active prompt; falls back with typed error if none (test).
- **WS7-02** API: list/create/activate prompt versions (admin-only). — depends: WS7-01, WS2-02
  DoD: create version → activate → load reflects change; estimator gets 403 (tests).
- **WS7-03 ∥** Admin UI: prompt editor with version history + activate + change reason/motivation. — depends: WS7-02, WS2-03
  DoD: Playwright: edit prompt, save as new version, activate, see it in history.

## WS8 — Agent Framework Scaffolding & Supervisor

- **WS8-01 [SLICE]** Mastra app bootstrap in `packages/agents`; register empty agents per `AgentKind` (prompt+model from DB). — depends: WS3-01, WS7-01
  DoD: each agent instantiates with its active prompt/model; a no-op run returns valid structured output (test).
- **WS8-02 [SLICE]** SOW normalisation + `sha256` hashing utility. — depends: WS0-05
  DoD: same input → same hash; whitespace/case normalisation covered (test).
- **WS8-03 [SLICE]** Cache layer keyed by `sowHash + pinnedVersions + modelConfig`. — depends: WS8-02, WS6-02
  DoD: identical inputs return cached estimate without agent calls (test); changed pin busts cache.
- **WS8-04 [SLICE]** Supervisor skeleton: lifecycle ordering, shared `agentState` read/write, typed step errors + single retry. — depends: WS8-01, WS8-03
  DoD: runs Librarian→Archivist→Architect stubs end-to-end writing state (test).
- **WS8-05** Supervisor `refine` mode routing (re-run only changed menu items + downstream math). — depends: WS8-04
  DoD: changing one item triggers re-run of only that item + taxation/baseline (test asserts others untouched).

## WS9 — Librarian Agent (taxonomy + RAG)

- **WS9-01 [SLICE]** RAG retriever over taxonomy + preset corpus (embeddings). — depends: WS3-02, WS1-08
  DoD: query returns relevant taxonomy nodes ranked (test on seeded data).
- **WS9-02 [SLICE]** Librarian agent: SOW → requirements[] with taxonomyKey + confidence. — depends: WS9-01, WS8-04
  DoD: sample SOW yields requirements each mapped to a valid taxonomy key (test); unmapped flagged.
- **WS9-03 qa** Determinism check: same SOW → identical taxonomy mapping across 3 runs. — depends: WS9-02
  DoD: 3 runs produce identical mapping (test).

## WS10 — Detective Agent (search + MCP)

- **WS10-01** Detective agent wiring with SearchProvider tool + McpProvider tools. — depends: WS5-01, WS4-01, WS8-04
  DoD: agent can call both tool classes (test with stubs).
- **WS10-02 [SLICE]** Findings extraction: per requirement → claim + source + risk flags (middleware/retries/rate-limits). — depends: WS10-01
  DoD: sample requirement touching an API yields findings with explicit risk flags (test).
- **WS10-03 ∥** Source attribution + dedupe of findings. — depends: WS10-02
  DoD: duplicate findings merged; each retains source (test).

## WS11 — Archivist Agent (vector matching)

- **WS11-01 [SLICE]** Embed requirements + ANN match against `PresetVersion.embedding`. — depends: WS1-08, WS3-02
  DoD: requirement returns top-k presets with scores (test on seeded 45 presets).
- **WS11-02** Return match payload (presetId/version, beHours, feHours, risk, aiAssist) for Specialists. — depends: WS11-01
  DoD: payload schema-valid and version-pinned (test).
- **WS11-03 ∥** Optional LLM re-rank of top-k. — depends: WS11-01
  DoD: re-rank improves/keeps ordering on a labelled fixture (test tolerant).

## WS12 — Complexity Scorecard Engine

- **WS12-01** Pure function: inputs (api/integration counts, legacy keywords, data volume) → score 1–5 + per-item multipliers, driven by `EstimationConfig.complexityRules`. — depends: WS1-05
  DoD: table-driven test: legacy→~4, integration→~3-4, AI→~3-5, simple web→~1-3 with seeded rules.
- **WS12-02** Detector: count APIs/integrations + scan legacy keywords + read data-volume from requirements/findings. — depends: WS9-02, WS10-02
  DoD: sample SOW produces expected counts (test).
- **WS12-03 [SLICE]** Wire scorecard into supervisor; apply global multipliers to all specialists. — depends: WS12-01, WS12-02, WS8-04
  DoD: estimate carries an overall score; multipliers reach specialist inputs (test).

## WS13 — Specialist Council (Dev/QA/PM/BA, multi-role matrix)

- **WS13-01 [SLICE]** Dev specialist: anchor on match BE+FE, adjust for complexity + Detective risk, apply AI-assist. — depends: WS11-02, WS12-03
  DoD: produces baseHours + rationale + assumptions for a menu item (test).
- **WS13-02** QA specialist: direct test-design/execution effort from Dev scope + risk. — depends: WS13-01
  DoD: QA line item produced, independent of Dev hours (test).
- **WS13-03** PM specialist: coordination effort per item. — depends: WS13-01
  DoD: PM line item produced with rationale (test).
- **WS13-04** BA specialist: analysis/acceptance-criteria effort per item. — depends: WS13-01
  DoD: BA line item produced with rationale (test).
- **WS13-05 [SLICE]** Assemble 4 independent `RoleLineItem`s per menu item (shared menu-item identity). — depends: WS13-01..WS13-04, WS1-07
  DoD: menu item has exactly DEV/QA/PM/BA lines; toggling item enables/disables all four together (test).

## WS14 — Operational Taxation + Infrastructure Baseline

- **WS14-01** Taxation engine: apply PM/BA communication tax % and QA regression buffer % → `taxedHours`. — depends: WS13-05, WS1-05
  DoD: taxedHours = base*(1+pct) per role from config (test).
- **WS14-02** Infrastructure baseline injector: mandatory env-setup/CI-CD/hypercare line items per role. — depends: WS13-05, WS1-05
  DoD: baseline items present once per estimate, sourced from config (test).
- **WS14-03 ∥** Make all percentages/baselines read from active `EstimationConfig` (no hardcoding). — depends: WS14-01, WS14-02
  DoD: changing config version changes outputs without code change (test).

## WS15 — Hidden-Work Audit + Validation Audit

- **WS15-01** Hidden-Work Audit: ensure unmodelled work from Detective findings (middleware/retries/data remediation) has a line item. — depends: WS10-02, WS13-05
  DoD: a finding with no matching line triggers an added/flagged item (test).
- **WS15-02 [SLICE]** Validation Audit gate: cross-check Detective risk flags vs Specialist buffers; emit `{passed, unreconciled[]}`. — depends: WS15-01, WS14-01
  DoD: rate-limit finding not reflected in hours → `unreconciled` non-empty; supervisor blocks Architect (test).
- **WS15-03** Reconciliation/acknowledge path (admin/estimator can accept an unreconciled item with note). — depends: WS15-02
  DoD: acknowledged item unblocks the gate and is recorded (test).

## WS16 — Architect (Synthesis)

- **WS16-01 [SLICE]** Narrative array generation (one approach sentence per major menu item). — depends: WS15-02
  DoD: narrative length tracks enabled menu items; sentences reference real items (test).
- **WS16-02 [SLICE]** Deterministic Assumption Set: dedupe + collate specialist assumptions. — depends: WS13-05
  DoD: duplicate assumptions merged; stable ordering for identical input (test).
- **WS16-03 [SLICE]** Menu Card assembly with parent/child mapping from preset `requires`/`blocks`. — depends: WS16-01, WS16-02, WS11-02
  DoD: child items link to parents; disabling a parent flags dependent children (test).

## WS17 — Menu Card Model & Per-Role WBS Output

- **WS17-01 [SLICE]** Roll-up calculator: totals per role + grand total across enabled items. — depends: WS16-03, WS14-03
  DoD: totals recompute correctly when items toggled (test).
- **WS17-02** Per-role WBS projection: same menu items, role-specific line items for Dev/QA/PM/BA. — depends: WS17-01
  DoD: four projections share item identity but carry distinct hours/notes (test).
- **WS17-03 ∥** Cost-optimisation toggle API: enable/disable item → recomputed projections + totals. — depends: WS17-02
  DoD: toggling returns updated per-role WBS + totals (test).

## WS18 — State-Aware Refinement

- **WS18-01** Persist full intermediate `agentState`; load on refine. — depends: WS8-05, WS16-03
  DoD: refine loads prior state without re-running unaffected agents (test).
- **WS18-02** Module-level tweak API: edit one item's hours/scope/complexity → re-run only that item + downstream math. — depends: WS18-01
  DoD: editing one item leaves others byte-identical; downstream taxation/baseline/rollup update (test).
- **WS18-03 ∥** Estimate revision history (each refinement is a recorded revision). — depends: WS18-02
  DoD: revisions listed with diffs (test).

## WS19 — Google Sheets Export

- **WS19-01 [SLICE]** `SheetsProvider`: service-account auth + create spreadsheet in target Drive folder. — depends: WS0-05
  DoD: creates a sheet and returns its URL (integration test; `BLOCKED-CREDENTIAL` stub if no creds).
- **WS19-02 [SLICE]** Write one tab per role (Dev/QA/PM/BA) + roll-up tab from the Menu Card. — depends: WS19-01, WS17-02
  DoD: tabs created with correct columns/totals matching the in-app projection (test against export model).
- **WS19-03 ∥** Re-export updates the same spreadsheet (idempotent by estimateId). — depends: WS19-02
  DoD: second export updates rather than duplicates (test).

## WS20 — Write-Back Loop (corpus grows on the fly)

- **WS20-01** On Finalise: promote enabled menu items to new `PresetVersion`s with `sourceEstimateId` provenance. — depends: WS6-01, WS16-03
  DoD: finalising creates versioned presets linked to the estimate; no dupes on re-finalise (test).
- **WS20-02** Generate + store embeddings for promoted rows so the Archivist sees them next run. — depends: WS20-01, WS3-02
  DoD: a subsequent estimate can match a previously promoted item (test).
- **WS20-03 ∥** Post-delivery actuals entry (log real hours against a preset version; `POST_DELIVERY_VALIDATION`). — depends: WS20-01
  DoD: actuals stored as a new version with motivation enum (test).

## WS21 — Web UI: Shell

- **WS21-01 [SLICE]** App shell: nav, role-aware menu (admin vs estimator), shadcn theme. — depends: WS2-03
  DoD: admin sees admin nav; estimator does not (Playwright).
- **WS21-02** Dashboard: list estimates with status + owner. — depends: WS21-01, WS1-07
  DoD: estimates render; click opens detail (Playwright).

## WS22 — Web UI: Upload & Run

- **WS22-01 [SLICE]** SOW upload/paste form → create estimate (DRAFT). — depends: WS21-01, WS1-07
  DoD: submitting text creates an estimate and navigates to it (Playwright).
- **WS22-02 [SLICE]** "Run estimate" trigger + live progress (agent step states). — depends: WS22-01, WS8-04
  DoD: run shows step progress and completes to REVIEW (Playwright against a fast/stubbed pipeline).

## WS23 — Web UI: Menu Card View & Refinement

- **WS23-01 [SLICE]** Menu Card view: items grouped, per-role hours, totals, parent/child indicators. — depends: WS22-02, WS17-02
  DoD: card renders enabled items with four role columns + totals (Playwright).
- **WS23-02 [SLICE]** Toggle items in/out → live recomputed totals. — depends: WS23-01, WS17-03
  DoD: toggling updates per-role and grand totals on screen (Playwright).
- **WS23-03** Module tweak UI (edit hours/scope/complexity on one item) → refinement. — depends: WS23-01, WS18-02
  DoD: editing one item updates only it + downstream totals (Playwright).
- **WS23-04** Narrative + assumption set + change-log panels. — depends: WS23-01, WS1-09
  DoD: panels render arrays; change log shows version events (Playwright).
- **WS23-05 ∥** "Export to Sheets" button → returns/open link. — depends: WS23-01, WS19-02
  DoD: button triggers export and surfaces the URL (Playwright; stubbed creds OK).
- **WS23-06** "Finalise" button → write-back + status FINALISED. — depends: WS23-01, WS20-01
  DoD: finalising locks the estimate and creates promoted presets (Playwright).

## WS24 — Web UI: Admin

- **WS24-01** Users admin: list, set role. — depends: WS21-01, WS2-02
  DoD: admin changes a user's role; takes effect (Playwright).
- **WS24-02** MCP connectors admin: add → test → enable/disable. — depends: WS21-01, WS4-02
  DoD: add connector, run test (status shown), enable; Detective picks it up (Playwright + integration).
- **WS24-03** Presets & taxonomy admin: browse, edit → new version, activate, view history/diff. — depends: WS21-01, WS6-01, WS6-03
  DoD: edit a preset → new active version; history+diff visible (Playwright).
- **WS24-04** Config admin: edit complexity rules / taxation % / baseline → new `EstimationConfig` version. — depends: WS21-01, WS1-05, WS6-01
  DoD: saving creates a new active config; next estimate uses it (Playwright + integration).
- **WS24-05** Prompt admin surfaced in nav (links WS7-03). — depends: WS7-03, WS21-01
  DoD: admin reaches prompt editor from nav; estimator cannot (Playwright).

## WS25 — QA: Unit/Integration Hardening

- **WS25-01 qa** Coverage pass on `core` engines (complexity/taxation/baseline/rollup) to ≥90%. — depends: WS17-01, WS14-03
  DoD: coverage threshold met; edge cases (zero items, all-disabled) covered.
- **WS25-02 qa** Coverage pass on providers (model/embedding/search/MCP/Sheets) with mocks. — depends: WS19-02, WS4-02
  DoD: each provider has success + failure-path tests; swap-adapter contract tests pass.
- **WS25-03 qa ∥** Versioning invariants suite (immutability, single-active, pin reproducibility). — depends: WS6-02
  DoD: property/edge tests green.

## WS26 — QA: End-to-End Pipeline

- **WS26-01 qa** Seed 2–3 **sample SOWs** as fixtures (one simple, one integration-heavy, one legacy-heavy). — depends: WS9-02
  DoD: fixtures committed with expected taxonomy/complexity ranges.
- **WS26-02 qa [SLICE]** Full pipeline e2e: upload fixture → run → Menu Card → export model. — depends: WS19-02, WS16-03, WS26-01
  DoD: each fixture completes with non-empty per-role WBS and totals within expected bounds.
- **WS26-03 qa** Validation-gate e2e: legacy/integration fixture surfaces unreconciled items until acknowledged. — depends: WS15-02, WS26-01
  DoD: gate blocks then unblocks on acknowledge (test).

## WS27 — QA: Determinism / Consistency Eval Harness

- **WS27-01 qa [SLICE]** Mastra eval: same SOW (same pins/config/model) → identical Menu Card + totals across N runs. — depends: WS26-02, WS8-03
  DoD: N≥3 runs byte-identical on totals + taxonomy mapping; failure if drift.
- **WS27-02 qa** Cache-hit assertion: repeat run makes zero agent calls. — depends: WS27-01
  DoD: spy confirms no model calls on cache hit.
- **WS27-03 qa ∥** Regression eval: changing config/prompt version changes output predictably and is recorded. — depends: WS27-01, WS6-01
  DoD: version bump alters output + change log entry exists (test).

## WS28 — Deployment & Hypercare Baseline (this app)

- **WS28-01** Production env config + secrets management (OpenRouter, DB, Google SA, encryption key). — depends: WS19-01, WS3-01
  DoD: app boots against prod-like env from secrets, not hardcoded values.
- **WS28-02** DB migrate + seed runbook (incl. xlsx import) for fresh deploy. — depends: WS1-09, "seed script"
  DoD: documented one-command migrate+seed brings up a working instance with 45 presets embedded.
- **WS28-03 ∥** Deploy target (Vercel for web; Node host for agents/workers) + health check. — depends: WS28-01
  DoD: deployed instance serves login + runs a stubbed estimate end-to-end.
- **WS28-04 qa** Smoke suite against deployed instance (auth, run, export). — depends: WS28-03, WS26-02
  DoD: smoke tests green post-deploy.

---

### Seed script note (referenced above)
A dedicated seed task lives in WS-DB context: implement `packages/db/seed.ts` per
`02_PRISMA_DATA_MODEL.md §10` (import `preset_library_v2.xlsx`, build taxonomy, seed config +
prompts, generate embeddings). Treat it as **WS1-10 [SLICE]** — depends: WS1-02, WS1-03,
WS1-05, WS1-04, WS3-02, WS1-08.
DoD: `pnpm db:seed` loads 45 presets (P01–P45) as active v1 with embeddings, a taxonomy
derived from categories/req-types, one active config, and one active prompt per agent;
re-running is idempotent.
