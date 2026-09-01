import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS } from './global-setup';

/** Budget for a route's first compile under `next dev`. */
const COLD_COMPILE = 30_000;

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

test.describe('WS22-01: create estimate from SOW', () => {
  test('submitting the form creates a DRAFT and navigates to its detail', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    await page.getByTestId('new-estimate').click();
    await expect(page).toHaveURL(/\/estimates\/new/);

    const title = `Created via E2E ${Date.now()}`;
    await page.fill('#title', title);
    await page.fill('#sowText', 'A statement of work entered through the create form.');
    await page.getByTestId('create-estimate-submit').click();

    // Lands on the new estimate's detail page. `(?!new$)` matters: the old
    // pattern /estimates/[a-z0-9]+$/ also matches /estimates/**new**, so it
    // passed while still sitting on the form and the failure surfaced a line
    // later. /estimates/[id] is agents-heavy and its cold first compile under
    // `next dev` runs well past the 5s an assertion allows by default.
    await page.waitForURL(/\/estimates\/(?!new$)[a-z0-9]+$/, { timeout: COLD_COMPILE });
    await expect(page.getByTestId('estimate-detail')).toBeVisible({ timeout: COLD_COMPILE });
    // Title is an <input>; toContainText would never see its value.
    await expect(page.getByTestId('estimate-title-input')).toHaveValue(title);
    await expect(page.getByTestId('estimate-status')).toContainText('DRAFT');

    // And it shows up back on the dashboard list.
    await page.goto('/dashboard');
    await expect(page.getByTestId('estimates-table')).toContainText(title);
  });
});
