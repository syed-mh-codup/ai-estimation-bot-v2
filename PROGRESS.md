# PROGRESS — live work tracker

> **Purpose:** Crash-resilient record of "where we are right now." The terminal
> crashes frequently; this file is the source of truth on resume. Claude updates
> it as work progresses. To pick up after a crash: read this file top-to-bottom,
> then run `git status` and `git log --oneline -5`.

_Last updated: 2026-06-07 — DoD MET, 5/5 e2e pass. Polish remaining._

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
- [ ] **2. shadcn theme tokens** — (POLISH, not DoD-gating) add tokens to `globals.css` via Tailwind v4 `@theme`. button.tsx depends on these but isn't imported anywhere yet.
- [x] **3. Wire Nav into layout** — `apps/web/src/app/dashboard/layout.tsx` renders `<Nav/>`; dashboard page uses a div (no nested `<main>`).
- [ ] **4. Stub admin pages** — (POLISH) `/admin/{users,config,presets,prompts,mcp}` placeholders so nav links don't 404; role-guard them.
- [x] **5. Playwright test** — `e2e/nav.spec.ts` (2 tests) + `e2e/global-setup.ts` (seeds admin+estimator via Prisma generated client + dotenv). **DoD MET: 5/5 e2e pass.** No `packages/db/src/seed.ts` needed — seeding lives in Playwright globalSetup.

## DoD status: ✅ MET
`pnpm --filter web exec playwright test` → 5/5 pass (3 pre-existing auth + 2 new role-nav).
apps/web typecheck adds NO new errors (pre-existing TS2742 in auth.ts/middleware.ts from next-auth v5 beta inference — needs explicit type annotations, separate concern).

## Key facts / gotchas

- Web app dev port: **3001** (playwright webServer). DB on **5433** (docker-compose, pgvector pg16).
- Existing e2e: `apps/web/e2e/auth.spec.ts` (redirect, login page, bad creds — none need a seeded user).
- Auth: next-auth credentials provider; `session.user.role` is `Role` enum (`ADMIN` | ...). `auth()` from `@/lib/auth`.
- Path aliases in `apps/web/tsconfig.json`: `@/* -> ./src/*`.
- Recent commits: WS17–WS20 done. Branch: `master` (PRs target `main`).

## Next action on resume

Start at the first unchecked box. Run `pnpm --filter @repo/... ` ... actually use root scripts:
`pnpm dev` (web), `pnpm test` (vitest), playwright via `pnpm --filter web exec playwright test`.
