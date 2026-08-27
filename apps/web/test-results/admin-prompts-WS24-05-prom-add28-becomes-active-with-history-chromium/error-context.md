# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-prompts.spec.ts >> WS24-05: prompts admin — edit creates a new active version >> admin edits a prompt and a new version becomes active with history
- Location: e2e/admin-prompts.spec.ts:17:7

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
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | import { TEST_USERS } from './global-setup';
  3  | 
  4  | /** Budget for a route's first compile under `next dev`. */
  5  | const COLD_COMPILE = 30_000;
  6  | 
  7  | async function login(page: Page, email: string, password: string) {
  8  |   await page.goto('/login');
> 9  |   await page.fill('#email', email);
     |              ^ Error: page.fill: Test timeout of 60000ms exceeded.
  10 |   await page.fill('#password', password);
  11 |   await page.click('button[type="submit"]');
  12 |   await page.waitForURL(/\/dashboard/);
  13 |   await expect(page.getByTestId('nav')).toBeVisible();
  14 | }
  15 | 
  16 | test.describe('WS24-05: prompts admin — edit creates a new active version', () => {
  17 |   test('admin edits a prompt and a new version becomes active with history', async ({ page }) => {
  18 |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  19 | 
  20 |     await page.goto('/admin/prompts');
  21 |     await expect(page.getByTestId('prompts-table')).toBeVisible();
  22 | 
  23 |     // Open the LIBRARIAN prompt editor.
  24 |     await page.getByTestId('prompt-link-LIBRARIAN').click();
  25 |     // These routes' cold first compile under `next dev` can outlast the 5s an
  26 |     // assertion allows by default (playwright.config's 60s per-test budget
  27 |     // covers it, but the individual wait has to be told).
  28 |     await page.waitForURL(/\/admin\/prompts\/LIBRARIAN/, { timeout: COLD_COMPILE });
  29 |     await expect(page.getByTestId('admin-prompt-editor')).toBeVisible();
  30 | 
  31 |     const versionBadge = page.getByTestId('prompt-active-version');
  32 |     const before = (await versionBadge.textContent()) ?? 'v0';
  33 |     const beforeNum = Number(before.replace(/[^0-9]/g, ''));
  34 | 
  35 |     // Edit the body and save → new active version.
  36 |     const newBody = `Edited librarian prompt ${Date.now()}`;
  37 |     await page.fill('#body', newBody);
  38 |     // A change reason is required — a prompt edit moves every estimate's numbers,
  39 |     // so the record has to say why.
  40 |     await page.fill('#changeReason', 'e2e: exercising the versioned save path');
  41 |     await page.getByTestId('save-prompt').click();
  42 | 
  43 |     await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
  44 |     await expect(page.locator('#body')).toHaveValue(newBody);
  45 | 
  46 |     // History shows the new active version and retains the previous one.
  47 |     await expect(page.getByTestId(`prompt-version-${beforeNum + 1}`)).toContainText('active');
  48 |     await expect(page.getByTestId(`prompt-version-${beforeNum}`)).toContainText('inactive');
  49 | 
  50 |     // Durable across reload.
  51 |     await page.reload();
  52 |     await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
  53 |     await expect(page.locator('#body')).toHaveValue(newBody);
  54 |   });
  55 | });
  56 | 
  57 | test.describe('View a prompt version\'s details and activate an older one', () => {
  58 |   test('admin views v1 details and reactivates it, making it the active version again', async ({ page }) => {
  59 |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  60 | 
  61 |     await page.goto('/admin/prompts/LIBRARIAN');
  62 |     await expect(page.getByTestId('admin-prompt-editor')).toBeVisible();
  63 | 
  64 |     const versionBadge = page.getByTestId('prompt-active-version');
  65 |     const activeBefore = Number(((await versionBadge.textContent()) ?? 'v0').replace(/[^0-9]/g, ''));
  66 | 
  67 |     // Open the detail view for v1 (guaranteed to exist and, once activeBefore > 1, inactive).
  68 |     await page.getByTestId('prompt-version-link-1').click();
  69 |     await page.waitForURL(/\/admin\/prompts\/LIBRARIAN\/1$/, { timeout: COLD_COMPILE });
  70 |     await expect(page.getByTestId('admin-prompt-version-detail')).toBeVisible();
  71 |     await expect(page.getByTestId('version-body')).not.toHaveValue('');
  72 |     await expect(page.getByTestId('version-model')).not.toBeEmpty();
  73 | 
  74 |     if (activeBefore === 1) {
  75 |       // v1 is already active — nothing to activate, detail view has no button.
  76 |       await expect(page.getByTestId('activate-version')).toHaveCount(0);
  77 |       return;
  78 |     }
  79 | 
  80 |     await expect(page.getByTestId('version-status')).toHaveText('inactive');
  81 |     await page.getByTestId('activate-version').click();
  82 | 
  83 |     // Activating redirects back to the editor with v1 now active.
  84 |     await page.waitForURL(/\/admin\/prompts\/LIBRARIAN$/, { timeout: COLD_COMPILE });
  85 |     await expect(versionBadge).toHaveText('v1');
  86 |     await expect(page.getByTestId('prompt-version-1')).toContainText('active');
  87 |     await expect(page.getByTestId(`prompt-version-${activeBefore}`)).toContainText('inactive');
  88 | 
  89 |     // Durable across reload.
  90 |     await page.reload();
  91 |     await expect(versionBadge).toHaveText('v1');
  92 |   });
  93 | });
  94 | 
```