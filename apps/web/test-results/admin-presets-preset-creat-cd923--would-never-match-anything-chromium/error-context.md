# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-presets.spec.ts >> preset creation >> refuses a preset with no description — it would never match anything
- Location: e2e/admin-presets.spec.ts:125:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.fill: Test timeout of 60000ms exceeded.
Call log:
  - waiting for locator('#email')

```

# Page snapshot

```yaml
- generic [ref=e2]: Internal Server Error
```

# Test source

```ts
  1   | import { test, expect, type Page } from '@playwright/test';
  2   | import { PrismaClient } from '../../../packages/db/src/generated/client/index.js';
  3   | import { TEST_USERS } from './global-setup';
  4   | 
  5   | /**
  6   |  * Budget for a route's first compile under `next dev`. The preset editor is a
  7   |  * heavy route and its save round-trip lands well past the 5s an assertion allows
  8   |  * by default; playwright.config's 60s per-test timeout already covers it.
  9   |  */
  10  | const COLD_COMPILE = 30_000;
  11  | 
  12  | async function login(page: Page, email: string, password: string) {
  13  |   await page.goto('/login');
> 14  |   await page.fill('#email', email);
      |              ^ Error: page.fill: Test timeout of 60000ms exceeded.
  15  |   await page.fill('#password', password);
  16  |   await page.click('button[type="submit"]');
  17  |   await page.waitForURL(/\/dashboard/);
  18  |   await expect(page.getByTestId('nav')).toBeVisible();
  19  | }
  20  | 
  21  | test.describe('WS24-03: presets admin — edit creates a new active version + diff', () => {
  22  |   test('admin edits a preset; version bumps, history grows, diff shown', async ({ page }) => {
  23  |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  24  | 
  25  |     await page.goto('/admin/presets');
  26  |     await expect(page.getByTestId('presets-table')).toBeVisible();
  27  | 
  28  |     await page.getByTestId('preset-link-E2E-PRESET').click();
  29  |     await page.waitForURL(/\/admin\/presets\/E2E-PRESET/, { timeout: COLD_COMPILE });
  30  |     await expect(page.getByTestId('admin-preset-editor')).toBeVisible();
  31  | 
  32  |     const versionBadge = page.getByTestId('preset-active-version');
  33  |     const before = (await versionBadge.textContent()) ?? 'v0';
  34  |     const beforeNum = Number(before.replace(/[^0-9]/g, ''));
  35  | 
  36  |     // Edit dev hours and save → new active version.
  37  |     await page.fill('#devHours', '99');
  38  |     await page.getByTestId('save-preset').click();
  39  | 
  40  |     await expect(versionBadge).toHaveText(`v${beforeNum + 1}`, { timeout: COLD_COMPILE });
  41  |     await expect(page.locator('#devHours')).toHaveValue('99');
  42  | 
  43  |     // History retains the previous version; diff shows the change.
  44  |     await expect(page.getByTestId(`preset-version-${beforeNum + 1}`)).toContainText('active');
  45  |     await expect(page.getByTestId(`preset-version-${beforeNum}`)).toContainText('inactive');
  46  |     await expect(page.getByTestId('preset-diff')).toContainText('devHours');
  47  | 
  48  |     // Durable across reload.
  49  |     await page.reload();
  50  |     await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
  51  |     await expect(page.locator('#devHours')).toHaveValue('99');
  52  | 
  53  |     // The new active version must still carry a vector. Saving used to leave
  54  |     // `embedding` null, which silently removed the preset from Archivist
  55  |     // retrieval for good — no error, it just stopped ever matching.
  56  |     const db = new PrismaClient({
  57  |       datasources: { db: { url: process.env['TEST_DATABASE_URL']! } },
  58  |     });
  59  |     try {
  60  |       const rows = await db.$queryRawUnsafe<Array<{ version: number; has: boolean }>>(
  61  |         `SELECT version, embedding IS NOT NULL AS has
  62  |            FROM "PresetVersion" WHERE "presetId" = 'E2E-PRESET' AND active = true`,
  63  |       );
  64  |       expect(rows).toHaveLength(1);
  65  |       expect(rows[0]?.version).toBe(beforeNum + 1);
  66  |       expect(rows[0]?.has).toBe(true);
  67  |     } finally {
  68  |       await db.$disconnect();
  69  |     }
  70  |   });
  71  | });
  72  | 
  73  | test.describe('preset creation', () => {
  74  |   test('an admin creates a preset without ever supplying a number', async ({ page }) => {
  75  |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  76  | 
  77  |     await page.goto('/admin/presets');
  78  |     await page.getByTestId('new-preset').click();
  79  |     await page.waitForURL(/\/admin\/presets\/new/, { timeout: COLD_COMPILE });
  80  | 
  81  |     // The point of the whole scheme: no id and no number field to fill in.
  82  |     await expect(page.locator('input[name="id"]')).toHaveCount(0);
  83  |     await expect(page.locator('input[name="code"]')).toHaveCount(0);
  84  | 
  85  |     const unique = `E2E Created Preset ${Date.now()}`;
  86  |     await page.getByTestId('new-preset-name').fill(unique);
  87  |     await page.getByTestId('new-preset-category').fill('E2E');
  88  |     await page.getByTestId('new-preset-reqtype').fill('UI Component');
  89  |     await page
  90  |       .getByTestId('new-preset-description')
  91  |       .fill('Created by the e2e suite to prove presets can be added by hand.');
  92  |     await page.getByTestId('new-preset-devhours').fill('12');
  93  |     await page.getByTestId('new-preset-keywords').fill('e2e, created');
  94  |     await page.getByTestId('create-preset').click();
  95  | 
  96  |     // Lands on the editor, which shows an allocated code rather than a cuid.
  97  |     await page.waitForURL(/\/admin\/presets\/(?!new)[^/]+$/, { timeout: COLD_COMPILE });
  98  |     await expect(page.getByTestId('admin-preset-editor')).toBeVisible();
  99  |     await expect(page.getByTestId('preset-code')).toHaveText(/^P\d+$/);
  100 |     await expect(page.locator('#devHours')).toHaveValue('12');
  101 | 
  102 |     // Recorded as hand-entered, with a real embedding-worthy description, and
  103 |     // the URL is the cuid id — not the code.
  104 |     const db = new PrismaClient({
  105 |       datasources: { db: { url: process.env['TEST_DATABASE_URL']! } },
  106 |     });
  107 |     try {
  108 |       const rows = await db.$queryRawUnsafe<Array<{ code: string; origin: string; id: string }>>(
  109 |         `SELECT p.id, p.code, p.origin FROM "Preset" p
  110 |            JOIN "PresetVersion" v ON v."presetId" = p.id
  111 |           WHERE v.name = $1`,
  112 |         unique,
  113 |       );
  114 |       expect(rows).toHaveLength(1);
```