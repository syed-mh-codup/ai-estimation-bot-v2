import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    include: ['src/**/*.test.ts'],
    // Pins the DB-backed tests to local Postgres. See the note in
    // packages/db/vitest.config.ts: without it, a run started from inside this
    // app picks up packages/db/.env and talks to Neon.
    setupFiles: ['../../vitest.setup.ts'],
  },
});
