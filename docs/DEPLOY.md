# Deploy Runbook (WS28-03/04)

> Status: deploy **config + probes are ready**; an actual deployment requires
> hosting/secrets access (not performed here). Follow this to deploy + verify.

## Target
- **Web (Next.js app)** → Vercel (or any Node host). The estimate pipeline runs
  inside the app's server actions, so there is no separate worker to deploy yet.
- **Database** → managed Postgres **with the `pgvector` extension** (e.g. Neon,
  Supabase, RDS + pgvector). Run migrations against it: `prisma migrate deploy`.

## 1. Provision
- Create the managed Postgres; enable `pgvector` (`CREATE EXTENSION vector;`).
- Set secrets in the host's secret manager (see `.env.production.example`):
  required `DATABASE_URL`, `AUTH_SECRET`; optional `OPENROUTER_API_KEY`,
  `GOOGLE_SERVICE_ACCOUNT_JSON`, `GOOGLE_DRIVE_FOLDER_ID`, `ENCRYPTION_KEY`.

## 2. Vercel project settings (monorepo)
- Root Directory: `apps/web`
- Install Command: `pnpm install` (run at repo root)
- Build Command: `pnpm --filter web build`
- Add the env vars above.

## 3. Migrate + seed
```bash
DATABASE_URL=<prod> pnpm --filter @repo/db exec prisma migrate deploy
DATABASE_URL=<prod> pnpm db:seed          # users, config, prompts, 45 presets, taxonomy
```
(Preset **embeddings** require OpenRouter embedding credits — backfill separately.)

## 4. Health probe
Point the platform's health check at **`GET /api/health`** — returns `200 {status:"ok"}`
when DB is reachable and required env is present, `503` otherwise. It's public (no auth).

## 5. Post-deploy smoke
```bash
./scripts/smoke.sh https://your-deployment.example.com
```
Checks `/api/health`, the login page, and the protected-route redirect. Authenticated
flows + a real estimate run (needs OpenRouter credits) are covered by the e2e suite and
manual verification.

## Not yet automated
- A CI deploy pipeline and a worker host for long-running agent jobs (the run is
  currently synchronous inside the web request).
