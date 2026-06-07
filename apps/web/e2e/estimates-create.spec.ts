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

test.describe('WS22-01: create estimate from SOW', () => {
  test('submitting the form creates a DRAFT and navigates to its detail', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    await page.getByTestId('new-estimate').click();
    await expect(page).toHaveURL(/\/estimates\/new/);

    const title = `Created via E2E ${Date.now()}`;
    await page.fill('#title', title);
    await page.fill('#sowText', 'A statement of work entered through the create form.');
    await page.getByTestId('create-estimate-submit').click();

    // Lands on the new estimate's detail page.
    await expect(page).toHaveURL(/\/estimates\/[a-z0-9]+$/);
    await expect(page.getByTestId('estimate-detail')).toContainText(title);
    await expect(page.getByTestId('estimate-status')).toContainText('DRAFT');

    // And it shows up back on the dashboard list.
    await page.goto('/dashboard');
    await expect(page.getByTestId('estimates-table')).toContainText(title);
  });
});
