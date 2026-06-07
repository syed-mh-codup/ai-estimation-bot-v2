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

test.describe('WS24-05: prompts admin — edit creates a new active version', () => {
  test('admin edits a prompt and a new version becomes active with history', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    await page.goto('/admin/prompts');
    await expect(page.getByTestId('prompts-table')).toBeVisible();

    // Open the LIBRARIAN prompt editor.
    await page.getByTestId('prompt-link-LIBRARIAN').click();
    await expect(page).toHaveURL(/\/admin\/prompts\/LIBRARIAN/);
    await expect(page.getByTestId('admin-prompt-editor')).toBeVisible();

    const versionBadge = page.getByTestId('prompt-active-version');
    const before = (await versionBadge.textContent()) ?? 'v0';
    const beforeNum = Number(before.replace(/[^0-9]/g, ''));

    // Edit the body and save → new active version.
    const newBody = `Edited librarian prompt ${Date.now()}`;
    await page.fill('#body', newBody);
    await page.getByTestId('save-prompt').click();

    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
    await expect(page.locator('#body')).toHaveValue(newBody);

    // History shows the new active version and retains the previous one.
    await expect(page.getByTestId(`prompt-version-${beforeNum + 1}`)).toContainText('active');
    await expect(page.getByTestId(`prompt-version-${beforeNum}`)).toContainText('inactive');

    // Durable across reload.
    await page.reload();
    await expect(versionBadge).toHaveText(`v${beforeNum + 1}`);
    await expect(page.locator('#body')).toHaveValue(newBody);
  });
});
