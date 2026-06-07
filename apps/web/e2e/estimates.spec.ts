import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS, SEED_ESTIMATE } from './global-setup';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

test.describe('WS21-02: dashboard list + estimate detail', () => {
  test('dashboard lists the seeded estimate with status and owner', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    const table = page.getByTestId('estimates-table');
    await expect(table).toBeVisible();
    await expect(table).toContainText(SEED_ESTIMATE.title);
    await expect(table).toContainText('DRAFT');
    await expect(table).toContainText(TEST_USERS.estimator.email);
  });

  test('clicking an estimate opens its detail page', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    await page.getByTestId(`estimate-row-${SEED_ESTIMATE.id}`).click();
    await expect(page).toHaveURL(new RegExp(`/estimates/${SEED_ESTIMATE.id}`));
    await expect(page.getByTestId('estimate-detail')).toBeVisible();
    await expect(page.getByTestId('estimate-detail')).toContainText(SEED_ESTIMATE.title);
    await expect(page.getByTestId('estimate-detail')).toContainText(SEED_ESTIMATE.sowText);
  });
});
