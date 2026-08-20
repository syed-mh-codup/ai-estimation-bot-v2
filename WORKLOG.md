# WORKLOG — feature backlog

> **Last groomed 2026-08-20.** The five original entries are resolved (four
> shipped, one superseded) and each carries a line naming the commit. Everything
> after them is open.
>
> On the resolved five: the original analysis is left intact because it's still
> the best write-up of *why* each thing mattered, and several entries diagnosed
> bugs the fix then confirmed. One did NOT ship as written — "Split DEV into
> separate Frontend and Backend estimates". The decision went the other way: dev
> effort is ONE figure with side flags for reference, because delivery is
> full-stack. See PROGRESS.md.

## Sequencing (agreed 2026-08-20)

Not a strict order — but this is the reasoning, so nobody has to reconstruct it.
Full prioritisation is being done separately.

**Do first — these protect everything after them, and they're cheap:**
1. **Round-trip test** (WBS → promote → retrieve → assert). Would have caught the
   1.4× inflation on day one. See *Never let the WBS and the preset library
   drift apart again*.
2. **Shared costed-work type — FOCUSED.** Kills the twelve-files-per-field
   mechanism that produces drift.
3. **No orphaned backend work** — orphan-field audit + zero-caller check. Every
   failure this backlog records was *silent*; this is the general fix.

**Then, whichever is more urgent commercially:**
- **Dependency edges** (in *Preset model rework* §2) — the hard prerequisite for
  the configurable-estimate menu card. Do this if presales is the priority.
- **The comparison-delta fix** (§3) — the item most likely to improve estimate
  quality on its own, and a plausible contributor to the calibration gap. Do this
  if accuracy is the priority.

**Deliberately deferred:** *Shared costed-work type — FULL*. It should be
answered by the preset rework, not decided ahead of it.

## Index

**Open — infrastructure / correctness**
- Never let the WBS and the preset library drift apart again
- Shared costed-work type — FOCUSED
- Shared costed-work type — FULL unification *(deferred)*
- No orphaned backend work
- Detective's spike-preset range is hardcoded
- `nonDev` in supervisor-gates includes DEV
- Fix the Google Sheets export *(never run live)*
- Review and revise the agent prompts *(live prompts have drifted from the repo)*

**Open — product**
- Configurable estimate — a menu card the client picks from
- Estimate lineage — successors and branches
- Multi-level approval on estimates
- AI-assisted WBS editing
- Artifact generation alongside the WBS *(ERD / user flow / wireframes, UI-extensible)*
- Custodian on estimates, with deadlines and reminders
- Preset model rework
- Steering input for estimates

**Decisions recorded (not work)**
- The seeded 45 keep their original ids

**Resolved** — the five 2026-07 entries below; see each entry's status line.

---

## Steering input for estimates (requested 2026-07-08)

**What:** Let the user supply "steering" guidance on an estimate — specific
instructions on how to plan/execute a particular requirement — instead of
leaving every execution decision entirely up to the LLM. Example: telling the
system "use the existing auth service, don't build a new one" or "this
integration should be a thin polling adapter, not a real-time webhook" for
one specific requirement within a larger BRD.

**Why:** Right now the agents (Librarian → Specialists → Architect) infer
approach entirely from the SOW/BRD text. When the estimator already knows a
constraint or preference the document doesn't state explicitly, there's no
way to feed that in — the only lever is editing the source document itself,
which is often not desirable (the BRD is the client's document, not scratch
space for internal planning notes).

**Key design constraint (explicitly flagged by the requester):** steering
must be scoped and tactful — it must not "derail" or dominate the whole
estimate. A steering note aimed at one requirement should not bleed into how
unrelated requirements are planned. This is the same class of failure this
codebase already hit once: see the estimate-quality-prompt-code-drift memory
and PROGRESS.md's "generalize classification vocabulary" work, where a
strong global signal (the ecommerce preset library baked into every prompt)
skewed classification for everything, not just the cases it legitimately
applied to. Steering input needs to avoid repeating that mistake — it should
be a targeted, bounded signal, not a global system-prompt addition.

**Possible integration point (not committed to, just a starting thought):**
the pipeline already calls SPECIALIST_DEV/QA/PM/BA once per requirement
(`packages/agents/src/specialist.ts` → `buildUserMessage`), so a
per-requirement `steeringNotes` field threaded only into that specific
requirement's specialist call would be naturally scoped — it wouldn't touch
the prompt/context for any other requirement. This would likely mean:
- A new optional field on `Requirement` (`packages/shared/src/schemas.ts`)
  and the corresponding DB column.
- A UI surface for the user to attach steering text to a requirement, most
  naturally after the Librarian has decomposed the SOW (so the user is
  steering an actual identified requirement, not guessing at decomposition
  in advance) — likely a review step between Librarian and the rest of the
  pipeline, which doesn't fully exist yet (today the pipeline runs straight
  through Librarian → Specialists with no pause for human input).
- Explicit instruction to the Specialist prompt that steering is a
  constraint on ONE requirement's execution approach, not a signal about the
  rest of the project — i.e. avoid the same over-generalization failure mode
  as the closed-vocabulary bug.

**Status:** NOT STARTED — the one open item in this file. Still needs the
Librarian-review pause step that doesn't exist yet; see the design risk above.

---

## User profile screen — see own name, change own password (requested 2026-07-17)

**What:** A self-service profile screen. Today a user can neither see their own
name nor change their own password.

**Why it's a real gap, not a nice-to-have:** the admin create-user dialog
already promises this twice — `CreateUserDialog.tsx:108` says "At least 8
characters. **They can change it after signing in**" and `:53` says "They can
sign in right away with the temporary password." Neither is true. There is no
route, no server action, and no code path that ever re-hashes a password after
`createUser` (`admin/users/page.tsx:55-56`). Every user is stuck on the
temporary password an admin typed for them, forever.

**Current state (verified):**
- No `/profile`, `/account`, or `/settings` route exists.
- `User.name` exists (`packages/db/prisma/schema.prisma:78-86`, nullable) and
  rides onto the session via NextAuth's default mapping (`auth.ts:47`), but is
  **never rendered anywhere**. `components/nav.tsx:64` shows `session.user.email`
  only. The one place `name` is read at all is the notification email
  (`inngest/functions.ts:23`). The admin user table doesn't select it either
  (`admin/users/page.tsx:94-103`).
- Password column is `hash`, not `password`. Helpers already exist:
  `hashPassword` / `verifyPassword` in `apps/web/src/lib/password.ts` (bcryptjs,
  12 rounds).

**Shape of the work:**
- New `apps/web/src/app/profile/page.tsx` server component under `AppShell`.
  Convention to follow: inline `'use server'` actions in the page file (as
  `admin/users/page.tsx` does) or a sibling `actions.ts` (as
  `estimates/[id]/actions.ts` does); client form via `useActionState` returning
  `{ ok?, error? }` (copy `CreateUserDialog.tsx:9,30`).
- Change-password must require the current password (`verifyPassword`) — an
  admin-set temporary password is exactly the case where re-auth matters.
- Reuse `MIN_PASSWORD_LENGTH` from `admin/users/page.tsx:13` rather than
  re-declaring the rule (it should probably move to a shared module).
- Render the name in `nav.tsx:64` alongside/instead of the email once it's
  editable, otherwise "see their name" isn't actually satisfied.
- Note: `session: { strategy: 'jwt' }` (`auth.ts:51`), so a name change won't
  appear until the JWT refreshes. The DB-backed `jwt` callback
  (`auth.ts:59-75`) already re-reads the user every request for `role` — extend
  its `select` to carry `name` too.

**Status: DONE** — `fe68a60`. `/profile` with name + change-password (requires
the current password). `MIN_PASSWORD_LENGTH` moved to `lib/password.ts`; the
jwt callback carries `name` so a rename lands without re-login. The session
caveat noted above was later closed too: `passwordChangedAt` (`63344b0`) now
signs other devices out.

---

## Split DEV into separate Frontend and Backend estimates (requested 2026-07-17)

**What:** Presets carry separate frontend and backend estimates, but a produced
estimate only has a single flat `DEV` figure. Make the dev specialist emit
FE and BE separately so the two sides of the app agree.

**The disconnect is confirmed and it is worse than a display inconsistency.**
`PresetVersion` has exactly two effort columns — `beHours` and `feHours`
(`packages/db/prisma/schema.prisma:139-140`), sourced from
`docs/Estimate Presets (ISM).xlsx` (`packages/db/src/seed-presets.ts:40-63`;
45 presets, P01–P45). A preset is *purely* a BE+FE dev anchor — it has no
QA/PM/BA at all. Meanwhile the pipeline's vocabulary is
`RoleKind = DEV | QA | PM | BA` (`packages/shared/src/schemas.ts:5`,
`schema.prisma:76-81`) with one indivisible DEV and four specialists
(`packages/agents/src/specialist.ts:232`).

**Exactly where the split dies today —** `packages/agents/src/specialist.ts:45`:
```ts
const anchor = `BE=${m.beHours ?? 0}h, FE=${m.feHours ?? 0}h`;
```
The FE/BE numbers survive retrieval end to end (`ArchivistMatch.beHours/feHours`,
`schemas.ts:255-256`; selected in `archivist.ts:99-100`; even shown to the
reranker at `archivist.ts:154`) and are then **flattened into a prose sentence
and handed to a single DEV specialist**, which returns one undifferentiated
`lineItems[]`. Nothing structured ever consumes the split.

**The strongest argument for doing this first —** `packages/agents/src/writeback.ts:70-72`:
```ts
const devLineItems = item.lineItems.filter((l) => l.role === 'DEV');
const beHours = devLineItems.reduce((s, l) => s + l.taxedHours, 0);
const feHours = Math.round(beHours * 0.4); // approximate FE split
```
Because an estimate has only DEV, writing one back to a preset requires
**inventing** the FE number: it assigns 100% of DEV to BE and then fabricates FE
as 40% *on top*, inflating the preset by 1.4× versus the estimate it came from.
`recordActuals` (`:178-179`) does the same to real post-delivery hours, so the
feedback loop as written would corrupt the preset library rather than calibrate
it. Splitting DEV turns both lines into an exact mapping. **This item should
land before the finalize→preset loop below is wired up.**

**Touch points (every one verified):**

| Layer | file:line |
|---|---|
| DB role enum (+ migration for existing `RoleLineItem` rows) | `packages/db/prisma/schema.prisma:76-81`, `:327` |
| Agent kind enum (needs new `Prompt` rows) | `schema.prisma:56-59` |
| Shared zod `RoleKindSchema` / `AgentKindSchema` | `packages/shared/src/schemas.ts:5`, `:13-16` |
| Step-error retry names | `packages/agents/src/step-error.ts:6` |
| Agent factory | `packages/agents/src/agent-factory.ts:50` |
| Versioning prompt-kind union | `packages/core/src/versioning.ts:55` |
| Specialist ctx / roster | `packages/agents/src/specialist.ts:11,58,117-126,232` |
| Anchor prose → feed `beHours` to BE, `feHours` to FE | `specialist.ts:45` |
| Prompt loading (one `loadActivePrompt` per new kind) | `packages/agents/src/run-estimate.ts:118` |
| **Gates** (see below) | `packages/agents/src/supervisor-gates.ts:50,59,64-82` |
| Taxation DEV branch + `InfraBaselineItemSchema.roles` | `packages/agents/src/taxation.ts:16,44-47,91` |
| Infra baseline literals `{DEV: 16, …}` | `taxation.ts:141,146,151` |
| UI `ROLES` tuple (drives all columns) | `apps/web/src/app/estimates/[id]/ledger-context.tsx:29,42,149,163` |
| UI `Role` type + `taxPercents` | `estimates/[id]/page.tsx:24,38` |
| UI rollup buffer labels | `estimates/[id]/RollupCard.tsx:24,47` |
| UI rows — 6 `ROLES.map` sites (a 5th column) | `estimates/[id]/MenuCardEditor.tsx:251,318,391,529,573,581` |
| Sheets export per-role tabs | `packages/agents/src/sheets-export.ts:47` |
| Admin prompt kind lists | `admin/prompts/[kind]/page.tsx:17`, `[kind]/[version]/page.tsx:17` |
| Writeback FE/BE fudge (becomes exact) | `packages/agents/src/writeback.ts:70-72`, `:178-179` |
| Presets page — already FE/BE, the one place that **wouldn't** change | `admin/presets/page.tsx:44,71`, `[id]/page.tsx:58-59,91-92,103,168-169,316` |

**Gates keyed off DEV — the trap.** DEV total is the *denominator* of all three
proportionality gates (`supervisor-gates.ts:68-82`): QA/DEV 15–60%, PM/(DEV+QA+BA)
8–25%, BA/DEV ≤30%. If DEV splits and these aren't updated to sum FE+BE, every
ratio silently halves its denominator and the gates start firing spuriously on
every run. Also `:63-67` requires ≥1 DEV line item per requirement — that rule
needs a decision: is FE-only or BE-only work legitimate (yes, probably), so the
check becomes "≥1 of either." Related latent bug spotted at `:73-74`: the
variable named `nonDev` is computed as `DEV + QA + BA` — it *includes* DEV. The
name lies; the arithmetic matches the message text. Worth fixing while in here.

**Also worth knowing:** prompts are DB-versioned, not files (`Prompt`/
`PromptVersion`, `schema.prisma:172-191`, loaded at run time by
`loadActivePrompt`, `run-estimate.ts:345`). The **live** SPECIALIST_DEV body
(only v1 active, `scripts/prompts-export.json:207`) is still the old stub
asking for `{"baseHours","rationale","assumptions"}` — a shape `specialist.ts`
no longer parses (it wants `{lineItems, assumptions}`, `:35-38`). It works only
because the real contract rides in the user message (`:76-90`). The system
prompt is drifted and mentions neither FE nor BE — this is the
prompt-code drift class of bug the estimate-quality memory already tracks.

**Status: SUPERSEDED — deliberately not built as written.** Dev effort is one
combined figure; `touchesFrontend`/`touchesBackend` flags on line items
(`eceb937`) and on presets (`5cdd883`) record which sides work covers without
dividing the hours. Because `RoleKind` never changed, none of the ~20 touch
points in the table above applied — no gate denominators, no taxation change,
no ROLES tuple, no new AgentKinds. The `nonDev` naming bug flagged above is
still unfixed (it's real, just unrelated).

---

## Preset creation + finalized estimates feeding the preset library (requested 2026-07-17)

**What:** (a) there's no way to add a new preset, and (b) finalized estimates
never become presets.

**(b) is already built and simply not wired up.** `packages/agents/src/writeback.ts`
contains a complete, unit-tested feedback loop: `promoteMenuItemsToPresets`
(`:16`) sets FINALISED, skips `baseline-`/`hidden-` items (`:33`), is idempotent
via `sourceEstimateId` (`:38-45`), versions and deactivates priors (`:48-60`),
creates the `PresetVersion`, then `embedPromotedPresets` (`:117-141`) embeds it.
`PresetVersion.sourceEstimateId` (`schema.prisma:165`) and
`ChangeMotivation.POST_DELIVERY_VALIDATION` (`:28`) exist purely to serve it.
**Callers outside tests: zero** — every reference is `packages/agents/src/ws20.test.ts`.
What the app actually calls is `finaliseAction`
(`apps/web/src/app/estimates/[id]/page.tsx:86-93`), which flips
`status: 'FINALISED'` and does nothing else.

**Where the hook goes:** `finaliseAction` needs `menuItems: { include: { lineItems: true } }`
— the sibling `exportSheetsAction` (`page.tsx:73-79`) already does exactly that
mapping. But embedding is a paid network call, so the cleaner placement is a new
Inngest function alongside `apps/web/src/inngest/functions.ts`, keeping finalize
fast and letting the embed retry independently (and respecting the Vercel Hobby
300s per-step ceiling). **Do the DEV FE/BE split first** — see the entry above
for why wiring this loop up today would actively corrupt the library.

**(a) Preset creation is seed-only, deliberately.** `admin/presets/` has only
`page.tsx` and `[id]/page.tsx` — no `new/` route, no create action. The list
page's empty state (`page.tsx:25-32`) literally tells you to shell out and run
`db:seed:presets`. `savePreset` (`[id]/page.tsx:26-84`) only edits an *existing*
preset into version N+1 and early-returns if no active version exists (`:42`),
so it can't bootstrap. `Preset.id` is `@id` with no default (`schema.prisma:125`)
— IDs are externally assigned (P01…P45), which is the seed-only intent made
structural. A create flow needs an ID strategy decision: keep human `P##` IDs
(and who picks the next number?) or move to cuid for user-created presets.

**🔴 Separate finding, arguably bigger than either of the above — the preset
library is invisible to the Archivist right now.** `PresetVersion.embedding` is
nullable (`schema.prisma:158-159`) and `seed-presets.ts:9-11` says embeddings
are "deliberately left for follow-up steps." **There is no backfill script
anywhere in the repo** — the only hits for `backfill|embed-preset|seed:embed`
are three comments saying it's someone else's job (`docs/DEPLOY.md:82`,
`docs/SETUP.md:40`, `inngest/functions.ts:78-80`), and `packages/db/package.json`
has no such script. `queryPresetsByVector` filters `WHERE embedding IS NOT NULL
AND active = true` (`packages/db/src/vector.ts:17-34`), so it returns `[]` for
all 45 seeded presets and `archivist.ts:75-78` pushes `coverage: 'none'` for
every requirement. **This is a second, likely larger explanation for why
produced estimates look nothing like the preset library: the library isn't
being consulted at all.** Worse, `savePreset` nulls the embedding on every admin
edit (`admin/presets/[id]/page.tsx:46-47`, "regenerated when embeddings are
backfilled") — so with no backfill, **editing a preset permanently de-indexes it.**
The embedding routine already exists (`embedPromotedPresets`,
`writeback.ts:117-141`); it just needs to be reachable as a backfill script +
called on save + called on create.

Caveat on the above: PROGRESS.md's 2026-07-08 live-verify pass reports real
Archivist matches (P42/0.81, P09/0.77 etc.) against a preset-adjacent SOW — so
embeddings evidently got populated *somehow* in that environment (a one-off
script, or a manually-run routine). Confirm the actual state of
`PresetVersion.embedding` in the Neon DB before acting on this; the reproducible
gap is that nothing in the repo re-creates that state.

**Status: DONE** — both halves. (b) the write-back is wired: `f0b1c07` hooks
`finaliseAction` via Inngest with hybrid promotion (version the matched preset
at >=0.75, else mint a new one), and fixes the `beHours * 0.4` fabrication this
entry correctly identified as blocking. (a) creation is `71d5f2f` —
`/admin/presets/new`, no number to invent (`ea10878` allocates codes from a
sequence). The 🔴 embedding finding was real and is fixed in `694a056`:
`savePreset` no longer de-indexes a preset, and `pnpm db:embed:presets` exists.

---

## Disable users + reassign estimates on delete (requested 2026-07-17)

**What:** (a) admins can't delete a user who owns estimates — the UI says to
reassign them, but reassignment doesn't exist; (b) add the ability to disable a
user (can no longer log in) as an alternative to deleting.

**(a) The reassign message is a dead end — literally.** `grep -rni "reassign"`
across the repo returns **exactly one hit**: `admin/users/page.tsx:140`, the
tooltip string itself. No UI, no server action, no API route, no
ownership-transfer code anywhere.

- Server guard: `admin/users/page.tsx:71-88` — `deleteUser` counts
  `prisma.estimate.count({ where: { ownerId: userId } })` (`:83`) and **silently
  `return`s** if `> 0` (`:84`). No feedback of any kind.
- Client block: `page.tsx:136-141` sets `deleteBlockedReason` = "Owns N
  estimate(s) — reassign or remove them first", applied only as a `title`
  tooltip on a disabled button (`:199-200`). It reads `_count.estimates` from
  page render, so it's stale-prone; the server guard is the real one.
- The relation: `Estimate.ownerId` is **required and non-nullable**
  (`schema.prisma:171-172`), FK is `ON DELETE RESTRICT` (Prisma's default for a
  required relation — confirmed in SQL at
  `packages/db/prisma/migrations/20260607145305_init/migration.sql:248`). The
  `20260716140156_estimate_delete_cascade` migration only touched
  `MenuItem_estimateId_fkey`, not the owner FK. Field is `ownerId` — there is no
  `assignedToId`/`createdById`.
- **Reassignment is genuinely trivial:** `prisma.estimate.updateMany({ where:
  { ownerId: X }, data: { ownerId: Y } })`. Nothing cascades off owner and no
  other model references `User`. The work is almost entirely the UI (a
  "reassign to…" picker in the delete dialog) plus making the silent guard
  return a real error via `useActionState`. `ownerId` is written in exactly one
  place today (`api/estimates/ingest-create/route.ts:59`); owner is read at
  `dashboard/page.tsx:44`, `estimates/[id]/page.tsx:114`,
  `inngest/functions.ts:23`.

**(b) No disable concept exists at all.** `User` (`schema.prisma:78-86`) has no
`status`, `isActive`, `disabledAt`, `suspended`, or soft-delete field. (Every
`deactivate` hit in the repo is *version* activation for Presets/Prompts/Config
— `packages/core/src/versioning.ts:65,100,134,166` — unrelated.) Needs a new
column + migration under `packages/db/prisma/migrations/`.

**The disable check must go in two places, and the second one is the one that
matters:**
1. `apps/web/src/lib/auth.ts:42-44` — inside `authorize()`, return `null` if
   disabled. **This blocks new logins only.**
2. `apps/web/src/lib/auth.ts:59-75` — the DB-backed `jwt` callback. It already
   re-reads the user from the DB on **every request** (`:66-69`, currently
   `select: { role: true }`) precisely so live role changes apply without
   re-login (see the comment at `:54-58`). Extending that `select` and
   invalidating the token is what actually kills an existing session. **Without
   this, a disabled user's JWT keeps working until it expires** — `session:
   { strategy: 'jwt' }` (`auth.ts:51`) means there's no session table to revoke.
   Note the edge `jwt` callback (`auth.config.ts:25-31`) can't do a DB lookup
   (no Prisma in edge runtime); the `auth.ts` override is the only DB-backed
   hook. Middleware's `authorized()` (`auth.config.ts:13-24`) only checks
   `!!auth?.user`, so it honors whatever the Node-side callback decides.

Disabling also interacts with (a): a disabled user still owns their estimates,
which is arguably the *point* — disable is the answer when you want the
ownership history preserved, delete+reassign when you don't. Both should exist.

**🔴 Unrelated security bug found while exploring here, worth fixing on its
own:** `deleteEstimate` (`estimates/[id]/actions.ts:288-291`) only calls
`requireSession()` — **any signed-in user can delete any estimate**, with no
owner or admin check. Today it's also the *only* way to unblock a user
deletion, which is how it surfaced.

**Status: DONE** — `63344b0`. `disabledAt` blocks sign-in AND ends live sessions
via the DB-backed jwt callback (the second hook this entry correctly identified
as the one that matters). Reassignment is standalone, not only inside deletion.
The 🔴 `deleteEstimate` authz hole found here was fixed first, in `209f6cc`.

---

# Carried over from the 2026-08-07 session

Three known-but-unfixed things, recorded so they don't die with the entries that
raised them.

## Detective's spike-preset range is hardcoded (found 2026-08-07)

`packages/agents/src/detective.ts:102` shows the model this JSON contract:

```
"spikePresetId": "P01".."P06" | omit
```

A literal range in a prompt string. Nothing validates that P01–P06 *are* the
spike presets — PROGRESS.md has flagged that mapping as never cross-checked
since 2026-07-08 — and it silently rots the moment the library is re-imported or
a spike preset is added. `PresetVersion.spikeNeeded` already exists and is the
real source of truth, so this should be derived (query the spike presets, list
their codes in the prompt) rather than written by hand.

Related: `packages/shared/src/schemas.ts:199` repeats the range in a doc comment,
and six live DB prompts name "P01–P45" in prose. The prose is descriptive and
harmless; this one is functional.

**Status:** not started.

## Decision: the seeded 45 keep their original ids (decided 2026-08-07)

Not a task — a decision record, so nobody re-opens it without the cost in front
of them.

Preset ids are now cuids and `Preset.code` carries the readable handle, so the
xlsx number is no longer identity. The 45 seeded presets were **deliberately not
renumbered**, because their id strings are load-bearing today:

- `requires`/`blocks` form a real dependency graph — 43 version rows, 40 distinct
  ids referenced, 0 dangling
- 10 `MenuItem.sourcePresetId` rows point at them
- 6 active agent prompts name the P01–P45 range

Renumbering means rewriting all three in one transaction with a verification pass
proving 0 dangling refs before and after. The arrays have no FK protection, so a
partial job rots silently. Assessment at the time: little upside now that `code`
exists, real downside if it goes wrong.

**Status:** decided, not doing. Revisit only with a scripted migration.

## `nonDev` in supervisor-gates includes DEV (found 2026-07-17, still unfixed)

`packages/agents/src/supervisor-gates.ts`:

```ts
const nonDev = totalsByRole.DEV + totalsByRole.QA + totalsByRole.BA;
```

The name says non-DEV; the arithmetic includes DEV. The *behaviour* is correct —
the warning text says "% of DEV+QA+BA" and the ratio below recomputes the same
sum inline, so nothing is miscalculated. It's a misnomer plus a duplicated
expression, and it reads as a bug every time someone opens the file. Worth
renaming to `pmDenominator` and using the variable in the ratio.

**Status:** not started. Cosmetic, but it's cost reading time twice already.

---

# Requested 2026-08-20

Nine new items. Grounding below is real where it's stated as fact; anything that
still needs a decision says so rather than guessing.

## Review and revise the agent prompts

**What:** a proper pass over all 9 agent prompts.

**Why now, with evidence:**
- **The live prompts have drifted from the repo.** Active versions in Neon are
  v3/v4, and strings that exist in the DB (e.g. "Anchor preset IDs (P01–P45)…")
  appear **nowhere** in `packages/db/src/seed-prompts.ts` or
  `scripts/prompts-export.json`. So the prompts actually running are not the
  prompts in version control. Re-seeding would silently revert them.
- **A known drift bug**: PROGRESS.md records the live SPECIALIST_DEV body still
  asking for `{baseHours, rationale, assumptions}` — a shape `specialist.ts` no
  longer parses. It only works because the real contract rides in the user
  message.
- **The calibration gap.** QA/PM/BA have been out of the proportionality band on
  *every* live run so far (BA 52–95% of DEV, PM 30–44%), and `sow-simple`
  produced ~160–190h for a ~30–60h job. PROGRESS.md attributes this to prompt
  adherence, not a code bug — so this is the item that would actually fix it.
- Prompts are DB-versioned (`Prompt`/`PromptVersion`) and editable at
  `/admin/prompts`, so revising them needs no deploy. **But** there is no way to
  export the live set back into the repo, which is why they drifted. Worth
  fixing as part of this.

**Status:** not started.

## Multi-level approval on estimates

**What:** a sequential approval chain of named roles — e.g. estimator submits →
lead approves → director signs off — each step recorded with who and when, and
the estimate locked at the end.

**Current state:** `Estimate.status` is a flat `DRAFT | REVIEW | FINALISED`, and
`finaliseAction` flips it with no record of who did it. `Role` is only
`ADMIN | ESTIMATOR`, so there is no "lead" or "director" to approve as — the
role model has to grow first, or approval steps reference users directly.

**Shape of the work:** an ordered approval-step table (estimate, step index, role
or user, decision, actor, timestamp, comment), a configurable chain definition
(so the sequence isn't hardcoded), and a guard making FINALISED reachable only
when every step has passed. Note `deleteEstimate` and the editing actions already
refuse to touch a FINALISED estimate, so the lock has somewhere to hook.

**Status:** not started.

## AI-assisted WBS editing

**What:** everything to do with revising the menu card with the model's help, not
just regenerating it. Specifically requested:
- natural-language revision ("make QA lighter", "assume auth already exists")
- re-run part of it — one card, one role — in place, keeping the rest
- explain and challenge a number, without editing
- **structural edits**: add a section the crew missed, restructure a section,
  split one into several, merge several into one
- revise hours, revise descriptions

**Current state:** the run is all-or-nothing. `runEstimate` regenerates the whole
menu card and `run-estimate.ts` deletes and recreates every `RoleLineItem` in a
transaction, so there is no way to touch part of an estimate with the model.
Manual editing exists and is good (inline titles, hours, sections, drag-and-drop
via `MenuCardEditor` + `ledger-context`) — this item is about giving the model the
same reach a human already has.

**The hard part** isn't the prompting, it's scoping: the pipeline is
requirement-driven (Librarian → Specialists → Architect), so "re-do this one
card" needs a way to run a slice of it against existing state rather than from
the SOW. `SupervisorInput` already has `mode: 'full' | 'refine'` and
`changedMenuItemIds` — declared but never used. That's the intended seam.

**Status:** not started. Biggest item in this file.

## Estimate lineage — successors and branches (clarified 2026-08-20)

**One feature, not two.** Versioning and branching are the same idea: start a new
estimate *with an existing estimate as its reference*, instead of from a blank
SOW. An estimate is either a **successor** of another (the client came back with
revised requirements) or a **branch** of it (explore a different scope, outcome,
or subset in parallel).

**The load-bearing requirement:** the earlier estimate stays valid. It is still
good as a set of work items — just not for this client, or not for this round.
Both remain live and independently usable; nothing is archived or superseded.

That rules out the pattern used everywhere else in this system.
`PresetVersion`/`PromptVersion`/`EstimationConfig` are single-active + immutable
history, which assumes one current truth. Here there is no single truth — two
estimates from one ancestor are both current. So this is a **lineage graph**, not
a version chain: a parent pointer, a relationship kind (SUCCESSOR | BRANCH), and
a deep copy of sections/menu items/line items at fork time.

Typical deltas the fork has to survive, per the request: a complete system
overhaul, a smaller subset of requirements, a few extra modules, or a different
business outcome. So the copy must be fully editable afterwards with no link back
to the parent's numbers — reference means provenance, not inheritance.

**Current state:** nothing. `Estimate` has no parent pointer and nothing
references an estimate from another estimate.

**Two things that need deciding:**
- **Approvals must not be inherited** by a fork (see the approval entry) — a copy
  of an approved estimate is not itself approved.
- **Preset write-back.** Promotion is keyed on `(sourceEstimateId,
  sourceMenuItemId)`, so two branches of one ancestor would each promote their
  copy of the same card as separate presets. Probably wrong — the library would
  fill with near-duplicates of the same work. Needs a rule: promote only from one
  designated lineage member, or dedupe on lineage.

**Status:** not started. This supersedes the earlier separate "Versioned
estimates" and "Branching estimates" entries.

## Artifact generation alongside the WBS

**What:** produce supporting artifacts from an estimate, not just numbers.
Confirmed wanted: **ERD, user-flow diagram, low-fidelity wireframes** — and more
later.

**Hard requirement from the request:** artifact types must be **addable through
the UI**, without a code change. "I shouldn't have to come back to the code to
add support for a new artifact." So an artifact type is *data*, not a switch
statement.

**The pattern to reuse is already here.** Agent prompts are exactly this: a
DB-versioned record (`Prompt`/`PromptVersion`) with an admin editor at
`/admin/prompts`, loaded at run time by `loadActivePrompt`. An artifact type
wants the same — name, the prompt that generates it, expected output format,
active version — plus a renderer chosen by format rather than by type. Note
`AgentKind` is a Prisma **enum**, so artifact types must NOT be modelled that
way; adding an enum value is a migration, which is the thing being ruled out.

**Open:** what does an artifact render as (Mermaid text, SVG, image, markdown),
and is it generated on demand or as part of a run?

**Status:** not started.

## Configurable estimate — a menu card the client picks from (clarified 2026-08-20)

**What:** the estimate is presented as a menu of modules the customer chooses
from. A business analyst toggles menu items on and off at will during presales,
the total updates live, and because modules genuinely depend on each other,
switching one ON pulls in whatever it requires. Point of the whole thing: take
the guesswork out of presales.

**Reference:** the requester has a Claude artifact demonstrating the intended
interaction — get it before designing the UI.

**A surprising amount already works.** This is not a build-from-scratch item:
- `MenuItem.enabled` and `onToggleItem` — toggling exists.
- **Totals already update live.** `ledger-context.tsx:153` recomputes the rollup
  on every toggle ("disabled items are priced but never counted"), and
  `RollupCard.tsx:70` already shows the `excluded` hours.
- **The pipeline already computes a requires-chain.** `architect.ts:242-255`
  derives `notSafelyRemovable` from `sequencing.requires` and sets
  `toggleable: !notSafelyRemovable`.
- The preset library holds a **real dependency graph**: `PresetVersion.requires`
  and `.blocks`, 43 version rows, 40 distinct ids referenced, 0 dangling. Every
  card carries `sourcePresetId`, so cards can be mapped onto it.

**The three actual gaps:**

1. **The dependency data is computed, persisted, and then ignored.**
   `run-estimate.ts:288-290` writes `toggleable`/`notSafelyRemovable`/`thinSlice`
   into `MenuItem.meta` (a JSON blob) and the editor's `ItemDTO` never reads
   `meta` at all. So the UI lets a BA switch off a foundation card that three
   others depend on, with no warning, even though the pipeline knows. Surfacing
   this is the cheapest first win.
2. **`notSafelyRemovable` is a boolean, not edges.** It answers "risky to
   remove?" but not "if I switch this ON, what else must come on?" — which is the
   behaviour actually wanted. Needs real per-card dependency edges, derivable
   from the preset graph via `sourcePresetId` plus the Architect's own
   `sequencing.requires`.
3. **No cascade.** Enabling an item must enable its dependencies (and probably
   warn, rather than silently disable dependents, when switching one off).

**Open:** when a cascade adds items the client didn't pick, how is that shown —
auto-added and flagged, or offered for confirmation? And does `blocks` mean
mutually exclusive options (pick one of two approaches), which is a different
interaction from `requires`?

**Status:** not started. Distinct from the earlier reading of this item as
"per-estimate config overrides", which is not what was meant.

## Custodian on estimates, with deadlines and reminders

**What:** a named custodian responsible for an estimate, a deadline, and
reminders as it approaches.

**Current state:** `Estimate.ownerId` is the only person on an estimate, and it
means "who created it" — it's set once at
`api/estimates/ingest-create/route.ts` and never changes except through the new
admin reassignment. There is no deadline field and no due-date concept anywhere.

**Notes:** custodian and owner should probably be separate — reassigning
ownership when someone leaves is a different act from handing over day-to-day
responsibility. Email infrastructure exists and works (`lib/email.ts`:
`sendEmail`, `estimateUrl`, and the existing run/ingest notifications), so
reminder content is easy. **What's missing is a scheduler**: every Inngest
function today is event-triggered, there are no cron functions, so a daily
"what's due" sweep is genuinely new plumbing (Inngest supports crons; it just
isn't used here).

**Status:** not started.

## Fix the Google Sheets export

**What:** the live export path has **never actually worked** — it has only ever
run against the stub.

**Evidence:** `createSheetsProvider()` returns `StubSheetsProvider` unless both
`GOOGLE_SERVICE_ACCOUNT_JSON` and `GOOGLE_DRIVE_FOLDER_ID` are set. Every test
and every documented run has taken that path. When the e2e suite *did* pick up
real credentials from `.env.local` on 2026-08-07, the live provider failed
immediately with **"The caller does not have permission"** — the first time the
live path had been exercised at all. (The suite now blanks those vars
deliberately; e2e should not call a third party's Drive.)

**So the work is a first live verification, not a regression fix:** confirm the
service account can write to the target folder, that the folder id is right, and
that `LiveSheetsProvider.createSpreadsheet` produces what's expected end to end.

**Also check while in there:** `sheets-export.ts` builds one tab per `RoleKind`
with columns `Item | Line Item | Taxonomy Key | Base Hours | Taxed Hours | Notes`.
That survived the dev-hours consolidation (it reads line items, not preset
BE/FE), but it has never been eyeballed in a real spreadsheet.

**Status:** not started.

---

# Requested 2026-08-20 (second pass)

## Preset model rework — it's someone else's spreadsheet schema

**Framing:** `PresetVersion` is a direct transcription of
`docs/Estimate Presets (ISM).xlsx`, designed by someone else for a different
purpose. Treat it as legacy. ~25 fields, of which the retrieval path selects
twelve, and only a handful influence an estimate.

### 1. Split three concerns that are currently one flat row

- **Retrieval surface** — what makes a preset findable: `name`, `description`,
  `keywords`, `embedding`, `embeddingText`. This is the *entire* matching
  mechanism; the embedding is literally `name + description + keywords`.
- **Estimate anchor** — what it contributes: dev hours, side flags, and the
  comparison signals below.
- **Composition rules** — how it relates to other modules: `requires`, `blocks`,
  `canParallel`.

They're conflated today, which is why the third silently rotted: nothing
consumes it, so nothing keeps it honest.

### 2. Dependency edges become first class

`requires: String[]` / `blocks: String[]` of preset codes: no FK, no direction
beyond convention, no reason attached, no way to say "these two are
alternatives". Replace with real edges — `(fromPresetId, toPresetId, kind)` where
kind is `REQUIRES | BLOCKS | ALTERNATIVE_TO`, plus an optional note.

Then a cascade is a graph walk instead of string matching, referential integrity
is enforced, **and the graph can be visualised** — which is wanted.

This is the prerequisite for the configurable-estimate menu card, not a cleanup.

**Also settles an open question:** nothing in the codebase reads `blocks` at all,
so whether it means "must not coexist" or "must come after" has never been
decided *or* validated against the 24 presets that use it. Decide it here.

### 3. The comparison signals are not inert — they're unused as deltas

**Correction to an earlier reading of this file.** `integrationCount`,
`dataVolume`, `projectSizeFit`, `aiAssist`, `risk` are genuine signals — they are
exactly what lets a model judge between two presets matching similar
requirements. They should NOT be dropped.

The real defect is that the comparison never happens. `archivist.ts:127-128`:

```ts
dataVolume:       req.dataVolume,        // from the REQUIREMENT
integrationCount: req.integrationCount,  // from the REQUIREMENT
aiAssist:         toImpactLevel(meta.aiAssist),  // from the preset
risk:             toImpactLevel(meta.risk),      // from the preset
```

The field is called `adjustments` and the prompt calls them "Adjustment signals"
(`specialist.ts:58`) — but two of the five are the requirement's own values handed
straight back. **Nothing is adjusted, because nothing is compared.** The preset's
`integrationCount` and `dataVolume` are selected out of the database and dropped.

So the model is told "integration_count: 4" with no baseline to judge it against.
The intended meaning — *this preset was built at 1, your requirement is 4, scale
up* — was never implemented. Fix: compute and pass the delta. Plausibly a
contributor to the calibration gap PROGRESS.md tracks, since every run has been
handing the model reference-free numbers.

### 3b. Controlled vocabulary that can grow without a deploy

`category` / `reqType` / `platform` are free strings. They were deliberately
opened up from enums (see the long comment in `packages/shared/src/schemas.ts`)
because a closed **ecommerce-specific** enum forced every requirement into the
nearest wrong label. That diagnosis was right; the remedy overshot.

What's wanted is closed-but-curated: a vocabulary you own, extensible without a
migration. A Prisma enum can't do that. **The pattern already exists here twice**
— `TaxonomyNode`/`TaxonomyNodeVersion` and `Prompt`/`PromptVersion`: DB-backed,
admin-editable, single-active, loaded at run time.

So: a `VocabularyTerm` table keyed by kind (`CATEGORY`, `REQ_TYPE`, `PLATFORM`),
the active list injected into the Librarian's prompt at run time (prompts already
load at run time — same seam), and validation against the DB rather than a zod
enum.

**Decided:** when the Librarian wants a term that isn't in the list, **accept it
and queue it as `pending`** for admin review — approve, merge into an existing
term, or reject. The vocabulary grows out of real work instead of guesses, and a
bad fit is visible rather than silently absorbed. Needs a review surface in
`/admin`.

### 4. `notes` — two fields, kept separate

**Decided.** Split into:
- a pipeline-owned field populated at promotion from the estimate's relevant
  `assumptions[]`, so "last time we assumed X" comes back as an anchor
- a human-authored field an estimator writes and a promotion never overwrites

Today `notes` is editable in the admin form
(`admin/presets/[id]/page.tsx:280`) but **nothing populates it and nothing reads
it** — the most useful column in the original spreadsheet is inert in both
directions. Whichever field it becomes must reach the specialist prompt.

### 5. Separate estimated from actual hours

`devHours` is one number doing two jobs: the original estimate, and — after
`recordActuals` — the delivered figure. Recording actuals **overwrites** the
estimate, so the comparison is destroyed by the act of recording it.

**Confirmed this feeds all three of:** calibration/accuracy tracking (per preset
and per estimator), ingestion of actuals from an external system (Jira,
timesheets) rather than manual entry, and commercial margin/pricing analysis.
All three need estimate and actual side by side, with attribution and a date —
so this is a related-records problem, not an extra column.

**Status:** not started. Item 2 is the prerequisite for configurable estimates;
item 3 is the one most likely to improve estimate quality on its own.

## Never let the WBS and the preset library drift apart again

**Hard requirement.** The WBS promotes to presets and presets populate the WBS.
That loop has drifted before and must not again.

**Why it drifted, precisely:** promotion was tested, retrieval was tested, and
the **round trip** was not. Neither `ws20.test.ts` nor `writeback-promote.test.ts`
mentions `runArchivist` or `ArchivistMatch` — they assert what promotion writes
and stop. That is exactly the gap `beHours = Σ DEV; feHours = round(BE * 0.4)`
lived in for months: a 1.4× inflation on every promoted preset, invisible because
nothing ever read one back.

**Decided — both guards, because they catch different classes of failure:**

1. **Structural drift** → a shared costed-work type so a mapping mismatch cannot
   compile. Split into two separately-sized items below ("focused" and "full").
2. **Semantic drift** → a **CI-blocking round-trip test**: estimate → promote →
   retrieve as an anchor → assert the anchor equals what was estimated.

**Why both, stated plainly:** a shared type could not have caught the bug that
actually hurt. `feHours = round(beHours * 0.4)` was perfectly type-correct — two
`Int`s, no mismatch anywhere. Types check shape, not meaning. Only a round trip
notices that the number coming back out is 1.4× the number that went in.

**Status:** not started. Do the round-trip test and the focused refactor before,
or alongside, the preset rework — not after.

## Shared costed-work type — FOCUSED (do this one)

**What:** collapse the duplicated representations of "a costed unit of work" down
to one definition, and the duplicated Prisma-row mappings down to one function.
Deliberately scoped to stop the bleeding, not to redesign the model.

**The problem, measured.** Four separate hand-written types describe the same
thing, none derived from another:

| Type | Where | Used by |
|---|---|---|
| `SpecialistLineItem` | `shared/src/schemas.ts:289` | what a specialist emits |
| `RoleLineItem` (zod) | `shared/src/schemas.ts:333` | what the pipeline passes around |
| `RoleLineItem` (Prisma) | `db/prisma/schema.prisma:388` | the database row |
| `LineItemDTO` | `estimates/[id]/actions.ts:20` | what the editor reads |

Same story one level up: `MenuItemSchema`, the Prisma `MenuItem`, and `ItemDTO`.
And **at least three near-identical Prisma-row → `MenuItem` mappings**, each
independently maintained:

- `apps/web/src/app/estimates/[id]/page.tsx:61` (the Sheets export action)
- `apps/web/src/inngest/functions.ts:256` (the promote function)
- `packages/agents/src/rollup.ts:85`

**Evidence this is the drift mechanism, not a tidiness complaint.** Adding
`touchesFrontend`/`touchesBackend` — *two booleans* — required changes in twelve
files (`eceb937`): schemas, specialist, architect, run-estimate, taxation, audit,
actions, page, ledger-context, MenuCardEditor, SideTag, migration. The compiler
caught only some of it: `taxation.ts` and `audit.ts` surfaced only on a full
typecheck, and the Sheets export DTO in `page.tsx` needed a *separate* fix
afterwards because it is a second mapping inside the same file. Had I stopped at
the first green typecheck, the flags would have silently vanished from the export
path.

Six-plus places to update is not a discipline problem, it is arithmetic: a field
eventually lands in five of them.

**The work:**
- One canonical shape for a costed unit of work (and for a card) in
  `@repo/shared`.
- DTOs become **derived** types (`Pick`/`Omit`) rather than fresh declarations, so
  adding a field either propagates or fails to compile.
- **One** `toMenuItem(prismaRow)` / `toLineItem(prismaRow)` helper; the three
  existing copies call it.

**Explicitly out of scope:** changing the database model, and deciding whether
`PresetVersion` should *be* a costed-work record. See the FULL item below.

**Status:** not started. Recommended: do this as part of the anti-drift work —
most of the protection for a fraction of the cost, and it makes the preset rework
materially safer to attempt.

## Shared costed-work type — FULL unification (decide later, not now)

**What:** one canonical model of costed work from which the database, the
pipeline, the DTOs **and the preset library** are all derived — including
answering whether `PresetVersion` should be a costed-work record rather than a
parallel schema that happens to hold hours.

**Why it's a genuine question and not just "more of the above":** a preset and a
menu card are arguably the same object at different lifecycle stages. A card is
costed work for one client; a preset is costed work generalised for reuse.
Today they are unrelated schemas joined by a hand-written mapping in
`writeback.ts`, which is exactly where the 1.4× inflation lived. Unify them and
that class of bug becomes unrepresentable.

**Why NOT now:**
- It touches the pipeline, the DB, every DTO and the preset library at once —
  much larger blast radius than the focused item, with the same specific
  protection already achieved by it.
- It should be **answered by** the preset rework, not bundled ahead of it. The
  rework splits `PresetVersion` into three concerns (retrieval surface / anchor /
  composition rules); once that shape is settled, whether the anchor half *is* a
  costed-work record becomes an obvious yes or an obvious no. Deciding it first
  means guessing.

**Status:** not started, deliberately deferred. Revisit once the preset rework
has settled the anchor's shape.

## No orphaned backend work (requested 2026-08-20)

**The rule:** a field or capability that exists on the backend must have a
frontend implementation, unless it is *explicitly* recorded as backend-only.
CRUD on the backend is not CRUD on the frontend. A column is not a feature.

**This is a systemic pattern here, not a one-off.** Found in a single session:

| Orphan | Where |
|---|---|
`toggleable`, `notSafelyRemovable`, `thinSlice` | Architect computes them, `run-estimate.ts:288-290` persists them into `MenuItem.meta`, the editor DTO never reads `meta`. The UI lets a BA switch off a foundation card the pipeline knows is unsafe to remove. |
`requires`, `blocks`, `canParallel` | Selected by the Archivist, carried into `ArchivistMatch.sequencing`, then only `requires` is used — flattened to one boolean. `blocks` and `canParallel`: zero consumers. |
`SupervisorInput.mode`, `changedMenuItemIds` | Declared in the schema; appear nowhere else in the codebase. The intended seam for partial re-runs, never wired. |
`promoteMenuItemsToPresets` | A complete, unit-tested feedback loop with **zero callers** outside tests, for months. |
`preset.notes` | Editable in admin, read by nothing. |
`userStoryTags`, `projectSizeFit` | Only ever copied forward in `writeback.ts`; never read for a decision. |
"reassign or remove them first" | A tooltip promising a feature that did not exist anywhere in the codebase. |
Preset embeddings | `seed-presets` wrote none and no backfill existed, so retrieval silently matched nothing. |

**Proposed mechanism — make orphans loud instead of relying on discipline:**
- **Orphan-field audit**, CI-blocking: for every persisted column, assert it is
  referenced somewhere in `apps/web/src`, with an explicit allowlist for
  deliberate backend-only fields. A new unallowlisted orphan fails the build; the
  allowlist is where "purposely not on the frontend" gets *recorded* rather than
  assumed.
- **Zero-caller export check**: exported functions in `packages/*` with no
  non-test caller. Would have caught `promoteMenuItemsToPresets` immediately.
- Same idea as `embeddingText` and the round-trip test above: the failures that
  hurt here are all **silent**, so the fix is always to make the invisible
  visible.

**Status:** not started. Applies far beyond presets — worth doing early, since
every item in this file adds surface where this can happen again.
