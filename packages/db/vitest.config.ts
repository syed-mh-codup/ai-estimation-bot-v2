import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 30000,
    // The root config supplies this; a filtered run from inside this package
    // does not inherit it. Without it Prisma Client auto-loads THIS package's
    // .env, which points at Neon — so `vitest run src/one.test.ts` from here
    // would create and delete fixtures in the real database. Same file, same
    // reason, as packages/agents.
    setupFiles: ['../../vitest.setup.ts'],
  },
});
