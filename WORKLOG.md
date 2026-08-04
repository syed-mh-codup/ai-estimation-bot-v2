# WORKLOG — feature backlog / ideas not yet started

> Distinct from PROGRESS.md (which tracks live, in-progress work). This file
> captures requested features and ideas that haven't been scoped or started
> yet, so they aren't lost between sessions.

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

**Status:** not started. No code changes made. Recorded here per request.

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

**Status:** not started. No code changes made.

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

**Status:** not started. No code changes made.

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

**Status:** not started. No code changes made.

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

**Status:** not started. No code changes made.
