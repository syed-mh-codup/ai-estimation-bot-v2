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

test.describe('WS24-04: config admin — edit creates a new active version', () => {
  test('saving a changed value bumps the version and persists', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/config');
    await expect(page.getByTestId('admin-config')).toBeVisible();

    const versionBadge = page.getByTestId('config-version');
    const before = (await versionBadge.textContent()) ?? 'v0';
    const beforeNum = Number(before.replace(/[^0-9]/g, ''));

    // Change a value and save → new active version.
    await page.fill('#pmCommunicationTaxPct', '42');
    await page.getByTestId('save-config').click();

    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
    // The new active version carries the edited value.
    await expect(page.locator('#pmCommunicationTaxPct')).toHaveValue('42');

    // Durable across a fresh load.
    await page.reload();
    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
    await expect(page.locator('#pmCommunicationTaxPct')).toHaveValue('42');
  });
});
