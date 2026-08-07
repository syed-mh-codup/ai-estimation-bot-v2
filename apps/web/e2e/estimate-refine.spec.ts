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
    // Triples the 60s budget. This one test drives the whole refinement flow —
    // toggle, edit, await a write, reload, export, finalise — against
    // /estimates/[id], the agents-heavy route whose cold first compile under
    // `next dev` can alone approach the default budget (see playwright.config).
    test.slow();

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
    // The editor auto-saves on blur — there is no Save button, and this spec
    // used to click a `save-item-*` testid that has never existed in src.
    //
    // The write must be awaited explicitly before reloading. The ledger applies
    // the change optimistically and persists in the background, so a reload
    // fired straight after blur races the server action and re-renders from a
    // row that hasn't been updated yet — the page then shows the OLD number
    // even though the write lands moments later.
    await devBaseInput.fill('100');
    await devBaseInput.blur();
    // Wait for EVERY pending write, not one matched response. A predicate on
    // "POST to this estimate" is not specific enough: the two toggles above are
    // also server actions posting to the same URL, and one of theirs can still
    // be in flight — so the wait resolves on the toggle and the reload races the
    // hours write after all. That failed only in the full suite, where the
    // toggles are slower, which is exactly how a race presents.
    await page.waitForLoadState('networkidle');

    // DEV is untaxed, so the taxed figure is exactly the base figure.
    await expect(devTaxedLabel).toContainText('100');

    // Now the reload is meaningful: it proves the number was written, not just
    // reflected in the client ledger. (There is no change-log view — this spec
    // used to assert a `change-log` testid that src has never had.)
    await page.reload();
    await expect(page.getByTestId('estimate-detail')).toBeVisible();
    await expect(page.locator(`[data-testid^="base-DEV-${MI2}-"]`)).toHaveValue('100');

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
