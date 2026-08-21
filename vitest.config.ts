import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  // apps/web uses the `@/…` path alias (tsconfig paths). Keyed on '@/' rather
  // than '@' so it can't also capture the `@repo/*` workspace packages.
  resolve: {
    alias: { '@/': `${resolve(__dirname, 'apps/web/src')}/` },
  },
  test: {
    environment: 'node',
    // Match every per-package vitest config. Without these the root run gives
    // the DB-backed integration tests vitest's defaults (5s per test, 10s per
    // hook) — comfortable against a local Postgres, not against a cold CI
    // service container.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    root: resolve(__dirname, '.'),
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
  },
});
