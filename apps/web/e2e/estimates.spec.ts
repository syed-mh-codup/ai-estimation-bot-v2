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

test.describe('delete estimate is owner-or-admin only', () => {
  // The seeded estimate belongs to `estimator`.
  test('the owner sees the delete control on both list and detail', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);
    await expect(page.getByTestId(`delete-estimate-${SEED_ESTIMATE.id}`)).toBeAttached();

    await page.goto(`/estimates/${SEED_ESTIMATE.id}`);
    await expect(page.getByTestId('delete-estimate')).toBeVisible();
  });

  test('an admin sees it for an estimate they do not own', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await expect(page.getByTestId(`delete-estimate-${SEED_ESTIMATE.id}`)).toBeAttached();

    await page.goto(`/estimates/${SEED_ESTIMATE.id}`);
    await expect(page.getByTestId('delete-estimate')).toBeVisible();
  });

  test('a signed-in non-owner can open the estimate but gets no delete control', async ({
    page,
  }) => {
    await login(page, TEST_USERS.nonOwner.email, TEST_USERS.nonOwner.password);

    // They can still see and open it — the ledger is shared.
    await expect(page.getByTestId('estimates-table')).toContainText(SEED_ESTIMATE.title);
    await expect(page.getByTestId(`delete-estimate-${SEED_ESTIMATE.id}`)).toHaveCount(0);

    await page.goto(`/estimates/${SEED_ESTIMATE.id}`);
    await expect(page.getByTestId('estimate-detail')).toBeVisible();
    await expect(page.getByTestId('delete-estimate')).toHaveCount(0);
  });
});
