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
  // Deliberately 0, and worth leaving at 0.
  //
  // A retry was tried here and removed. Because the second attempt runs against
  // an already-compiled route, it passes for a reason that has nothing to do
  // with the thing under test — the suite reports green and the run is marked
  // "flaky", which is the same word for "we do not know". Measured directly: the
  // cold /estimates/[id] assertion failed at 15s and passed on retry, so the
  // retry would have concealed exactly the defect this ticket exists to fix.
  //
  // The cold compile is dealt with at its source instead — global-setup warms
  // every heavy route before the first spec runs. Nothing left needs a retry.
  retries: 0,
  workers: 1,
  reporter: 'list',
  // Per-test budget. It no longer has to cover a cold compile — global-setup
  // warms every heavy route first — but a few specs drive a whole multi-step
  // flow (the refinement spec toggles, edits, awaits a write, reloads, exports
  // and finalises) and call test.slow(), which triples whatever this is.
  timeout: 60_000,
  // This is the line the suite was missing, and the one that made it fail on a
  // different test every run.
  //
  // The per-test budget above does NOT reach assertions: every `expect(...)`
  // gets its own separate budget, which defaults to 5s. So `page.waitForURL(…)`
  // had 60s while `expect(page).toHaveURL(…)` — the same wait written the other
  // way — had 5. Whichever spec happened to reach a heavy route first paid that
  // route's compile inside an assertion and failed; every later spec passed
  // because the first one had warmed it. The failure therefore moved between
  // runs, which reads as flakiness and is not.
  //
  // 15s is a ceiling for work that should be quick, not a compile budget —
  // global-setup's warm-up is what makes that distinction hold. Measured
  // without it, a cold /estimates/[id] blew straight through this.
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://localhost:3001',
    // Not 'on-first-retry': with retries at 0 there is no first retry, so that
    // setting captures nothing, ever. A failure is the case worth a trace — and
    // in CI it is the only way to read what happened.
    trace: 'retain-on-failure',
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
    // Boot budget, not compile budget — `next dev` serves before it has compiled
    // any route. 120s because a CI runner is slower to start Node than a laptop,
    // and a webServer timeout aborts the whole run rather than one test.
    timeout: 120_000,
    // Point the app-under-test at the isolated test DB. Next does not override
    // env vars already present in process.env, so this wins over .env.local.
    //
    // Google credentials are blanked deliberately. createSheetsProvider() falls
    // back to StubSheetsProvider when either var is empty, which is what the
    // refinement spec means by "export to Sheets (stub)". With the real creds
    // from .env.local the export hits the live API and fails with "The caller
    // does not have permission" — a test making a real third-party call against
    // someone's Drive folder, which it should never do.
    //
    // OPENROUTER_STUB does the same job for OpenRouter: Oracle answers from a
    // deterministic stub, and the /admin/prompts model picker gets a fixed
    // catalogue instead of whatever OpenRouter is serving today. Its own flag
    // rather than blanking OPENROUTER_API_KEY, which the ingest path also
    // reads — blanking that would change a subsystem these specs are not
    // testing. The Oracle stub still quotes the estimate it was given, so the
    // citation and quote-jump assertions exercise real matching.
    env: {
      ...process.env,
      DATABASE_URL: TEST_DB_URL,
      DIRECT_URL: TEST_DB_URL,
      GOOGLE_SERVICE_ACCOUNT_JSON: '',
      GOOGLE_DRIVE_FOLDER_ID: '',
      OPENROUTER_STUB: '1',
    } as Record<string, string>,
  },
});
