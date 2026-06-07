import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS } from './global-setup';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

test.describe('WS24-02: MCP connectors admin — add, test, enable', () => {
  test('admin adds a connector, tests it (live), and enables it', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/mcp');
    await expect(page.getByTestId('admin-mcp')).toBeVisible();

    // Add a uniquely-named connector pointing at a port that refuses
    // connections — deterministic, offline-safe, and exercises the REAL MCP
    // client's failure path (no stub).
    const name = `Refused ${Date.now()}`;
    await page.fill('#name', name);
    await page.selectOption('#transport', 'http');
    await page.fill('#endpoint', 'http://127.0.0.1:1/mcp');
    await page.getByTestId('add-connector').click();

    const row = page
      .locator('tr[data-testid^="connector-row-"]')
      .filter({ hasText: name });
    await expect(row).toBeVisible();

    const testCell = row.locator('[data-testid^="connector-test-"]');
    const enabledCell = row.locator('[data-testid^="connector-enabled-"]');

    await expect(testCell).toHaveText('untested');
    await expect(enabledCell).toHaveText('disabled');

    // Test → the live client tries to connect, fails, and reports it.
    await row.getByTestId(/^test-connector-/).click();
    await expect(page.getByTestId('mcp-test-result')).toContainText('failed');
    await expect(testCell).toHaveText('failed');

    // Enable still works regardless of test outcome.
    await row.getByTestId(/^toggle-connector-/).click();
    await expect(enabledCell).toHaveText('enabled');
  });
});
