# Progress (session continuity only)

_No backlog or completion state here — that lives in Jira. This file is
just working notes for whatever's in flight right now._

## Current session — AEH-226 (In Progress)

Branch `feat/aeh-226-wbs-preset-round-trip`. Done and verified locally:

- `packages/agents/src/wbs-preset-round-trip.test.ts` — the round-trip guard.
  Persisted MenuItem/RoleLineItem rows → `promoteEstimate` → index →
  pgvector retrieval → the rendered prompt anchor. Mutation-checked against
  four injected bugs including the historical ×1.4 (all four caught).
- `promoteEstimate()` in `writeback.ts` — the read-and-map half lifted verbatim
  out of the Inngest step closure. This is the seam AEH-227's `toMenuItem`
  slots into; the mapping body is still hand-written on purpose.
- `describeCoverage` exported from `specialist.ts` — last point where the
  anchor is still a number.
- CI: Node 22 (pnpm 11 needs >=22.13 — this is why every run since 2026-07-15
  died at install), `prisma migrate deploy` + job-level `DIRECT_URL`, and three
  independent jobs so a lint nit can't stop the suite from running.
- `packages/core` PresetPayload: `beHours`/`feHours` → `devHours`. Was a fourth
  PresetVersion writer that couldn't compile.

Suite: 44 files / 286 tests green, three consecutive runs.

### Still red, deliberately not fixed here (needs a ticket)

Pre-existing, surfaced only because CI now runs. Everything below predates
this branch.

- **lint: 18 errors, 6 warnings.** All trivial: unused imports/vars in
  `refinement.ts`, `rollup.ts`, `run-estimate.ts`, `taxation.ts`,
  `ws14.test.ts`, `ws9.test.ts`, `versioning.test.ts`; plus 6 × `no-undef` on
  `process`/`console` in `scripts/import-prompts.mjs`, which is an eslint
  config gap (`.mjs` gets no node globals).
- **typecheck: 47 errors, all in `packages/agents` test files.** Every other
  package is 0. Two families:
  - 31 × object literals missing fields added later — and the missing set is
    literally `touchesFrontend, touchesBackend, aiAssistApplied, dependsOn,
    anchorPresetIds` (ws14/ws15/ws16), plus `dimension` on `IEmbeddingProvider`
    (ws11). **This is AEH-227's own evidence, still uncorrected**: that ticket
    says adding the two side booleans touched twelve files and "the compiler
    caught only some of it". These are the ones it didn't catch — they have sat
    here since 2026-08-07 because typecheck never ran.
  - 8 × vitest-2 `Mock<Args, Return>` generic arity (ws8/ws17/ws18/ws19/ws20).

### Loop asymmetries found while mapping (recorded, not filed)

1. QA/PM/BA hours are discarded on promotion — `PresetVersion` has one effort
   column, so 48h in → 30h stored. `recordActuals` accepts a QA/PM/BA role and
   then changes no stored number.
2. Promotion is per-card, anchoring is per-requirement — a 3-requirement card
   promoted at 90h can anchor three requirements at 90h each next run. Same
   compounding family as the original ×1.4. Possibly inside AEH-234.
3. The `baseline-*`/`hidden-*` promotion guard (`writeback.ts:103`) is inert:
   items are persisted with cuids so the prefix never survives. Harmless only
   while nothing calls `injectInfraBaseline`/`runHiddenWorkAudit`.
4. `perItemMultipliers` (`complexity.ts:176`) has no runtime consumer — the
   "complexity multiplier already applied" comment in `taxation.ts:47` is stale,
   as is the `beHours/feHours` paragraph on `RoleLineItem` in `schema.prisma`.
