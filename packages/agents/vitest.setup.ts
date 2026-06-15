// Pin the integration tests to a LOCAL database. The app's packages/db/.env now
// points at Neon, and Prisma Client auto-loads it — without this the DB-backed
// tests would run against Neon and blow their hook timeouts on network latency.
// Runs before any test imports Prisma, and dotenv won't override an already-set
// var, so this local default wins. Override with DATABASE_URL for CI.
process.env['DATABASE_URL'] ??=
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
process.env['DIRECT_URL'] ??= process.env['DATABASE_URL'];
