import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig, devices } from '@playwright/test';

// Load the same env the dev server uses so TEST_DATABASE_URL is available here.
loadEnv({ path: path.resolve(__dirname, '.env.local') });

const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
if (!TEST_DB_URL) {
  throw new Error('TEST_DATABASE_URL must be set (apps/web/.env.local) to run e2e in isolation.');
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: 'list',
  // Generous per-test timeout: the agents-heavy /estimates/[id] route's cold
  // first-compile under `next dev` can exceed the 30s default when its spec runs
  // first in the suite (passes in ~11s once warm).
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm dev --port 3001',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
    // Point the app-under-test at the isolated test DB. Next does not override
    // env vars already present in process.env, so this wins over .env.local.
    //
    // Google credentials are blanked deliberately. createSheetsProvider() falls
    // back to StubSheetsProvider when either var is empty, which is what the
    // refinement spec means by "export to Sheets (stub)". With the real creds
    // from .env.local the export hits the live API and fails with "The caller
    // does not have permission" — a test making a real third-party call against
    // someone's Drive folder, which it should never do.
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      DIRECT_URL: TEST_DB_URL,
      GOOGLE_SERVICE_ACCOUNT_JSON: '',
      GOOGLE_DRIVE_FOLDER_ID: '',
    } as Record<string, string>,
  },
});
