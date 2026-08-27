import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS } from './global-setup';

/**
 * The save is a server action plus a revalidate against a remote test database,
 * and this is the first test in the suite, so it also pays the route's cold
 * compile. `toHaveText` uses the 5s EXPECT budget, not the 60s test budget.
 * Same idiom as admin-presets.spec.ts, which asserts the same version bump.
 */
const COLD_COMPILE = 30_000;

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

    // Change a value and save → new active version. The reason is required:
    // every version is kept, so what a reader needs later is why, not what.
    await page.fill('#pmCommunicationTaxPct', '42');
    await page.fill('#changeReason', 'e2e: exercising the versioned save path');
    await page.getByTestId('save-config').click();

    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`, { timeout: COLD_COMPILE });
    // The new active version carries the edited value.
    await expect(page.locator('#pmCommunicationTaxPct')).toHaveValue('42');

    // Durable across a fresh load.
    await page.reload();
    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`, { timeout: COLD_COMPILE });
    await expect(page.locator('#pmCommunicationTaxPct')).toHaveValue('42');
  });
});
