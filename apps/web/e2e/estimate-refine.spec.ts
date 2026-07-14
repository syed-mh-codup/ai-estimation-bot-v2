import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS, COSTED_ESTIMATE } from './global-setup';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

const [MI1, MI2] = COSTED_ESTIMATE.itemIds;

test.describe('WS23: Menu Card refinement', () => {
  test('view, toggle, edit hours, export, finalise', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);
    await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
    await expect(page.getByTestId('estimate-detail')).toBeVisible();

    const totalAll = page.getByTestId('total-all');
    // 2 items × (DEV30+QA12+PM6+BA6 = 54) = 108.
    await expect(totalAll).toContainText('108');

    // WS23-02: disable item 1 → totals recompute to 54.
    await page.getByTestId(`toggle-item-${MI1}`).click();
    await expect(totalAll).toContainText('54');
    // Re-enable.
    await page.getByTestId(`toggle-item-${MI1}`).click();
    await expect(totalAll).toContainText('108');

    // WS23-03: edit item 2 DEV base hours 30 → 100. DEV is untaxed, so taxed DEV
    // is exactly 100 regardless of the active config's tax %s (which other specs
    // in the suite mutate) — a config-independent assertion.
    // Selector is a prefix match: a role can hold several atomic line items
    // (FOUR-HOUR RULE), so the full testid includes the line item's own id
    // (`base-DEV-${MI2}-${lineItemId}`) — the seed fixture has exactly one
    // DEV line item per card, so the prefix uniquely matches it.
    const devBaseInput = page.locator(`[data-testid^="base-DEV-${MI2}-"]`);
    const devTaxedLabel = page.locator(`[data-testid^="taxed-DEV-${MI2}-"]`);
    await devBaseInput.fill('100');
    await page.getByTestId(`save-item-${MI2}`).click();
    await expect(devTaxedLabel).toContainText('100');
    // WS23-04: change log appears once an item is edited.
    await expect(page.getByTestId('change-log')).toBeVisible();
    // Edit persists across reload.
    await page.reload();
    await expect(devBaseInput).toHaveValue('100');

    // WS23-05: export to Sheets (stub) → link appears.
    await page.getByTestId('export-sheets').click();
    await expect(page.getByTestId('sheet-link')).toBeVisible();

    // WS23-06: finalise → status FINALISED, finalise control removed.
    await page.waitForLoadState('networkidle');
    await page.getByTestId('finalise-estimate').click();
    await expect(page.getByTestId('estimate-status')).toHaveText('FINALISED', { timeout: 15000 });
    await expect(page.getByTestId('finalise-estimate')).toHaveCount(0);
  });
});
