import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS } from './global-setup';

/**
 * The sign-out confirmation is ours, not next-auth's built-in page. Two things
 * to hold: it stays inside the app's design language (asserted via the
 * wordmark + our testids, which the built-in page has none of), and "Stay
 * signed in" genuinely keeps the session — the built-in page offered no way
 * back at all.
 */

const USER = TEST_USERS.admin;

/** /signout's first compile under `next dev` can outlast an assertion default. */
const COLD_COMPILE = 30_000;

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

test.describe('sign out', () => {
  test('the built-in next-auth page is replaced by ours, naming the account', async ({ page }) => {
    await login(page, USER.email, USER.password);

    // Anything that GETs the next-auth endpoint must land on our page.
    await page.goto('/api/auth/signout');
    await page.waitForURL(/\/signout/, { timeout: COLD_COMPILE });

    await expect(page.getByTestId('signout-email')).toHaveText(USER.email);
    await expect(page.getByTestId('confirm-signout')).toBeVisible();
    await expect(page.getByTestId('cancel-signout')).toBeVisible();
    // The app's own wordmark — the built-in page renders none of this.
    await expect(page.getByRole('heading', { name: 'AI Estimation' })).toBeVisible();
  });

  test('"Stay signed in" returns to the dashboard with the session intact', async ({ page }) => {
    await login(page, USER.email, USER.password);
    await page.goto('/signout');

    await page.getByTestId('cancel-signout').click();
    await page.waitForURL(/\/dashboard/, { timeout: COLD_COMPILE });
    await expect(page.getByTestId('nav')).toBeVisible();
    await expect(page.getByTestId('estimates-table')).toBeVisible();
  });

  test('"Sign out" ends the session and protected routes stop resolving', async ({ page }) => {
    await login(page, USER.email, USER.password);
    await page.goto('/signout');

    await page.getByTestId('confirm-signout').click();
    await page.waitForURL(/\/login/, { timeout: COLD_COMPILE });

    // Really signed out, not just redirected once.
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login/);
  });

  test('signed-out visitors are sent to login rather than shown the page', async ({ page }) => {
    await page.goto('/signout');
    await expect(page).toHaveURL(/\/login/);
  });
});
