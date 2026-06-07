# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-06-07 — WS21-01 COMPLETE. 7/7 e2e pass. All 5 tasks done._

## Current workstream

**WS21-01 [SLICE] — App shell: nav, role-aware menu (admin vs estimator), shadcn theme**
(see `docs/04_WBS.md`, WS21 section)

**DoD:** admin sees admin nav; estimator does not (Playwright test).

## State of the working tree (uncommitted, in progress)

Already created before the crash:
- `apps/web/src/components/nav.tsx` — role-aware nav (admin links gated on `role === 'ADMIN'`). NOT yet rendered anywhere.
- `apps/web/src/components/ui/button.tsx` — shadcn Button (uses theme tokens not yet defined).
- `apps/web/src/lib/utils.ts` — `cn()` helper.
- `apps/web/src/app/globals.css` — only has `--background`/`--foreground`; **missing** shadcn tokens.
- `apps/web/src/app/layout.tsx` — imports globals.css.
- Deps added to `apps/web/package.json` (radix, cva, clsx, tailwind-merge, lucide, tailwindcss v4, postcss, autoprefixer, @tailwindcss/forms) and root (`@playwright/test`, `playwright`). **Installed** (verified in node_modules).

## Checklist (tracked as tasks too)

- [x] **1. Tailwind v4 PostCSS** — added `@tailwindcss/postcss` dep + `apps/web/postcss.config.mjs`. Dev server compiles CSS.
- [x] **2. shadcn theme tokens** — `globals.css` now defines tokens via Tailwind v4 `@theme` (primary/secondary/muted/accent/destructive/border/input/ring + foregrounds). button.tsx variants resolve.
- [x] **3. Wire Nav into layout** — `apps/web/src/app/dashboard/layout.tsx` renders `<Nav/>`; dashboard page uses a div (no nested `<main>`).
- [x] **4. Stub admin pages** — `/admin/{users,config,presets,prompts,mcp}` placeholder pages + `admin/layout.tsx` that role-guards (non-admin → /dashboard, unauth → /login) and renders Nav.
- [x] **5. Playwright test** — `e2e/nav.spec.ts` (4 tests) + `e2e/global-setup.ts` (seeds admin+estimator via Prisma generated client + dotenv). No `packages/db/src/seed.ts` needed — seeding lives in Playwright globalSetup.

## DoD status: ✅ COMPLETE
`pnpm --filter web exec playwright test` → **7/7 pass** (3 pre-existing auth + 4 new role-shell: admin-sees-nav, estimator-doesn't, admin-opens-admin-page, estimator-redirected-from-admin).
apps/web typecheck adds NO new errors (pre-existing TS2742 in auth.ts/middleware.ts from next-auth v5 beta inference — needs explicit type annotations, separate concern, NOT introduced here).

## NEXT WORKSTREAM: WS21-02 — Dashboard: list estimates with status + owner
depends: WS21-01 (done), WS1-07. DoD: estimates render; click opens detail (Playwright).

## Key facts / gotchas

- Web app dev port: **3001** (playwright webServer). DB on **5433** (docker-compose, pgvector pg16).
- Existing e2e: `apps/web/e2e/auth.spec.ts` (redirect, login page, bad creds — none need a seeded user).
- Auth: next-auth credentials provider; `session.user.role` is `Role` enum (`ADMIN` | ...). `auth()` from `@/lib/auth`.
- Path aliases in `apps/web/tsconfig.json`: `@/* -> ./src/*`.
- Recent commits: WS17–WS20 done. Branch: `master` (PRs target `main`).

## Next action on resume

Start at the first unchecked box. Run `pnpm --filter @repo/... ` ... actually use root scripts:
`pnpm dev` (web), `pnpm test` (vitest), playwright via `pnpm --filter web exec playwright test`.
