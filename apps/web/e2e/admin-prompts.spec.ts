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

test.describe('WS24-05: prompts admin — edit creates a new active version', () => {
  test('admin edits a prompt and a new version becomes active with history', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    await page.goto('/admin/prompts');
    // One table per agent track since AEH-259, so the page container is the
    // stable handle rather than a single table.
    await expect(page.getByTestId('admin-prompts')).toBeVisible();

    // Open the LIBRARIAN prompt editor.
    await page.getByTestId('prompt-link-LIBRARIAN').click();
    // These routes' cold first compile under `next dev` can outlast the 5s an
    // assertion allows by default (playwright.config's 60s per-test budget
    // covers it, but the individual wait has to be told).
    await page.waitForURL(/\/admin\/prompts\/LIBRARIAN/, { timeout: COLD_COMPILE });
    await expect(page.getByTestId('admin-prompt-editor')).toBeVisible();

    const versionBadge = page.getByTestId('prompt-active-version');
    const before = (await versionBadge.textContent()) ?? 'v0';
    const beforeNum = Number(before.replace(/[^0-9]/g, ''));

    // Edit the body and save → new active version.
    const newBody = `Edited librarian prompt ${Date.now()}`;
    await page.fill('#body', newBody);
    // A change reason is required — a prompt edit moves every estimate's numbers,
    // so the record has to say why.
    await page.fill('#changeReason', 'e2e: exercising the versioned save path');
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

test.describe('View a prompt version\'s details and activate an older one', () => {
  test('admin views v1 details and reactivates it, making it the active version again', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    await page.goto('/admin/prompts/LIBRARIAN');
    await expect(page.getByTestId('admin-prompt-editor')).toBeVisible();

    const versionBadge = page.getByTestId('prompt-active-version');
    const activeBefore = Number(((await versionBadge.textContent()) ?? 'v0').replace(/[^0-9]/g, ''));

    // Open the detail view for v1 (guaranteed to exist and, once activeBefore > 1, inactive).
    await page.getByTestId('prompt-version-link-1').click();
    await page.waitForURL(/\/admin\/prompts\/LIBRARIAN\/1$/, { timeout: COLD_COMPILE });
    await expect(page.getByTestId('admin-prompt-version-detail')).toBeVisible();
    await expect(page.getByTestId('version-body')).not.toHaveValue('');
    await expect(page.getByTestId('version-model')).not.toBeEmpty();

    if (activeBefore === 1) {
      // v1 is already active — nothing to activate, detail view has no button.
      await expect(page.getByTestId('activate-version')).toHaveCount(0);
      return;
    }

    await expect(page.getByTestId('version-status')).toHaveText('inactive');
    await page.getByTestId('activate-version').click();

    // Activating redirects back to the editor with v1 now active.
    await page.waitForURL(/\/admin\/prompts\/LIBRARIAN$/, { timeout: COLD_COMPILE });
    await expect(versionBadge).toHaveText('v1');
    await expect(page.getByTestId('prompt-version-1')).toContainText('active');
    await expect(page.getByTestId(`prompt-version-${activeBefore}`)).toContainText('inactive');

    // Durable across reload.
    await page.reload();
    await expect(versionBadge).toHaveText('v1');
  });
});
