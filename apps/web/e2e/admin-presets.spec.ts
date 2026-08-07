import { test, expect, type Page } from '@playwright/test';
import { PrismaClient } from '../../../packages/db/src/generated/client/index.js';
import { TEST_USERS } from './global-setup';

/**
 * Budget for a route's first compile under `next dev`. The preset editor is a
 * heavy route and its save round-trip lands well past the 5s an assertion allows
 * by default; playwright.config's 60s per-test timeout already covers it.
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

test.describe('WS24-03: presets admin — edit creates a new active version + diff', () => {
  test('admin edits a preset; version bumps, history grows, diff shown', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    await page.goto('/admin/presets');
    await expect(page.getByTestId('presets-table')).toBeVisible();

    await page.getByTestId('preset-link-E2E-PRESET').click();
    await page.waitForURL(/\/admin\/presets\/E2E-PRESET/, { timeout: COLD_COMPILE });
    await expect(page.getByTestId('admin-preset-editor')).toBeVisible();

    const versionBadge = page.getByTestId('preset-active-version');
    const before = (await versionBadge.textContent()) ?? 'v0';
    const beforeNum = Number(before.replace(/[^0-9]/g, ''));

    // Edit dev hours and save → new active version.
    await page.fill('#devHours', '99');
    await page.getByTestId('save-preset').click();

    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`, { timeout: COLD_COMPILE });
    await expect(page.locator('#devHours')).toHaveValue('99');

    // History retains the previous version; diff shows the change.
    await expect(page.getByTestId(`preset-version-${beforeNum + 1}`)).toContainText('active');
    await expect(page.getByTestId(`preset-version-${beforeNum}`)).toContainText('inactive');
    await expect(page.getByTestId('preset-diff')).toContainText('devHours');

    // Durable across reload.
    await page.reload();
    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
    await expect(page.locator('#devHours')).toHaveValue('99');

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

test.describe('preset creation', () => {
  test('an admin creates a preset without ever supplying a number', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    await page.goto('/admin/presets');
    await page.getByTestId('new-preset').click();
    await page.waitForURL(/\/admin\/presets\/new/, { timeout: COLD_COMPILE });

    // The point of the whole scheme: no id and no number field to fill in.
    await expect(page.locator('input[name="id"]')).toHaveCount(0);
    await expect(page.locator('input[name="code"]')).toHaveCount(0);

    const unique = `E2E Created Preset ${Date.now()}`;
    await page.getByTestId('new-preset-name').fill(unique);
    await page.getByTestId('new-preset-category').fill('E2E');
    await page.getByTestId('new-preset-reqtype').fill('UI Component');
    await page
      .getByTestId('new-preset-description')
      .fill('Created by the e2e suite to prove presets can be added by hand.');
    await page.getByTestId('new-preset-devhours').fill('12');
    await page.getByTestId('new-preset-keywords').fill('e2e, created');
    await page.getByTestId('create-preset').click();

    // Lands on the editor, which shows an allocated code rather than a cuid.
    await page.waitForURL(/\/admin\/presets\/(?!new)[^/]+$/, { timeout: COLD_COMPILE });
    await expect(page.getByTestId('admin-preset-editor')).toBeVisible();
    await expect(page.getByTestId('preset-code')).toHaveText(/^P\d+$/);
    await expect(page.locator('#devHours')).toHaveValue('12');

    // Recorded as hand-entered, with a real embedding-worthy description, and
    // the URL is the cuid id — not the code.
    const db = new PrismaClient({
      datasources: { db: { url: process.env['TEST_DATABASE_URL']! } },
    });
    try {
      const rows = await db.$queryRawUnsafe<Array<{ code: string; origin: string; id: string }>>(
        `SELECT p.id, p.code, p.origin FROM "Preset" p
           JOIN "PresetVersion" v ON v."presetId" = p.id
          WHERE v.name = $1`,
        unique,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.origin).toBe('MANUAL');
      expect(rows[0]!.code).toMatch(/^P\d+$/);
      expect(rows[0]!.id).not.toBe(rows[0]!.code);
      await db.presetVersion.deleteMany({ where: { presetId: rows[0]!.id } });
      await db.preset.delete({ where: { id: rows[0]!.id } });
    } finally {
      await db.$disconnect();
    }
  });

  test('refuses a preset with no description — it would never match anything', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/presets/new');

    await page.getByTestId('new-preset-name').fill('No description');
    await page.getByTestId('new-preset-category').fill('E2E');
    await page.getByTestId('new-preset-reqtype').fill('UI Component');
    await page.getByTestId('new-preset-description').fill('short');
    await page.getByTestId('create-preset').click();

    await expect(page.getByTestId('new-preset-error')).toContainText('description');
    await expect(page).toHaveURL(/\/admin\/presets\/new/);
  });
});
