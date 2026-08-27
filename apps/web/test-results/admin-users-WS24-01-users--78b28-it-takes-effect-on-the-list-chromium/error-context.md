# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-users.spec.ts >> WS24-01: users admin — list + set role >> admin changes a user role and it takes effect on the list
- Location: e2e/admin-users.spec.ts:18:7

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
  4  | async function login(page: Page, email: string, password: string) {
  5  |   await page.goto('/login');
> 6  |   await page.fill('#email', email);
     |              ^ Error: page.fill: Test timeout of 60000ms exceeded.
  7  |   await page.fill('#password', password);
  8  |   await page.click('button[type="submit"]');
  9  |   await page.waitForURL(/\/dashboard/);
  10 |   await expect(page.getByTestId('nav')).toBeVisible();
  11 | }
  12 | 
  13 | function rowFor(page: Page, email: string) {
  14 |   return page.locator('tr[data-testid^="user-row-"]').filter({ hasText: email });
  15 | }
  16 | 
  17 | test.describe('WS24-01: users admin — list + set role', () => {
  18 |   test('admin changes a user role and it takes effect on the list', async ({ page }) => {
  19 |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  20 |     await page.goto('/admin/users');
  21 |     await expect(page.getByTestId('users-table')).toBeVisible();
  22 | 
  23 |     // Operate on the dedicated throwaway user so shared fixtures stay intact.
  24 |     const row = rowFor(page, TEST_USERS.roleTarget.email);
  25 |     const roleBadge = row.locator('[data-testid^="role-"]');
  26 | 
  27 |     // Starts as ESTIMATOR (reset by global-setup each run).
  28 |     await expect(roleBadge).toHaveText('ESTIMATOR');
  29 | 
  30 |     // Promote to ADMIN; revalidatePath re-renders the list with the new value.
  31 |     await row.getByTestId(/^set-role-/).click();
  32 |     await expect(roleBadge).toHaveText('ADMIN');
  33 | 
  34 |     // And the change is durable across a fresh load.
  35 |     await page.reload();
  36 |     await expect(roleBadge).toHaveText('ADMIN');
  37 |   });
  38 | 
  39 |   test('an admin cannot demote their own account (button disabled)', async ({ page }) => {
  40 |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  41 |     await page.goto('/admin/users');
  42 | 
  43 |     // The acting admin's own row has its demote action disabled.
  44 |     const ownRow = rowFor(page, TEST_USERS.admin.email);
  45 |     await expect(ownRow.getByTestId(/^set-role-/)).toBeDisabled();
  46 |   });
  47 | 
  48 |   test('role change invalidates the target session live (no re-login)', async ({ browser }) => {
  49 |     // Two isolated browser contexts: the target user and an admin.
  50 |     const targetCtx = await browser.newContext();
  51 |     const adminCtx = await browser.newContext();
  52 |     try {
  53 |       const targetPage = await targetCtx.newPage();
  54 |       const adminPage = await adminCtx.newPage();
  55 | 
  56 |       // Target logs in as an estimator — no admin nav.
  57 |       await login(
  58 |         targetPage,
  59 |         TEST_USERS.liveInvalidation.email,
  60 |         TEST_USERS.liveInvalidation.password,
  61 |       );
  62 |       await expect(targetPage.getByTestId('nav-admin-users')).toHaveCount(0);
  63 | 
  64 |       // Admin promotes the target to ADMIN.
  65 |       await login(adminPage, TEST_USERS.admin.email, TEST_USERS.admin.password);
  66 |       await adminPage.goto('/admin/users');
  67 |       await rowFor(adminPage, TEST_USERS.liveInvalidation.email)
  68 |         .getByTestId(/^set-role-/)
  69 |         .click();
  70 |       await expect(
  71 |         rowFor(adminPage, TEST_USERS.liveInvalidation.email).locator('[data-testid^="role-"]'),
  72 |       ).toHaveText('ADMIN');
  73 | 
  74 |       // Target merely reloads — no re-login — and now sees the admin nav,
  75 |       // because the jwt callback re-reads the role from the DB each request.
  76 |       await targetPage.reload();
  77 |       await expect(targetPage.getByTestId('nav-admin-users')).toBeVisible();
  78 |     } finally {
  79 |       await targetCtx.close();
  80 |       await adminCtx.close();
  81 |     }
  82 |   });
  83 | });
  84 | 
```