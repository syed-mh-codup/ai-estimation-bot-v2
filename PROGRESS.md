# AEH-253 — Clear the orphan register

Status: IN PROGRESS (transitioned 2026-08-27).
Plan file: ~/.claude/plans/please-pick-up-aeh-253-sprightly-wind.md (APPROVED)

Previous ticket AEH-263 closed 2026-08-27 — its record lives in Jira, not here.

## Opening baseline (master @ 1fff6fd, measured not assumed)

  pnpm audit:fields   -> 33 orphan fields + 4 contract fields
                         (156 audited, 123 consumed, 0 exempt; 193 zod fields)
  pnpm audit:exports  -> 57 zero-caller exports (37 exports + 20 types)
  pnpm test           -> 3 failed / 347 passed / 1 skipped (351)
                         the 3 ARE these gates. 0 failed is the done signal.
  typecheck + lint    -> clean

## Decisions locked with the user

1. PresetVersion: WIRE the high-value columns. @backend-only only beHours/feHours.
2. MCP: FINISH the wire in this ticket (provider + auth + Detective).
3. Dead scaffolding: DELETE all of it (@repo/core, runSupervisor, cache, refinement).
4. agentState: BUILD a run-diagnostics surface, fix the declared type.
5. Cache cascade: deleting cache.ts orphans 4 Estimate columns -> DROP all four
   (sowHash, taxonomyVersionsPinned, promptVersionsPinned, modelConfig).
   configVersion SURVIVES (real reader at estimates/[id]/page.tsx:356).

## The audit defect found while planning (proved by dumping the index)

Json pseudo-model `MenuItem.meta` = model fields UNION meta keys, so it strictly
outscores `MenuItem` on any full-fidelity domain object. Confirmed:

  MenuItem.sourcePresetId <- writeback.ts:114 [read] attributedTo={MenuItem.meta}
  MenuItem.matchScore     <- writeback.ts:188 [read] attributedTo={MenuItem.meta}

=> sourcePresetId and matchScore are FALSE ORPHANS (real consumers, invisible gate).
Decision: do NOT fix the audit inside the PR that must pass it. Wire instead, and
file a follow-up. Full reasoning in the plan file.

### The five read-shape rules (violate one and the wire is cosmetic)

R1 never mix Json key names into the TOP-LEVEL props of a type whose other props
   are consumed columns. Nest: `flags:{...}` on ItemDTO, `envelope:{...}` on
   LineItemDTO. Flattening onto LineItemDTO would re-attribute EXISTING green
   reads and MINT new orphans.
R2 credit comes from a USE site, never the mapper. `x: source.x` is carry-forward.
R3 never destructure an audited name in a FUNCTION PARAMETER — records
   attributedTo:[] and drags the 0.8 resolution canary down.
R4 never name a new property after a Json column with an object-literal
   initializer — discoverJsonKeys unions its keys into the register.
R5 a read on the domain MenuItem from toMenuItem can NEVER clear a column.

Only `read` and `query-read` count. form-echo / carry-forward / projection /
type-decl count for NOTHING.

## Execution order (delete -> wire -> annotate; measure after every step)

- [x] C1  deletions, driven to a knip fixpoint  (33->31 fields, 4->2 contract, 57->16 exports)
- [x] C2  MenuItem card DTO + setItemEnabled guard  (31 -> 24 fields)
- [x] C3  LineItemDTO envelope  (24 -> 21 fields)
- [x] C4  PresetVersion metadata  (21 -> 14 fields)
- [x] C5  version history (getChangeLog + per-entity lists)  (14 -> 10 fields, 16 -> 9 exports)
- [x] C6  MCP provider/auth/wiring  (10 -> 9 fields, 9 -> 6 exports)
- [x] C7  diagnostics panel + agentState column read  (9 -> 2 fields)
- [x] C8  runDetective parses DetectiveInputSchema  (2 -> 0 contract, 6 -> 5 exports)
- [x] C9  annotations + knip baseline, against the FINAL register  ALL GATES GREEN

## Landmines (each already cost someone time)

- getChangeLog must be WIRED not deleted: its raw SQL is what keeps
  PresetVersion.changeReason/changeMotivation/createdBy consumed (R7 takes the
  FIRST `FROM "..."`). Deleting it mints 3 new orphans.
- perItemMultiplierDefault must die in THREE places (complexity.ts:32 the zod
  field, complexity.ts:227, seed.ts:133) or the surviving zod field becomes a
  NEW contract orphan.
- SupervisorInputSchema is all-or-nothing: delete runSupervisor but keep the
  schema and `mode` becomes a NEW contract orphan.
- Deleting the 18 z.infer aliases EXPOSES their schemas (the alias was the
  in-file use). Delete the 4 spec-artefact Input schemas too — that is what
  disposes of taxonomyVersionPin. Keep DetectiveInput (C6/C8 resurrects it).
- prisma-schema.test.ts:51-64 pins the exact 8 Json columns -> 5 after C1.
  :25-30 pins models=15, enums=12.
- field-audit.test.ts:43-64 pins exact meta key sets; canaries filesAnalysed>100
  (119->~113), contractFieldsAudited>150 (193->~176).
- PresetVersion.requires does NOT become an orphan from UI readers of
  notSafelyRemovable — only if the new blocks/canParallel consumer REPLACES
  computeRequiredRequirementIds (architect.ts:53). Extend around it.
- presetEmbeddingText widening needs its `select` widened too (writeback.ts:332-339,
  scripts/embed-presets.ts:116) or undefined goes into the vector.
  Then db:embed:presets on all 3 DBs.
- estimate-refine.spec.ts:32,35 toggles twice; e2e fixture menu items have NO meta,
  so the DTO must apply permissive defaults for null meta.
- admin-mcp.spec.ts:14 does a LIVE connector test; CI has no ENCRYPTION_KEY.
- Live MCP calls run inside an Inngest step; Vercel Hobby = 300s hard ceiling.
  connect/listTools need a timeout.
- AEH-275 is a known suite flake (run-estimate vs evals over estimationConfig).
  Failures not false passes. Already filed. Do not chase.

## Log

### C1 done — deletions (commit below)

Measured after, not predicted:
  fields   33 -> 31   (parentItemId, perItemMultiplierDefault)
  contract  4 -> 2    (changedMenuItemIds, taxonomyVersionPin — both by deletion)
  exports  57 -> 16   at the knip fixpoint
  canaries files=113 (>100) audited=150 (>80) reads=1448 (>500)
           attribution=99.0% (>0.8) contractFields=174 (>150)  ALL CLEAR
  tests    3 failed / 303 passed — the 3 ARE the gates. run-estimate passes alone.
  typecheck + lint clean.

NO new orphans appeared: the 4 cache columns were DROPPED, not orphaned.

The knip cascade went two rounds, as predicted:
  round 1 (57->22) exposed the 6 mirrored enum schemas (AgentKindSchema,
  EstimateStatusSchema, ChangeMotivationSchema, DataVolumeSchema,
  PresetPhaseSchema, LevelSchema) — their z.infer alias was the only in-file
  use keeping them unreported. Every consumer imports the Prisma type from
  @repo/db instead. Deleted -> 16.

MIGRATION 20260827040000 APPLIED TO ALL FOUR DBs:
  Neon dev/main, local docker ai_estimation, local docker ai_estimation_test,
  Neon test. TRAP: `pnpm --filter @repo/db exec prisma migrate deploy` uses
  packages/db/.env, which points at NEON, not local docker. The local DBs need
  an explicit DATABASE_URL/DIRECT_URL override or the suite fails with
  "Null constraint violation on sowHash".

Tests rewritten rather than deleted, so coverage moved instead of vanishing:
  ws17  toggleMenuItem -> computeRollup/computeRoleProjections directly
  ws15  taxonomyKeyForRiskFlag -> asserted through detectHiddenWork
  ws14  parseTaxationConfig test dropped (field-for-field passthrough)
  vector.test  vectorToSql -> a local const in the fixture
  email.test   emailConfigured -> asserted through sendEmail's degrade path.
               Worth recording: emailConfigured() DISAGREED with the gate that
               actually runs — it required EMAIL_FROM, getTransport() checks
               only user+password.

Remaining 16 exports all have a disposition:
  C5 getChangeLog | C6 encryptSecret/decryptSecret/buildMcpProvider
  C8 DetectiveInput | C9 the rest (baseline-with-ticket or delete)

### C2 done — MenuItem card DTO + the toggle gate

  fields 31 -> 24. All SEVEN MenuItem findings cleared in one pass:
  category, phase, sourcePresetId, matchScore, meta.toggleable,
  meta.notSafelyRemovable, meta.thinSlice.
  tests 3 failed / 314 passed (+11 new). typecheck + lint clean.

R1 held exactly as predicted. `flags: CardFlags` is NESTED on ItemDTO on
purpose — flattening toggleable/thinSlice alongside category/phase would have
let the MenuItem.meta pseudo-model outscore MenuItem on every read of the DTO
and orphaned the columns instead of clearing them. The rationale is written
into actions.ts so nobody "tidies" it later.

sourcePresetId + matchScore were the two FALSE ORPHANS. They now have honest UI
consumers (the provenance line) rather than being argued away — an estimator
questioning a number can finally see whether it came from a close historical
match or from nothing.

### C3 done — line-item envelope

  fields 24 -> 21. RoleLineItem.meta.complexity / aiAssistApplied /
  anchorPresetIds cleared. Verified the RoleLineItem COLUMNS (baseHours,
  taxedHours, role) did NOT re-attribute — nesting held, exactly the failure
  mode R1 exists to prevent.
  tests 3 failed / 314 passed. typecheck + lint clean.

### C4 done — PresetVersion metadata

  fields 21 -> 14. Seven cleared: notes, userStoryTags (presetEmbeddingText),
  projectSizeFit (a REAL projectSizeDelta), blocks + canParallel + spikeNeeded
  + notes again (presetCaveats -> assumptions), phase (card phase fallback).
  Only beHours/feHours remain from PresetVersion — the @backend-only pair.
  tests 3 failed / 327 passed (+13 new). typecheck + lint clean.

PresetVersion.requires did NOT become an orphan. The Plan review was right and
the ticket's own prediction was wrong: `requires` is consumed by
computeRequiredRequirementIds (architect.ts:53) and only dies if the new
blocks/canParallel consumer REPLACES that function. It extends around it.

Note `Phase` had to come BACK as a type alias — deleted in C1 as unused, needed
again by archivist.ts's toCardPhase. Same class as DetectiveInput, which C1
deliberately kept for C8.

DATA: presetEmbeddingText changed, so every one of the 45 active presets is now
STALE by backfillPresetEmbeddings' own comparison. `pnpm db:embed:presets` must
run on all 3 DBs before the Archivist sees the new text. NOT DONE YET.

### C5 done — admin version history

  fields 14 -> 10 (EstimationConfig.changeReason/changeMotivation,
  PromptVersion.changeMotivation/createdBy).
  exports 16 -> 9. getChangeLog wired into a new /admin/changelog.
  tests 3 failed / 327 passed. typecheck + lint clean.

Config admin now CAPTURES a reason instead of stamping 'edited via admin', and
has a history list. Full rows, no narrow select — the Plan review's point: four
version models share changeReason/changeMotivation/createdAt, so a narrow
projection is ambiguous both to a reader and to the audit's attribution.

CASCADE: removing the sowHash write in C1 left packages/agents/src/sow-utils.ts
(hashSOW + normaliseSOW) with no production caller. Its own docstring says
"Used as part of the cache key computation" — the cache is gone, so the module
is too. This is the knip fixpoint continuing to unwind two commits later; it is
why the plan says measure after every step rather than trusting C1's number.

REMAINING 10 fields: 7 agentState (C7), authRef (C6), beHours/feHours (C9).
REMAINING 9 exports: 3 MCP (C6), DetectiveInput (C8), reorderSections +
DEFAULT_COMPLEXITY_RULES + DEFAULT_PROCESS_OVERHEAD + recordActuals +
embedPromotedPresets (C9).

### C6 done — MCP: the half-integration finished

  fields 10 -> 9 (McpConnector.authRef). exports 9 -> 6 (encryptSecret,
  decryptSecret, buildMcpProvider).
  tests 3 failed / 340 passed (+13 new). typecheck + lint clean.

Build order mattered and was followed:
  1. IMcpProvider.testConnector widened to take an optional DECRYPTED secret.
     Mandatory first: listTools delegates to it, so without the widening a live
     provider returns [] for every authenticated connector — indistinguishable
     from a server with no tools.
  2. LiveMcpProvider takes an optional masterKey; connect() puts the token in
     requestInit.headers (and SSE's own fetch, which is a separate path).
  3. TIMEOUT (12s default). listAllTools walks connectors SERIALLY inside an
     Inngest step and Vercel Hobby has a hard 300s ceiling. An erroring server
     already degraded to []; a HANGING one had nothing stopping it.
  4. buildMcpProvider returns a real LiveMcpProvider. Falls back to the stub on
     zero enabled connectors OR a stored secret with no key — connecting
     unauthenticated to a server that needs a token succeeds and reports zero
     tools, which is a lie that looks like data.
  5. Admin form takes an optional token, type=password, NEVER echoed back. The
     table shows a "Token" chip, not the value.

CI has no ENCRYPTION_KEY and admin-mcp.spec.ts does a live open-server test —
both still work, because the secret is optional end to end.

### C7 done — run diagnostics

  fields 9 -> 2. All SEVEN agentState keys cleared. Only beHours/feHours left.
  tests 3 failed / 341 passed. typecheck + lint clean.

CAUGHT A GREEN-FOR-THE-WRONG-REASON, and it is worth remembering:
  I first wrote `agentState: { ... } satisfies RunDiagnostics`. Findings went
  to 2 — but `audited` dropped 150 -> 144. discoverJsonKeys finds a Json
  column's keys only when the initializer is an object LITERAL; a satisfies
  expression (or a hoisted variable) hides them, so the gate audited agentState
  as ONE opaque column, saw the panel read it, and reported green with all
  seven keys silently unaudited.
  Fix: keep the bare literal, and guard drift with a TEST that asserts the
  persisted key set against RunDiagnostics. Stronger than satisfies anyway —
  it checks what is actually in the database.
  The `audited` count is the tell. Watch it, not just the finding count.

### C8 done — the Detective's contract is a contract

  contract fields 2 -> 0. exports 6 -> 5 (DetectiveInput alias too — the alias
  needed a real `import type` + use, not just the schema being parsed).
  FIELD GATE IS NOW GREEN except beHours/feHours, which take @backend-only.
  tests 3 failed / 343 passed. typecheck + lint clean.

ISearchProvider gained a `name`. A citation grounded in a live Tavily search and
one produced with the stub in place are not worth the same, and nothing recorded
which an estimate got.

### C9 done — ALL THREE GATES GREEN

  orphan-field audit: 150 audited, 148 consumed, 2 exempt, 0 finding(s)
  contract-field audit: 0 finding(s)
  zero-caller export check: clean
  pnpm test: 48 files, 346 passed, 0 FAILED   <- the done signal
  typecheck + lint clean.

  Exactly 2 exempt, both @backend-only on PresetVersion.beHours/feHours,
  restating the retention rationale already in the schema doc comment.
  knip baseline has exactly 3 entries, each defensible on its own:
    DEFAULT_COMPLEXITY_RULES  shared fixture, 5 test files
    DEFAULT_PROCESS_OVERHEAD  shared fixture, deliberately NOT a prod fallback
    recordActuals             real capability, no way in -> AEH-276

  Last deletions: reorderSections (server half of section drag; the client half
  was never written) and embedPromotedPresets (strictly weaker than
  backfillPresetEmbeddings, which is the wired path and takes the same
  presetIds argument — its test now goes through the real one).

FOLLOW-UPS FILED (all read back and diffed, one markup repair on AEH-277):
  AEH-276 Medium  post-delivery actuals loop (recordActuals has no way in)
  AEH-277 Medium  the field-audit attribution defect (Json pseudo-model steals
                  attribution from its own model; the 2 false orphans)
  AEH-278 Low     runEstimate has no cache; pinVersions is a prerequisite

## STILL TO DO

- [x] pnpm db:embed:presets — DONE on Neon dev/main. 45 stale -> 45 embedded,
      which is exactly what C4 predicted and proves the staleness mechanism
      works end to end (backfill compares stored embeddingText against a freshly
      computed one, so widening the function marks every row stale).
      The OTHER THREE DBs were measured and deliberately NOT embedded:
        local docker ai_estimation       51 active, 51 MISSING, 0 stale
        local docker ai_estimation_test   1 active,  1 MISSING, 0 stale
        Neon test                        46 active, 45 MISSING, 1 stale
      Those are MISSING, not stale — they have never been embedded at all,
      which is the pre-existing condition AEH-253's own description records
      ("a fresh db:seed:presets leaves presets unembedded until the script is
      run by hand"). Not caused by this ticket, and no test depends on it:
      the vector tests seed their own fixtures. Left alone rather than spending
      ~100 embedding calls to change a number nothing reads.
- [ ] pnpm test:e2e
- [ ] AEH-253 close-out comment + transition
- [ ] push (both remotes) — awaiting the user's go-ahead

## E2E DIAGNOSIS — WRONG TWICE, then found by the user opening the app

**The section below is superseded. Keeping it because the wrong reasoning is
the lesson.** The real cause was a REAL BUG I introduced, fixed in f7ec642:

  actions.ts carries 'use server'. EVERY export in such a module must be an
  async function. I added two synchronous ones (cardFlags, lineEnvelope), which
  fails the build of every route importing ANYTHING from that file.
  dashboard/page.tsx does -> /dashboard 500 -> login appears to hang.

WHY EVERY CHECK MISSED IT:
  tsc clean        — it is a Next.js compiler rule, not a type rule
  pnpm lint clean  — `next build` runs its own STRICTER eslint pass
  346 tests pass   — vitest imports the module without 'use server' semantics
  ONLY `next build` catches it. THE VERIFICATION PLAN HAD NO BUILD STEP.
  => `pnpm --filter web build` is now mandatory before calling any UI work done.

WHY I GOT IT WRONG TWICE. I curled /dashboard unauthenticated, got 307, and
concluded the route was fine. A 307 comes from MIDDLEWARE, before the page
component is ever built — it proves nothing about whether the route compiles.
Both my "it works warm / breaks cold" data points had that same hole. A
discriminator that cannot distinguish the two hypotheses is not evidence.

RULE: to prove a protected route renders, build it (`next build`) or request it
AUTHENTICATED. Never infer it from a middleware redirect.

---

## Superseded: the .next-corruption theory (wrong, kept for the reasoning)

SYMPTOM. Every spec that logs in failed at `page.waitForURL(/\/dashboard/)`,
60s timeout, button stuck on "Signing in...". /login was fine, bad-credentials
was fine, and `POST /api/auth/callback/credentials` returned 200 — the login
SUCCEEDED and the redirect target was what hung.

CAUSE. /dashboard returned 500 with one error and no other:

  ENOENT: copyfile
    packages/db/src/generated/client/libquery_engine-debian-openssl-3.0.x.so.node
    -> apps/web/.next/server/app/dashboard/libquery_engine-...so.node

The SOURCE was a valid 16MB ELF. The DEST DIRECTORY did not exist and never got
created, so @prisma/nextjs-monorepo-workaround-plugin's copy aborted the route
build. Other Prisma routes (/api/auth/[...nextauth]) copied fine. It did NOT
recover on retry — persistently 500 across restarts.

WHAT IT WAS NOT. typecheck clean, lint clean, 346 unit tests pass including
DB-backed ones. No module, import or type error in any log. And the discriminator:
the SAME COMMIT served /dashboard 307 on a warm .next at 19:19, then 500 after I
deleted .next, with no code change in between.

WHAT IT ACTUALLY WAS. I had run `pkill -f 'next dev'` several times while servers
were mid-compile. That leaves a half-written .next which then poisons every later
compile of the affected route — deleting .next alone did not clear it because the
next server was killed mid-rebuild too. After a plain `pnpm install` and a cold
start on an unused port with nothing killed underneath it: /dashboard 307,
ZERO ENOENTs.

RULES FOR NEXT TIME.
- Never pkill a next dev server mid-compile. Stop it cleanly or leave it.
- A 500 on ONE route with an ENOENT into .next/server/app/<route>/ is a build
  artefact problem, not application code. Check whether the DEST DIR exists
  before reading the error as a missing binary — the message names the source.
- Before blaming a change, find a discriminator: same commit, warm vs cold cache.
