import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '../../../packages/db/src/generated/client/index.js';
import { TEST_USERS } from './global-setup';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

test.describe('WS24-03: presets admin — edit creates a new active version + diff', () => {
  test('admin edits a preset; version bumps, history grows, diff shown', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    await page.goto('/admin/presets');
    await expect(page.getByTestId('presets-table')).toBeVisible();

    await page.getByTestId('preset-link-E2E-PRESET').click();
    await expect(page).toHaveURL(/\/admin\/presets\/E2E-PRESET/);
    await expect(page.getByTestId('admin-preset-editor')).toBeVisible();

    const versionBadge = page.getByTestId('preset-active-version');
    const before = (await versionBadge.textContent()) ?? 'v0';
    const beforeNum = Number(before.replace(/[^0-9]/g, ''));

    // Edit BE hours and save → new active version.
    await page.fill('#beHours', '99');
    await page.getByTestId('save-preset').click();

    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
    await expect(page.locator('#beHours')).toHaveValue('99');

    // History retains the previous version; diff shows the change.
    await expect(page.getByTestId(`preset-version-${beforeNum + 1}`)).toContainText('active');
    await expect(page.getByTestId(`preset-version-${beforeNum}`)).toContainText('inactive');
    await expect(page.getByTestId('preset-diff')).toContainText('beHours');

    // Durable across reload.
    await page.reload();
    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
    await expect(page.locator('#beHours')).toHaveValue('99');

    // The new active version must still carry a vector. Saving used to leave
    // `embedding` null, which silently removed the preset from Archivist
    // retrieval for good — no error, it just stopped ever matching.
    const db = new PrismaClient({
      datasources: { db: { url: process.env['TEST_DATABASE_URL']! } },
    });
    try {
      const rows = await db.$queryRawUnsafe<Array<{ version: number; has: boolean }>>(
        `SELECT version, embedding IS NOT NULL AS has
           FROM "PresetVersion" WHERE "presetId" = 'E2E-PRESET' AND active = true`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe(beforeNum + 1);
      expect(rows[0]?.has).toBe(true);
    } finally {
      await db.$disconnect();
    }
  });
});
