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

function rowFor(page: Page, email: string) {
  return page.locator('tr[data-testid^="user-row-"]').filter({ hasText: email });
}

test.describe('WS24-01: users admin — list + set role', () => {
  test('admin changes a user role and it takes effect on the list', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');
    await expect(page.getByTestId('users-table')).toBeVisible();

    // Operate on the dedicated throwaway user so shared fixtures stay intact.
    const row = rowFor(page, TEST_USERS.roleTarget.email);
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

  test('an admin cannot demote their own account (button disabled)', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');

    // The acting admin's own row has its demote action disabled.
    const ownRow = rowFor(page, TEST_USERS.admin.email);
    await expect(ownRow.getByTestId(/^set-role-/)).toBeDisabled();
  });

  test('role change invalidates the target session live (no re-login)', async ({ browser }) => {
    // Two isolated browser contexts: the target user and an admin.
    const targetCtx = await browser.newContext();
    const adminCtx = await browser.newContext();
    try {
      const targetPage = await targetCtx.newPage();
      const adminPage = await adminCtx.newPage();

      // Target logs in as an estimator — no admin nav.
      await login(
        targetPage,
        TEST_USERS.liveInvalidation.email,
        TEST_USERS.liveInvalidation.password,
      );
      await expect(targetPage.getByTestId('nav-admin-users')).toHaveCount(0);

      // Admin promotes the target to ADMIN.
      await login(adminPage, TEST_USERS.admin.email, TEST_USERS.admin.password);
      await adminPage.goto('/admin/users');
      await rowFor(adminPage, TEST_USERS.liveInvalidation.email)
        .getByTestId(/^set-role-/)
        .click();
      await expect(
        rowFor(adminPage, TEST_USERS.liveInvalidation.email).locator('[data-testid^="role-"]'),
      ).toHaveText('ADMIN');

      // Target merely reloads — no re-login — and now sees the admin nav,
      // because the jwt callback re-reads the role from the DB each request.
      await targetPage.reload();
      await expect(targetPage.getByTestId('nav-admin-users')).toBeVisible();
    } finally {
      await targetCtx.close();
      await adminCtx.close();
    }
  });
});
