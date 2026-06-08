# Setup & Seed Runbook (WS28-02)

One-command bring-up of a working instance from a clean checkout.

## Prerequisites
- Node ≥ 20, pnpm ≥ 9, Docker.

## 1. Install
```bash
pnpm install
```

## 2. Environment
Copy the example env files and fill in values (see `.env.example` for the full reference):
```bash
cp packages/db/.env.example packages/db/.env          # DATABASE_URL
cp apps/web/.env.example apps/web/.env.local           # DATABASE_URL + AUTH_SECRET (+ OPENROUTER_API_KEY for runs)
```
- `DATABASE_URL` must match in **both** files (local docker default: `postgresql://postgres:postgres@localhost:5433/ai_estimation`).
- `AUTH_SECRET`: `openssl rand -base64 32`.
- `OPENROUTER_API_KEY`: only needed to actually **run** an estimate (the AI pipeline). Everything else works without it.

## 3. Database (Postgres + pgvector)
```bash
docker compose up -d            # postgres on host port 5433
```

## 4. Migrate + seed (one command)
```bash
pnpm db:setup
```
This runs `prisma migrate deploy` then seeds, in order:
1. `db:seed` — admin/estimator users, active `EstimationConfig` v1, 3 sample-SOW estimates, 9 agent prompts.
2. `db:seed:presets` — 45 presets (P01–P45) from `docs/Estimate Presets (ISM).xlsx`.
3. `db:seed:taxonomy` — derives the taxonomy from presets and links them.

> Re-running is idempotent. To re-seed only (DB already migrated): `pnpm db:seed`.

**Embeddings note:** preset embeddings (for Archivist similarity RAG) are NOT generated here —
they require OpenRouter embedding credits. Backfill them separately once credits exist; the rest
of the pipeline runs without them.

## 5. Run the app
```bash
pnpm dev                        # http://localhost:3000
```
Log in: **admin@codup.co / admin1234** (ADMIN) or **estimator@codup.co / estimator1234** (ESTIMATOR).

## 6. Tests
```bash
pnpm test                                   # unit/integration (needs DB up)
pnpm --filter web exec playwright test      # e2e (boots its own dev server on 3001)
```

## Ports
| Thing | Port |
|-------|------|
| Manual dev server (`pnpm dev`) | 3000 |
| Playwright dev server | 3001 |
| Postgres (docker) | 5433 |
