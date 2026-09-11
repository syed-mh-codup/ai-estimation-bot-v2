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
 * AEH-286: the model-usage report, as reshaped by AEH-313.
 *
 * Deliberately tolerant of an empty table. The suite does not run the pipeline,
 * so whether this DB has any ModelUsage rows depends on what else ran first —
 * asserting a dollar figure would make the spec pass or fail on test ordering.
 * What must hold either way is that every rollup renders, that filtering is
 * visible and says what it filtered to, that sorting round-trips through the
 * URL, and that spend stays behind the admin gate.
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

    // AEH-313: per-run is present unfiltered too. It used to appear only once
    // you filtered, which made the page change shape underneath you with
    // nothing on screen saying so.
    await expect(page.getByTestId('usage-by-run')).toBeVisible();

    // AEH-313: filtering is a control you can see, not something you discover
    // by clicking a cell that looks like a link.
    await expect(page.getByTestId('report-controls')).toBeVisible();
    await expect(page.getByTestId('filter-kind')).toBeVisible();
    await expect(page.getByTestId('filter-model')).toBeVisible();
    await expect(page.getByTestId('filter-from')).toBeVisible();
    // The scope line states what the numbers cover, so a filtered view can
    // never be read as the whole bill.
    await expect(page.getByTestId('report-scope')).toBeVisible();
    // And the trend has a home, whether or not there are enough days to draw.
    await expect(page.getByRole('heading', { name: /^Trend/ })).toBeVisible();

    // AEH-313: sorting exists, and it lives in the URL rather than in a click
    // handler — so it is shareable and survives a reload.
    await page.goto('/admin/usage?sortAgent=calls.asc');
    await expect(page.getByTestId('admin-usage')).toBeVisible();
    await expect(page.getByTestId('usage-by-agent')).toBeVisible();

    // AEH-313: a filtered view NAMES what it is filtered to and can release
    // that one dimension. This replaces a 12.5px "Clear filter" that named
    // nothing and dropped everything at once.
    await page.goto('/admin/usage?estimateId=does-not-exist');
    await expect(page.getByTestId('admin-usage')).toBeVisible();
    await expect(page.getByLabel('Remove the estimate filter')).toBeVisible();
    // Nothing matches that id, and an empty filtered view says so rather than
    // rendering five empty tables.
    await expect(page.getByTestId('usage-empty')).toBeVisible();
  });

  test('estimator cannot reach the usage report', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    await page.goto('/admin/usage');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('admin-usage')).toHaveCount(0);
  });
});
