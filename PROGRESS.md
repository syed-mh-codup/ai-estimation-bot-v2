# Progress (session continuity only)

_No backlog or completion state here — that lives in Jira. This file is
just working notes for whatever's in flight right now._

## AEH-228 "No orphaned backend work" — THREE checks BUILT

Branch `feat/aeh-228-orphan-checks`. Jira AEH-228 In Progress.
Follow-up work catalogued in **AEH-253** (42 orphaned fields, 60 dead exports).

### State: both gates intentionally FAIL

Full suite (verified under Node 22.13.1, matching CI): 332 passed, 3 failed,
1 skipped — the 3 failures are one per gate. Nothing pre-existing broke.
Also verified under Node 24. Lint and typecheck both pass for packages/audit. Per the decision that known debt must not hide
behind an allowlist, no exemption was seeded, so CI is red until AEH-253 lands.

`master` already had 47 typecheck errors and a failing lint before this branch.
Pre-existing, in packages/agents + packages/core test files, unrelated.
(That is also why ci.yml was split into three jobs.)

    pnpm audit:fields     # orphan-field report
    pnpm audit:exports    # zero-caller export report

### What was built

`packages/audit` + `knip.jsonc`. Gates are vitest tests, so they block through
the existing `pnpm test` job with no workflow change.

- `src/prisma-schema.ts` — schema line parser. Asserts 0 unparsed lines; a
  silently-skipped field is an unaudited field.
- `src/source-set.ts` — ts.Program over apps/web/src + packages/*/src.
- `src/occurrences.ts` — R1–R7 classifiers + type-based attribution.
- `src/field-audit.ts` — orchestrator, Json key discovery, findings.
  All 8 Json columns are covered: those with discoverable keys are audited per
  key, those written as `{}` or via a variable fall back to a plain column
  target rather than being skipped.
- `src/knip-baseline.ts` — knip runner + two-way baseline diff.
- `src/zod-contracts.ts` — contract-field audit (gate 3). Added because item 3
  of the ticket (`SupervisorInput.changedMenuItemIds`) has no column behind it,
  so neither the column audit nor knip could ever see it.

**Gate 3's rule is deliberately much stricter than gate 1's:** a zod field is
flagged only if the identifier appears NOWHERE outside its own declaration.
Zod schemas here are LLM I/O contracts and input schemas get serialised whole
into prompts, so "no property access" does not mean dead — a read-classification
rule would flag dozens of fields the model genuinely consumes. 195 fields
audited, 4 flagged. It under-reports on purpose.

### Three things worth not re-deriving

**1. knip needs all of: `--production`, `!`-suffixed patterns, and barrels NOT
as entries.** Any one missing and the check reports nothing.
- Test files count as callers by default. Neither a `!src/**/*.test.ts`
  negation in `project` nor an `ignore` entry removes them from the import
  graph — both only suppress reporting. Only production mode drops them.
  Proof: `knip --trace-export recordActuals` -> `ws20.test.ts:import[...] OK`.
- Production mode honours only `!`-suffixed entry/project patterns.
- Every `packages/*/src/index.ts` is a wall of `export * from './x'`. As an
  entry file, everything it re-exports is public API = used = 0 findings.

**2. knip's JSON has a preamble containing an unquoted brace**, so "slice from
the first `{`" fails. Anchor on `{"issues":`:
`◇ injected env (12) from apps/web/.env.local // tip: … { path: '…/.env' }`

**3. A Json key is consumed only if its COLUMN is read back out of the DB.**
Key-name reads are not evidence: the pipeline reads `requirementIds` and
`dependsOn` off in-flight zod objects whose shape is near-identical to the DB
row's, so structural attribution cannot tell "read what we stored" from "read
it before storing". Nothing reads `MenuItem.meta` or `RoleLineItem.meta` at all.

### Verified, so don't re-test from scratch
- Acceptance 31/31: all 16 known orphans flagged, none of 15 known-live fields.
  141 targets audited, 42 orphans.
- Hard gate: 114 files, 98.7% attribution resolution.
- Anti-rot, all 9 paths, by deliberate breakage + revert: valid exemption
  suppresses (column + Json key); exemption on a live field -> stale-exemption-
  consumed; @orphan-todo with no ticket -> malformed; annotation on a relation
  -> misplaced; @backend-only:key for an unwritten key -> stale-missing-key;
  knip baseline entry suppresses / vanished -> stale / bad reason -> malformed.
- The gate THROWS if knip is missing rather than skipping (hit for real when a
  branch switch pruned the bin symlink).

### Known limitations (stated in AEH-253, not bugs)
Transitive orphans out of scope (`requires` will surface once Group 1 lands).
DB-state orphans invisible (unembedded presets). Read-modify-write reads as
carry-forward — do NOT weaken R3 to fix it, that reintroduces the
`PresetVersion.notes` miss.

Plan file: `~/.claude/plans/please-start-planning-your-encapsulated-gadget.md`
