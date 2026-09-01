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

const ADMIN_LINKS = [
  'nav-admin-users',
  'nav-admin-config',
  'nav-admin-presets',
  'nav-admin-prompts',
  'nav-admin-oracle',
  'nav-admin-usage',
  'nav-admin-mcp',
];

test.describe('WS21-01: role-aware app shell', () => {
  test('admin sees admin nav', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    // Shared links present for everyone.
    await expect(page.getByTestId('nav-estimates')).toBeVisible();
    // Admin-only links present for admin.
    for (const testid of ADMIN_LINKS) {
      await expect(page.getByTestId(testid)).toBeVisible();
    }
  });

  test('estimator does not see admin nav', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    // Shared links present.
    await expect(page.getByTestId('nav-estimates')).toBeVisible();
    // Admin-only links absent for estimator.
    for (const testid of ADMIN_LINKS) {
      await expect(page.getByTestId(testid)).toHaveCount(0);
    }
  });

  test('admin can open an admin page', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/admin\/users/);
    await expect(page.getByTestId('admin-users')).toBeVisible();
  });

  test('estimator is redirected away from admin pages', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);
    await page.goto('/admin/users');
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByTestId('admin-users')).toHaveCount(0);
  });
});
