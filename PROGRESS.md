# Progress (session continuity only)

_No backlog or completion state here — that lives in Jira. This file is
just working notes for whatever's in flight right now._

## Current session — AEH-228 "No orphaned backend work"

Branch: `feat/aeh-228-orphan-checks` (from master). Jira: In Progress.
Plan: two CI-blocking checks. Known orphans get NO exemption (user's call),
so CI goes red until the umbrella follow-up ticket lands.

### DONE — Check B (knip) config, spike PASSED

The spike was the highest-risk unknown and it needed three pieces together.
Any one missing and the check reports nothing:

1. `--production` mode. Test files count as callers otherwise, and NEITHER a
   `!src/**/*.test.ts` negation in `project` NOR an `ignore` entry removes them
   from the import graph — both only suppress reporting. Proof:
   `knip --trace-export recordActuals` -> `ws20.test.ts:import[recordActuals] OK`.
2. `!`-suffixed entry/project patterns. Production mode only honours those.
3. Package barrels deliberately NOT entries. Every `packages/*/src/index.ts` is
   a wall of `export * from './x'`; as an entry, everything it re-exports is
   public API and thus "used" -> 0 findings.

Acceptance: flags `runSupervisor`, `recordActuals`, `embedPromotedPresets`;
does not flag `promoteMenuItemsToPresets`, `backfillPresetEmbeddings`,
`runEstimate`, `presetEmbeddingText`, `runIngest`, `devEffortOf`,
`findNearestPresets`. No generated-client leak.

**60 dead exports found** — far more than the ticket's one example. Two are
worth calling out because they are duplicate-implementation smells, not just
dead code:
- `packages/core/src/versioning.ts#diffVersions` is dead; `apps/web/src/app/
  admin/presets/[id]/page.tsx:158` defines its own local `diffVersions`.
- `packages/core/src/prompt-service.ts#loadActivePrompt` is dead;
  `packages/agents/src/run-estimate.ts:351` defines its own local one.
Also 6 dead exports in `versioning.ts` and 3 in `prompt-service.ts` — much of
`@repo/core`'s public API has no caller.

Run it as: `knip --production`. Plain `knip` is NOT equivalent.

### NEXT — Check A (orphan-field audit)
`packages/audit` is scaffolded (package.json + tsconfig). Still to build, in
this order (step 3 is a hard gate):
1. `src/prisma-schema.ts` — line parser; verify 14 models, 10 enums, no
   unparsed lines. Confirmed safe: zero `@map`/`@@map` in the schema.
2. `src/occurrences.ts` — `ts.Program` with `moduleResolution: Bundler`.
   HARD GATE: if `attributionResolvedRatio < 0.8`, fix module resolution
   before writing any classifier.
3. Rules R1-R7 (see plan) — R5 form-echo and R6 where-key are both
   load-bearing; without R5 ticket item 5 goes unflagged, without R6
   `sourceMenuItemId` becomes a false orphan.
4. Attribution, then the gate tests.

Plan file: `~/.claude/plans/please-start-planning-your-encapsulated-gadget.md`

### Gotcha for the knip JSON parser
knip prints a preamble line to stdout before the JSON, and that preamble
itself contains an unquoted `{`:
`◇ injected env (12) from apps/web/.env.local // tip: ⌘ custom filepath { path: '/custom/path/.env' }`
So "slice from the first `{`" does NOT work. Anchor on `{"issues":`.
