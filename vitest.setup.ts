// Pin DB-backed integration tests to a LOCAL database. The app's packages/db/.env
// points at Neon and Prisma Client auto-loads it; without this, integration tests
// would run against Neon and blow their hook timeouts. Override with DATABASE_URL.
process.env['DATABASE_URL'] ??=
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
process.env['DIRECT_URL'] ??= process.env['DATABASE_URL'];
