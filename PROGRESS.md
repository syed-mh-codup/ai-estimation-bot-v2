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
- [ ] C4  PresetVersion metadata
- [ ] C5  version history (getChangeLog + per-entity lists)
- [ ] C6  MCP provider/auth/wiring
- [ ] C7  diagnostics panel + agentState column read
- [ ] C8  runDetective parses DetectiveInputSchema
- [ ] C9  annotations + knip baseline, against the FINAL register

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
