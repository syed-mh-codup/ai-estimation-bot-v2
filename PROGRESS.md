# AEH-227 — Shared costed-work type (FOCUSED)

Status: In Progress (Jira transitioned 2026-08-24).

## Agreed scope (grill-me, 2026-08-24)

Corrected inventory: 3 Prisma->shape READ maps + 1 WRITE map.
  - page.tsx:59      Prisma -> MenuItem   (Sheets export) -- fabricates 7 fields
  - writeback.ts:224 Prisma -> MenuItem   (promote)        -- fabricates same 7
  - page.tsx:157     Prisma -> ItemDTO    (editor)         -- omits them
  - run-estimate.ts:277 MenuItem -> Prisma (persist)       -- packs meta
  - rollup.ts:85 is NOT a Prisma mapping; removed from the ticket's list.

Root cause: MenuItem.meta / RoleLineItem.meta are WRITE-ONLY (audit pkg asserts
this). Read maps hardcode requirementIds/toggleable/notSafelyRemovable/
thinSlice/aiAssistApplied/dependsOn/anchorPresetIds. Inert today (no consumer
reads them) but Architect-computed flags are discarded on every read.

## LIVE BUG in scope
run-estimate.ts persists MenuItem WITHOUT id -> Prisma mints cuid; the semantic
id (hidden-<flag>-<ts> from audit.ts:47) is discarded, not even in meta.
So writeback.ts:103 `item.id.startsWith('hidden-')` is DEAD on the only
production path (inngest -> promoteEstimate). Hidden-work placeholders ARE
being promoted into the preset library. `baseline-` is minted nowhere = dead
everywhere. Looks tested because writeback-promote.test.ts calls the inner
promoteMenuItemsToPresets directly with in-memory semantic ids.

## Decisions
A1 toMenuItem/toLineItem parse meta back through the schema.
A2 meta:null -> zod defaults; legacy vs genuine-default indistinguishable (accepted).
A3 Both directions get named helpers.
B1 `injected` = real COLUMN on MenuItem (not a meta key). Behaviour-gating
   fields must be queryable + compiler-visible. Crosses ticket's stated
   "no DB model change" line -- approved by user.
B2 Fix dead guard here: `if (item.injected) continue;` drop baseline-.
B3 Shared zod base for SpecialistLineItem/RoleLineItem DEFERRED -> AEH-229.
   RoleLineItemSchema/MenuItemSchema stay canonical. Comment AEH-234 + AEH-229.
C1 Editor DTOs derive from Prisma payload types (DB = source of truth).
C2 Backfill historical injected cards. DRY-RUN AND SHOW USER FIRST.
   Match: taxonomyKey IN (infra.retries, infra.rate-limit, infra.data-migration,
   infra.legacy-adapter, infra.webhook) AND lineItem hours exactly
   DEV8/QA4/PM2/BA2 AND edited=false. TaxonomyKey alone false-positives
   (hasLineItemForFlag proves real cards carry those keys).
C3 Run the migration (additive, no reset). Dev/main DB is Neon.

## Work plan
1. [x] Baseline typecheck/lint/test (expect 3 pre-existing failures per 4271478)
2. [x] injected column + migration 20260824000000_menu_item_injected
3. [x] Backfill: NO-OP, DROPPED (evidence below)
4. [x] MenuItemSchema: injected boolean default false
5. [x] Mapping helpers (home: @repo/db, needs @repo/shared dep edge; no cycle)
6. [x] DTOs -> Pick over Prisma payload types
7. [x] Guard fix + audit.ts sets injected:true + run-estimate persists it
8. [x] Tests: meta round-trip; injected card not promoted VIA promoteEstimate (DB path)
9. [x] Verify typecheck/lint/tests
10.[ ] Jira: comment on AEH-227 ITSELF (full backtrace of work done -- user asked
     explicitly 2026-08-24), plus AEH-234 + AEH-229; transition AEH-227 -> Done


## CORRECTION (2026-08-24) -- claim retracted
I claimed hidden-work cards were being promoted into the preset library.
WRONG. `runHiddenWorkAudit` has NO production caller (only ws15.test.ts), so
no injected card has ever been created. writeback.ts:103 is a dead guard on an
UNWIRED feature -- latent, not live. The `injected` column is still the right
fix (makes the stage safe to wire later) but it is pre-emptive, not a leak fix.

ALSO NOTED: runHiddenWorkAudit is a fully built + tested pipeline stage that
nothing calls. Out of scope here; flag in Jira.

## Backfill dry-run (READ-ONLY, Neon dev/main, 2026-08-24)
MenuItem rows total:                     77
Estimate rows total:                      3
MenuItems with hidden-work taxonomyKey:   0
STRICT matches (key+DEV8/QA4/PM2/BA2+no edits): 0
Loose (taxonomyKey only) matches:         0
=> Nothing to backfill. No UPDATE written; column default `false` is already
   correct for all 77 rows. User informed.

## Migration applied 2026-08-24 (prisma migrate deploy, non-destructive)
- Neon dev/main   ep-polished-credit  OK (13 applied before, no drift)
- local docker    localhost:5433      OK
- Neon test DB    ep-wild-heart       OK
- prisma generate OK (injected in client)

## Baseline before my changes
typecheck: CLEAN. lint: CLEAN.
tests: 3 failed / 235 passed / 98 skipped; 18 suites failed to LOAD purely
because local docker postgres was down (now started). The 3 real failures are
pre-existing audit gates: field-audit x2 (AEH-228 gate 1), knip-baseline x1
(gate 2). NOT mine.

## Implementation notes (2026-08-24)
Helpers live in packages/db/src/menu-item-mapping.ts. @repo/db already had the
tsconfig path + project reference to ../shared; only the package.json dep was
missing. Exported via packages/db/src/index.ts.

THE KEY DELIVERABLE is the compile-time exhaustiveness assertion, not the dedup:
  type _MenuItemFieldsAllClaimed = AssertNever<
    Exclude<keyof MenuItem, MenuItemColumnKey | MenuItemMetaKey>>
Every domain field must be claimed by the column union or the meta key list.
VERIFIED by adding a probe field to MenuItemSchema: typecheck failed with
  menu-item-mapping.ts(110,3): error TS2344:
  Type '"probeField"' does not satisfy the constraint 'never'.
Probe removed, typecheck clean. Without this a `.default()` on a new field
would let parse invent it on read and the writer drop it -- the original rot.

Rule: readers spread meta FIRST so a column always wins a name collision.

id resolution (the ambiguity the ticket targets):
  MenuItem.id     = row cuid. run-estimate never persists the Architect's
                    MC-<DOMAIN>-<SLUG>. promote keys sourceMenuItemId on it.
  RoleLineItem.id = the SEMANTIC id from meta. dependsOn/anchorPresetIds
                    reference it by name, so reading the cuid here would leave
                    dependsOn dangling. Nothing in production reads a line
                    item's cuid off a domain object (editor uses its own
                    Prisma-derived DTO).

Adding `injected` to MenuItemSchema immediately broke 2 MORE hand-written
MenuItem literals the ticket never listed -- architect.ts:240 and taxation.ts:92.
Mechanism working as intended. Both now use MenuItemSchema.parse() per the
4271478 precedent (input-shaped literal annotated with the OUTPUT type is the
exact z.input vs z.infer trap).

## TWO dead/unwired features found (both out of scope, flag in Jira)
- runHiddenWorkAudit    (audit.ts)    no production caller -> hidden- ids
- injectInfraBaseline   (taxation.ts) no production caller -> baseline- ids
  (its own comment says so; AEH-253 owns it)
=> BOTH sources of the guard's id prefixes are unwired, which is the full
   explanation for why that guard was dead. Both now set injected:true so they
   are correct if ever wired up.


## Audit-tooling interaction (important, cost me two wrong attempts)
`@repo/audit`'s discoverJsonKeys finds which keys a Json column persists by
requiring the `meta:` property's initializer to be a BARE ObjectLiteralExpression
and fingerprinting sibling property names to attribute the model. Therefore:
  - a loop over a key list  -> audit goes blind (verified: MenuItem.meta -> undefined)
  - `satisfies MetaBlob<..>` -> ALSO blind (wraps node in SatisfiesExpression)
  - bare literal + narrowed RETURN TYPE (CreateDataWithMeta) -> works, and still
    enforces exhaustiveness. This is why the write helpers look the way they do.
DO NOT "tidy" those literals into a helper or add `satisfies`.

## Verified gate impact (same test, baseline worktree at 4271478 vs now)
gate 1 findings:      42 -> 38  (-4)
audit:fields orphans: 46 -> 42  (-4)
Removed: MenuItem.meta.requirementIds, RoleLineItem.meta.{id,requirementId,dependsOn}
  -- no longer write-only because the helpers read them back.
Added: NONE. MenuItem.injected avoided becoming an orphan by filtering
  `where: { injected: false }` in promoteEstimate's query (a real consuming
  read; `injected: row.injected` is classified as a WRITE, not a consumer).
knip gate: zero new entries from packages/db/src/menu-item-mapping.ts.

The stray "28" in my first baseline note was measured BEFORE `prisma generate`;
regenerating the client shifted type attribution repo-wide. Ignore it.

## Tests added, all verified to have TEETH
packages/db/src/menu-item-mapping.test.ts (4 tests)
  Fixture sets EVERY field away from its schema default on purpose -- the old
  fabricated values were all defaults, so a default-valued fixture would pass
  against the very bug being fixed.
  Teeth check: removing meta read-back -> 3 of 4 fail.
writeback-promote.test.ts
  Rewrote the id-prefix test -> injected:true, and ADDED a test through
  promoteEstimate (the DB path the old test could not reach).
  Teeth check: restoring the old id-prefix guard -> both fail, the DB-path one
  with "length 1 but got 2" = the placeholder WAS promoted. That is the bug.
  Fixtures now parse through their schema instead of `as MenuItem`.

## FINAL STATE
typecheck CLEAN. lint CLEAN. tests 3 failed / 337 passed / 1 skipped.
All 3 failures pre-existing AEH-228 gates (2 field-audit + 1 knip), all present
at 4271478. Test count rose 235 -> 337 passed because local docker postgres is
now running (18 suites could not load before).


## Production-data sweep (READ-ONLY, Neon dev/main, 2026-08-24) -- REQUIRED CHECK
The read maps used to tolerate anything; MenuItemSchema.parse now THROWS. All
tests used synthetic rows, so real data was the unchecked third input.
  rows fetched: 77      parsed OK: 77      THREW: 0
  MenuItem meta=null:     0/77      (so read-back IS exercised on real data)
  RoleLineItem meta=null: 0/1925
  distinct phase values: [null, Core, Foundation, Enhancement] -- all valid

BEHAVIOUR CHANGE to know about: the read path is now strict where it was lenient.
  - CategorySchema is z.string().trim().min(1) -> permissive; all 31 distinct
    real category values pass. An EMPTY-STRING category would throw (none exist).
  - PhaseSchema is z.enum([Foundation, Core, Enhancement]) but the DB column is
    a free-form String?. This is the one field where a hand-edited DB value
    would now make exportSheetsAction / promoteEstimate throw instead of
    silently coercing.
Deliberately NOT given a lenient fallback: silently dropping an invalid phase is
the same "fabricate a default" pattern this ticket removes. phase is only ever
written from PhaseSchema-validated pipeline output (the editor never writes it),
so the only way a bad value gets in is direct DB manipulation, and that SHOULD
fail loudly.

## Commit hygiene
An over-broad `git add -A` had bundled the pre-existing working-tree state
(CLAUDE.md, repo-map.sh, WORKLOG.md deletion) into the migration commit.
Split out into 99d30e2 via reset --soft + re-commit; resulting tree verified
BYTE-IDENTICAL to the pre-rewrite tree. Nothing had been pushed.
