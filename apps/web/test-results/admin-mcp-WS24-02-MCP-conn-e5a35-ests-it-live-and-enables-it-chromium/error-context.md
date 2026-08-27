# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: admin-mcp.spec.ts >> WS24-02: MCP connectors admin — add, test, enable >> admin adds a connector, tests it (live), and enables it
- Location: e2e/admin-mcp.spec.ts:14:7

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
  13 | test.describe('WS24-02: MCP connectors admin — add, test, enable', () => {
  14 |   test('admin adds a connector, tests it (live), and enables it', async ({ page }) => {
  15 |     await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
  16 |     await page.goto('/admin/mcp');
  17 |     await expect(page.getByTestId('admin-mcp')).toBeVisible();
  18 | 
  19 |     // Add a uniquely-named connector pointing at a port that refuses
  20 |     // connections — deterministic, offline-safe, and exercises the REAL MCP
  21 |     // client's failure path (no stub).
  22 |     const name = `Refused ${Date.now()}`;
  23 |     await page.fill('#name', name);
  24 |     await page.selectOption('#transport', 'http');
  25 |     await page.fill('#endpoint', 'http://127.0.0.1:1/mcp');
  26 |     await page.getByTestId('add-connector').click();
  27 | 
  28 |     const row = page
  29 |       .locator('tr[data-testid^="connector-row-"]')
  30 |       .filter({ hasText: name });
  31 |     await expect(row).toBeVisible();
  32 | 
  33 |     const testCell = row.locator('[data-testid^="connector-test-"]');
  34 |     const enabledCell = row.locator('[data-testid^="connector-enabled-"]');
  35 | 
  36 |     await expect(testCell).toHaveText('untested');
  37 |     await expect(enabledCell).toHaveText('disabled');
  38 | 
  39 |     // Test → the live client tries to connect, fails, and reports it.
  40 |     await row.getByTestId(/^test-connector-/).click();
  41 |     await expect(page.getByTestId('mcp-test-result')).toContainText('failed');
  42 |     await expect(testCell).toHaveText('failed');
  43 | 
  44 |     // Enable still works regardless of test outcome.
  45 |     await row.getByTestId(/^toggle-connector-/).click();
  46 |     await expect(enabledCell).toHaveText('enabled');
  47 |   });
  48 | });
  49 | 
```