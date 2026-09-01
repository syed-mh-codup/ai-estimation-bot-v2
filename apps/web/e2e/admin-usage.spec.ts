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

/**
 * AEH-286: the model-usage report.
 *
 * Deliberately tolerant of an empty table. The suite does not run the pipeline,
 * so whether this DB has any ModelUsage rows depends on what else ran first —
 * asserting a dollar figure would make the spec pass or fail on test ordering.
 * What must hold either way is that every rollup renders, that the per-estimate
 * filter round-trips, and that spend stays behind the admin gate.
 */
test.describe('AEH-286: model usage report', () => {
  test('admin sees every rollup, and the filter round-trips', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    // Reachable from the nav, not just by URL.
    await page.getByTestId('nav-admin-usage').click();
    await expect(page).toHaveURL(/\/admin\/usage/);
    await expect(page.getByTestId('admin-usage')).toBeVisible();

    // Each rollup the ticket asks to be answerable has a surface.
    await expect(page.getByTestId('usage-by-agent')).toBeVisible();
    await expect(page.getByTestId('usage-by-estimate')).toBeVisible();
    await expect(page.getByTestId('usage-by-model')).toBeVisible();
    await expect(page.getByTestId('usage-by-day')).toBeVisible();

    // Per-run is scoped to a single estimate, so it is absent unfiltered.
    await expect(page.getByTestId('usage-by-run')).toHaveCount(0);

    // Filtering by estimate reveals it and offers a way back out.
    await page.goto('/admin/usage?estimateId=does-not-exist');
    await expect(page.getByTestId('admin-usage')).toBeVisible();
    await expect(page.getByText('Clear filter')).toBeVisible();
  });

  test('estimator cannot reach the usage report', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    await page.goto('/admin/usage');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('admin-usage')).toHaveCount(0);
  });
});
