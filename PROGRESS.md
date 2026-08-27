# AEH-263 — Ship the hidden-work feature

Status: IN PROGRESS (Jira AEH-263 transitioned to In Progress 2026-08-27).
Plan file: ~/.claude/plans/catching-uncosted-hidden-work-modular-snowflake.md (APPROVED)

Previous ticket AEH-227 (shared costed-work type) closed 2026-08-24 — its full
backtrace lives in Jira comments on AEH-227/229/234/253, not here.

## The decision (2026-08-27)

AEH-263 was a DECISION ticket: does the unwired audit stage ship or get deleted?
**Decision: it ships.** User: "catching uncosted hidden work is one of the core
responsibilities of this product."

The ticket is now an IMPLEMENTATION ticket. Its Jira description still describes
the decision and needs rewriting (see Post-approval below).

## Decisions locked with the user (7 rounds of grill-me)

1. Injected cards carry DERIVED hours, never placeholders. Delete
   HIDDEN_WORK_DEFAULT_HOURS (flat DEV8/QA4/PM2/BA2). Hours come from
   runSpecialistCouncil — the same path every real card uses.
   User: "they should be a best effort estimation for the work that the line
   item describes. if this is decided by the user-editable prompt, flag that
   in AEH-233."
2. Known flags auto-cost; novel flags SURFACE to a human. Nothing silently
   dropped. audit.ts:25 inverts from "unknown flag = not our concern" to
   "unknown flag = needs a human".
3. Hidden work flagged for analysis (hidden vs asked-for), in queryable
   columns/rows, NOT meta JSON (AEH-227's B1 rule).
4. Finalise gate is an ADMIN TOGGLE — warn or block. User: "we may need this to
   be a toggle for admins to go between warning and blocking."
5. Real taxonomy + GOVERNANCE. infra.* AND process.* branches. User: "the list
   needs to be verifyable, editable, auditable, and new items being added should
   be reviewable by admins and either accepted or collapsed into an existing
   taxonomy independently of an estimate in progress."
6. Accepted inferred work PROMOTES to the preset library. `injected` stays true
   forever for analysis; promotion filters on outcome.
7. Coverage = a RECORDED CLAIM (coversRiskFlags on SpecialistOutput), not a
   string match. Oracle (AEH-259) later answers "which risks were claimed and
   what happened" by reading it. Oracle does NOT gate injection — AEH-259 is
   read-only and optional by design ("an estimate can start and finish without
   Oracle ever being opened").
8. Overhead does NOT double-count. User's clarification, and it is the crux:
     - pmCommunicationTaxPct prices THE PM'S SEAT in a meeting.
       process.meetings prices the DEV and QA seats at the SAME meeting.
     - qaRegressionBufferPct prices REGRESSION SWEEPS.
       process.ticket-reopens prices PER-REOPEN CHURN — bug writeup, context
       switch back, re-fix, re-review.
     - process.code-review / process.unit-testing are DEV-side, and DEV carries
       no multiplier at all (taxation.ts:47).
   Each hour is claimed by exactly one mechanism.
9. ONE TICKET, ONE DELIVERY. All phases land together under AEH-263.

## What scoping found (all verified in code, all change the work)

1. THE COVERAGE CHECK CAN NEVER MATCH. hasLineItemForFlag (audit.ts:23-27)
   compares `infra.retries` against MenuItem.taxonomyKey. But architect.ts:251
   writes `taxonomyKey: card.id` (an MC-<DOMAIN>-<SLUG> id) and actions.ts:159
   hardcodes 'custom'. Every flag reads as uncovered on every run => duplicate
   scope alongside work the Architect already costed. This is why decision 7
   exists.
2. THE infra.* TAXONOMY KEYS DON'T EXIST. Keys are DERIVED (seed-taxonomy.ts:
   73-74) as `${slug(category)}.${slug(reqType)}` from preset rows. The workbook
   yields 6 category slugs; none is `infra`. Same for all 3 baseline.* keys.
   There is NO taxonomy authoring surface at all.
3. VOCABULARY IS OPEN AND 3-WAY INCONSISTENT. detective.ts:99 teaches the model
   `api-quota` (no table entry); the table has `data-remediation` and
   `webhook-reliability` (never shown to the model).
4. THE SEAM WAS PRE-PLANNED. step-error.ts:11-12 already carries 'HIDDEN_WORK'
   and 'VALIDATION' in AgentStep, between TAXATION and ARCHITECT. Nothing
   constructs them. docs/04_WBS.md:279 reserves WS26-03 for this exact e2e.
5. NOTHING SURFACES RUN DIAGNOSTICS. No UI reads agentState, gateWarnings or
   consistencyFlags. checkSupervisorGates runs on every estimate and goes to
   console.warn only. Any warning path needs UI or it ships nothing.

## VERIFIED 2026-08-27: the live DETECTIVE prompt does NOT list risk flags

Read DETECTIVE v3 (active, 5822 chars, openai/gpt-4o-mini) straight from Neon
dev/main. Its FOCUS AREAS are PLATFORM-oriented (P21/Celigo/Contentful/Klevu/
Shopify/Act-On), not a flag vocabulary. It has a "The following fields ARE
closed" section covering phase/project_size/data_volume/ai_assist/risk/role —
riskFlags is NOT among them.

=> The flag vocabulary lives ONLY in code at detective.ts:99. Phase 2 is a PURE
   CODE CHANGE. No DB prompt version bump, no per-environment rollout, no
   seed-revert hazard. This was the single biggest unknown and it resolved the
   easy way.

## Baseline before any of my changes (2026-08-27, local docker started first)

pnpm test: 3 failed / 337 passed / 1 skipped (341), 2 files failed of 50.
Identical to the AEH-227 close-out baseline. The 2 failing files are the
pre-existing AEH-228 gates: field-audit x2, knip-baseline x1. NOT mine.
Gate 1 findings sit at 38 — do not let a new agentState Json key make it 39.

Local docker postgres (:5433) was DOWN at session start; `docker compose up -d`
started it. Without it 18 suites cannot even load.

## Work plan (phases; all land together under AEH-263)

1. [x] Taxonomy governance: status + collapsedIntoKey + migration; filter
       loadTaxonomyEntries to ACTIVE; seed infra.* + process.*; /admin/taxonomy
       with the proposal accept/collapse queue. Evals before AND after.
2. [x] Vocabulary: shared const interpolated into detective.ts:99; reconcile the
       3-way drift; complexity.ts:91-92 exact membership; invert audit.ts:25.
3. [~] Coverage contract: schema field done; specialist PROMPT still to do. coversRiskFlags on SpecialistOutput + prompt + persist.
4. [ ] Pipeline wiring (NEXT): between Architect (:224) and taxation (:235).
5. [ ] injectInfraBaseline: migrate the stored infraBaseline SHAPE first, then
       seed process.* items and wire.
6. [ ] Promotion: writeback.ts:229 filters on outcome, not `injected`.
7. [ ] Frontend: ItemDTO widening, INFERRED row treatment, rollup split, rail
       panel, server actions, gate.

## Landmines to carry (each cost someone time already)

- acknowledgedAt is a Date (audit.ts:127). A Date VIOLATES the step JSON
  memoisation contract (run-estimate.ts:24-37, enforced by
  run-estimate.test.ts:193-234). Use an ISO string across any step boundary.
- Step ids: `hidden-work:${flag}`. NEVER the `specialists:` prefix —
  run-estimate.test.ts:221 asserts on that prefix's cardinality.
- Council failure for an injected card => an OPEN finding, NOT flat defaults
  (consistent with decision 1, and stops a refinement failing the whole run).
- Injection goes BEFORE applyTaxationToMenuItems (run-estimate.ts:235) so
  council-derived hours get taxed. The OLD injectors deliberately set
  taxedHours = baseHours; derived hours are different and SHOULD tax.
- Findings go in a REAL TABLE, not agentState. run-estimate.ts:285-293 writes
  agentState as a bare object literal, which is exactly the shape
  discoverJsonKeys (field-audit.ts:110-113) fingerprints. A new key with no
  consuming read = orphan finding 39 of 38.
- EstimationConfig tunable = an 8-file procedure. The one people miss is
  apps/web/e2e/global-setup.ts:121-132 — it does an EXPLICIT create that does
  NOT reuse configData, so a non-defaulted column breaks every e2e run.
- NEVER run `pnpm db:seed` against a DB with admin-edited prompts. seed.ts:
  174-198 deactivates every active PromptVersion and upserts v1 with the stub
  body — silently reverting the live prompts. This is AEH-233's central finding.
- New taxonomy nodes feed the Librarian's classification vocabulary
  (run-estimate.ts:333-339 -> librarian.ts:154, rag-retriever.ts:29). Filtering
  to ACTIVE is what bounds the blast radius; PROPOSED nodes change nothing.
- injectInfraBaseline's stored config shape does NOT parse: seed.ts:138 writes
  {devops, environments}, InfraBaselineSchema wants {items:[{title,taxonomyKey,
  roles}]}. It would throw at taxation.ts:86 today.
- Existing pipeline tests assert EXACTLY 2 menu items (run-estimate.test.ts:214,
  228, 242, 257). A third injected card breaks all four — that is the teeth you
  want, but scope it to a NEW estimate/describe, don't mutate the shared stub.
- Fixtures .parse() through their schema, never `as MenuItem`
  (ws15.test.ts:10-13 is the exemplar; PROGRESS/AEH-227 rule).

## Design (Warm Ledger is live on master — globals.css:3-17)

Colour contract is a stated rule: green settles, bronze is in flight, brick
failed; "colour never travels alone — every pill carries its label"
(pill.tsx:5). Inferred scope is unsettled => bronze. No fifth hue.

Metaphor: an inferred card is a MARGIN ANNOTATION — the bookkeeper noted it, the
invoice didn't say it. NOT a broken card, so no amber warning badge.

- Row (ItemRow, MenuCardEditor.tsx:452): bronze hairline margin rule in the
  gutter + INFERRED micro-chip beside the title (the 9.5px idiom already used by
  the "Off" chip at :530-534) + provenance line in text-ink-4
  ("rate-limits · SOW §3.2"). NO background tint.
  Do NOT reuse the hatch at :473-480 — that means DISABLED, a state an inferred
  card can also be in.
- Rollup split (the signature): RollupCard.tsx:65-72 already discloses a subset
  against the headline ("N items switched off"). Same dashed-top-border pattern:
    Total 412h / asked for 368h / inferred 44h.
- Unreconciled panel: the STICKY RAIL below RollupCard. NOT RunControls —
  RunControls.tsx:134-164 collapses to one line once hasMenu && (DONE||IDLE),
  i.e. exactly when the estimator is editing.
- Gate: Finalise (page.tsx:249-295) reads the open-finding count.

## Post-approval Jira (not done yet)

- Rewrite AEH-263's description — decision ticket becoming implementation ticket.
- Comment AEH-233: inferred-card hours are Specialist-derived, so they inherit
  the recorded calibration gap (QA/PM/BA out of band on EVERY live run;
  sow-simple at 160-190h for a 30-60h job). User asked for this flag twice.
- Comment AEH-259: its corpus list predates HiddenWorkFinding; Oracle answers
  "which risks were claimed" by reading it + coversRiskFlags.
- Comment AEH-253: the audit-stage half of its register resolves by WIRING, not
  deleting. Also note AEH-263 no longer blocks it in the "might delete" sense.
- Comment AEH-251: items two and three remain open.
- All writes via the jira-text skill, read back and diffed.

## Push state

master is 1 commit ahead of github/master (1e9fbb4, the grooming notes).
bitbucket origin/master also behind. Nothing deployed — .github/workflows/ci.yml
has lint/typecheck/test only, no deploy step; prod deploys come from Vercel's git
integration on push. Awaiting the user's go-ahead to push.


## DONE SO FAR (2026-08-27) — commits on master

  df83d0a  taxonomy governance: status + classifiable + infra.*/process.* seed
  b2a86bb  taxonomy admin UI: review queue, versioned edits, audit trail
  d523b37  one risk-flag vocabulary; coverage as a claim; flat defaults deleted
  (+ HiddenWorkFinding table, uncommitted at time of writing)

### Deviations from the approved plan, and why

- ADDED `TaxonomyNode.classifiable` (a second migration, 20260827010000).
  The plan only had `status`. Snapshotting the live taxonomy made it obvious the
  taxonomy has TWO consumers that were never distinguished: the Librarian's
  classification vocabulary (SOW requirement -> key) and the label space for
  injected cards. `process.code-review` belongs only to the second — nobody
  writes it in a SOW, so offering it to the Librarian just gives a real
  requirement somewhere wrong to land. `infra.*` belongs to both. Without this
  the plan's own "seed both branches" step would have expanded the Librarian's
  vocabulary by 12 semantically-wrong entries. Blast radius is now +7 (infra
  only, all legitimately askable), verified 37 -> 44.
- DROPPED `runValidationAudit`, `acknowledgeUnreconciled`, `AcknowledgementRecord`
  and `ValidationAuditOutputSchema`. The DB (HiddenWorkFinding.outcome) is the
  state now, so these pure in-memory functions had no job left. WS15-03 still
  ships — as dismiss-with-a-reason in the UI, with a real table behind it.
- DROPPED the planned `MenuItem.injectedOutcome` column. Finalising an estimate
  with an injected card present and enabled IS the human acceptance — the
  estimator could have deleted or disabled it. Promotion therefore just stops
  excluding `injected` rows rather than needing a second mirrored column, which
  also keeps the field audit clean. FLAG TO USER: the option they picked showed
  `injectedOutcome` in its preview; substance is identical, machinery is less.
- Taxonomy "New node" is its own /admin/taxonomy/new route behind a header
  button (user feedback: mirror the presets pattern, not an always-open form).

### Verified along the way

- Live DETECTIVE v3 body read from Neon: contains NO risk-flag list. The
  vocabulary really does live only in code. Phase 2 needed no DB prompt bump.
- Field-audit orphans 38 -> 35: the taxonomy admin UI gave changeReason,
  changeMotivation and createdBy their first consuming reads.
- Tests 3 failed / 338 passed (baseline was 3 / 337). The 3 are the known
  AEH-228 gates. run-estimate.test.ts flaked ONCE in a full run and passes
  consistently since — it shares a DB and estimate id with evals.test.ts.
  Pre-existing isolation smell, not caused by this work.
- Migrations applied to all three DBs each time (local docker, Neon dev/main,
  Neon test): 20260827000000, 20260827010000, 20260827020000.
