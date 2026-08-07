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
    root: resolve(__dirname, '.'),
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    setupFiles: [resolve(__dirname, 'vitest.setup.ts')],
  },
});
