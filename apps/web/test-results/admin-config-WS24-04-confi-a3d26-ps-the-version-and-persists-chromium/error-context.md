# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-config.spec.ts >> WS24-04: config admin — edit creates a new active version >> saving a changed value bumps the version and persists
- Location: e2e/admin-config.spec.ts:14:7

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.waitForURL: Test timeout of 60000ms exceeded.
=========================== logs ===========================
waiting for navigation until "load"
  navigated to "http://localhost:3001/login"
============================================================
```

# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - main [ref=e2]:
    - generic [ref=e3]:
      - generic [ref=e4]:
        - heading "AI Estimation" [level=1] [ref=e5]
        - paragraph [ref=e6]: Scoped, priced and signed off in one place.
      - generic [ref=e8]:
        - generic [ref=e9]:
          - generic [ref=e10]: Email
          - textbox "Email" [ref=e11]:
            - /placeholder: you@company.com
            - text: e2e-admin@example.com
        - generic [ref=e12]:
          - generic [ref=e13]: Password
          - textbox "Password" [ref=e14]: e2e-admin-pw
        - button "Signing in…" [disabled]
      - paragraph [ref=e15]: Codup · internal estimation ledger
  - button "Open Next.js Dev Tools" [ref=e21] [cursor=pointer]:
    - img [ref=e22]
  - alert [ref=e25]
```

# Test source

```ts
  1  | import { test, expect, type Page } from '@playwright/test';
  2  | import { TEST_USERS } from './global-setup';
  3  | 
  4  | async function login(page: Page, email: string, password: string) {
  5  |   await page.goto('/login');
  6  |   await page.fill('#email', email);
  7  |   await page.fill('#password', password);
  8  |   await page.click('button[type="submit"]');
> 9  |   await page.waitForURL(/\/dashboard/);
     |              ^ Error: page.waitForURL: Test timeout of 60000ms exceeded.
  10 |   await expect(page.getByTestId('nav')).toBeVisible();
  11 | }
  12 | 
  13 | test.describe('WS24-04: config admin — edit creates a new active version', () => {
  14 |   test('saving a changed value bumps the version and persists', async ({ page }) => {
  15 |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  16 |     await page.goto('/admin/config');
  17 |     await expect(page.getByTestId('admin-config')).toBeVisible();
  18 | 
  19 |     const versionBadge = page.getByTestId('config-version');
  20 |     const before = (await versionBadge.textContent()) ?? 'v0';
  21 |     const beforeNum = Number(before.replace(/[^0-9]/g, ''));
  22 | 
  23 |     // Change a value and save → new active version. The reason is required:
  24 |     // every version is kept, so what a reader needs later is why, not what.
  25 |     await page.fill('#pmCommunicationTaxPct', '42');
  26 |     await page.fill('#changeReason', 'e2e: exercising the versioned save path');
  27 |     await page.getByTestId('save-config').click();
  28 | 
  29 |     await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
  30 |     // The new active version carries the edited value.
  31 |     await expect(page.locator('#pmCommunicationTaxPct')).toHaveValue('42');
  32 | 
  33 |     // Durable across a fresh load.
  34 |     await page.reload();
  35 |     await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
  36 |     await expect(page.locator('#pmCommunicationTaxPct')).toHaveValue('42');
  37 |   });
  38 | });
  39 | 
```