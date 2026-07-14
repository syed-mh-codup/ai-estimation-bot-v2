# Deploy Runbook (Vercel)

## Shape of the thing

- **Web (Next.js)** → Vercel.
- **Estimate runs + document ingestion** → **Inngest** durable functions, served
  from the app at `/api/inngest`. They are _not_ background promises; a
  serverless function dies when the response returns, which is why they were
  moved to Inngest.
- **Database** → managed Postgres with **pgvector** (Neon). The init migration
  runs `CREATE EXTENSION IF NOT EXISTS "vector"`, so `migrate deploy` handles it.

The run is checkpointed stage-by-stage (Librarian → Detective/Archivist →
specialist council *per requirement* → Architect → persist). Inngest invokes one
checkpoint per HTTP request, so **each stage** must fit inside the Vercel
function limit — not the whole run. That limit is set explicitly in
`apps/web/src/app/api/inngest/route.ts` (`maxDuration`).

> Vercel duration ceiling: **Hobby 300s (default and maximum)**, Pro 300s default
> / 800s max, with Fluid Compute. Note Vercel's fair-use terms restrict Hobby to
> **non-commercial personal use**.

## 1. Provision

**Neon.** Create the database and grab **two** connection strings:

- `DATABASE_URL` — the **pooled** URL (`…-pooler.…`), used by the app.
- `DIRECT_URL` — the **non-pooled** URL, used by `prisma migrate deploy`.
  `schema.prisma` declares `directUrl`; migrations can't run through the pooler
  (no DDL / advisory locks).

**Inngest.** Create an app in Inngest Cloud and copy `INNGEST_EVENT_KEY` (send
events) and `INNGEST_SIGNING_KEY` (verify invocations).

## 2. Vercel project

- Root Directory: `apps/web` (enable "Include files outside root directory").
- Install Command: `pnpm install` (runs at the workspace root).
- Build Command: default (`pnpm build` → `apps/web`'s build script).

`apps/web`'s build script runs `prisma generate` before `next build`. This is
required, not belt-and-braces: the Prisma client is emitted into the **source
tree** (`packages/db/src/generated/`, gitignored), which a cached `node_modules`
does not restore — so generate must run on **every** build.

**Environment variables** (see `.env.production.example`):

| Var | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | pooled Neon URL |
| `DIRECT_URL` | yes | direct Neon URL (migrations) |
| `AUTH_SECRET` | yes | `openssl rand -base64 32` |
| `INNGEST_EVENT_KEY` | yes | runs/ingestion don't fire without it |
| `INNGEST_SIGNING_KEY` | yes | |
| `OPENROUTER_API_KEY` | for runs | agent LLM calls + embeddings |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | for Sheets export | whole JSON blob, one line |
| `GOOGLE_DRIVE_FOLDER_ID` | for Sheets export | |
| `ENCRYPTION_KEY` | for MCP connectors | aes-256-gcm master key |

`AUTH_URL` is deliberately unset — `auth.config.ts` uses `trustHost: true`.
Required vars are validated at boot and by `GET /api/health`.

## 3. Migrate + seed

```bash
# migrations run against the DIRECT url
DATABASE_URL=<direct> DIRECT_URL=<direct> pnpm --filter @repo/db exec prisma migrate deploy

# data only — in production this skips the dev users and demo estimates
NODE_ENV=production DATABASE_URL=<direct> pnpm db:seed

# the real admin: no defaults, refuses a password under 12 chars
NODE_ENV=production DATABASE_URL=<direct> \
  ADMIN_EMAIL=you@codup.co ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  pnpm db:seed:admin
```

`packages/db/src/seed.ts` still contains `admin@codup.co / admin1234` for local
dev and e2e. It refuses to create those accounts when `NODE_ENV=production` —
**do not** set `ALLOW_DEV_USERS=1` on a public deployment.

Preset **embeddings** are a separate backfill and need OpenRouter embedding
credits. Until they exist, Archivist RAG returns `coverage: none` everywhere.
The run tolerates that, but estimates are meaningfully worse.

## 4. Register the Inngest app

After the first deploy, sync the endpoint in Inngest Cloud:

```
https://<your-domain>/api/inngest
```

Without this, events are accepted and **never executed** — the UI will sit at
"queued" forever.

## 5. Verify

```bash
./scripts/smoke.sh https://<your-domain>     # health, login page, auth redirect
```

`GET /api/health` returns `200 {status:"ok"}` when the DB is reachable and
required env is present, `503` otherwise, and reports which integrations are
configured. It's public (no auth), so it works as a platform probe.

Then run **one real estimate end to end**. That is the only thing that proves
the Inngest registration, the OpenRouter key, and the per-stage duration budget
are all actually right.

## Known gaps

- `pnpm typecheck` reports ~46 errors in `packages/agents/src/*.test.ts` —
  pre-existing fixture drift against the tightened MenuItem/RoleLineItem
  schemas. **No product code is affected** (it was masked for a long time by a
  broken typecheck; see the `tsc -b` fix). `pnpm lint` likewise has ~12 dead
  imports, including an unused `config` param in `taxation.ts` that may be a
  real bug.
- CI (`.github/workflows/ci.yml`) targets GitHub, but `origin` is Bitbucket — so
  it does not appear to run anywhere.
- No automated deploy pipeline.
