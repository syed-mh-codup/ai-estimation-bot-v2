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

test.describe('WS24-01: users admin — list + set role', () => {
  test('admin changes a user role and it takes effect on the list', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');
    await expect(page.getByTestId('users-table')).toBeVisible();

    // Operate on the dedicated throwaway user so shared fixtures stay intact.
    const row = page
      .locator('tr[data-testid^="user-row-"]')
      .filter({ hasText: TEST_USERS.roleTarget.email });
    const roleBadge = row.locator('[data-testid^="role-"]');

    // Starts as ESTIMATOR (reset by global-setup each run).
    await expect(roleBadge).toHaveText('ESTIMATOR');

    // Promote to ADMIN; revalidatePath re-renders the list with the new value.
    await row.getByTestId(/^set-role-/).click();
    await expect(roleBadge).toHaveText('ADMIN');

    // And the change is durable across a fresh load.
    await page.reload();
    await expect(roleBadge).toHaveText('ADMIN');
  });
});
