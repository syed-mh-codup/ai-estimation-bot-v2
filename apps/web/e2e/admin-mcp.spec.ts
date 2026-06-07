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
  test('admin adds a connector, tests it, and enables it', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/mcp');
    await expect(page.getByTestId('admin-mcp')).toBeVisible();

    // Add a uniquely-named connector.
    const name = `Jira ${Date.now()}`;
    await page.fill('#name', name);
    await page.selectOption('#transport', 'http');
    await page.fill('#endpoint', 'https://mcp.example.com/jira');
    await page.getByTestId('add-connector').click();

    const row = page
      .locator('tr[data-testid^="connector-row-"]')
      .filter({ hasText: name });
    await expect(row).toBeVisible();

    const testCell = row.locator('[data-testid^="connector-test-"]');
    const enabledCell = row.locator('[data-testid^="connector-enabled-"]');

    // New connector starts untested + disabled.
    await expect(testCell).toHaveText('untested');
    await expect(enabledCell).toHaveText('disabled');

    // Test → status OK.
    await row.getByTestId(/^test-connector-/).click();
    await expect(testCell).toHaveText('OK');

    // Enable → status enabled.
    await row.getByTestId(/^toggle-connector-/).click();
    await expect(enabledCell).toHaveText('enabled');

    // Durable across reload.
    await page.reload();
    await expect(
      page.locator('tr[data-testid^="connector-row-"]').filter({ hasText: name }),
    ).toContainText('enabled');
  });
});
