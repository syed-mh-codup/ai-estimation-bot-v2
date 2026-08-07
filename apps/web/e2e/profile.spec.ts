import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS, PROFILE_NEW_PASSWORD } from './global-setup';

/**
 * Every one of these acts on `TEST_USERS.profile`, a user no other spec signs
 * in as. Specs run in parallel, so changing a shared user's credentials
 * mid-run would break whichever spec happened to be logging in at the time.
 *
 * Order matters — the last test invalidates the password the others sign in
 * with — and Playwright already gives it: `fullyParallel: false` runs a file's
 * tests sequentially in declaration order. Deliberately NOT `mode: 'serial'`,
 * which would also skip every later test when an early one fails, turning a
 * single slow cold-compile into four phantom failures.
 */

const USER = TEST_USERS.profile;

/**
 * /profile's first compile under `next dev` can take well over the 5s default
 * an assertion allows (see playwright.config's note on cold compile). The
 * 60s per-test budget covers it; the individual wait has to be told.
 */
const COLD_COMPILE = 30_000;

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

test.describe('profile: see your own name, change your own password', () => {
  test('the nav links to the account page and shows the current name', async ({ page }) => {
    await login(page, USER.email, USER.password);

    // global-setup seeds `name` to the email address.
    await expect(page.getByTestId('nav-user-name')).toHaveText(USER.email);

    await page.getByTestId('nav-profile').click();
    await page.waitForURL(/\/profile/, { timeout: COLD_COMPILE });
    await expect(page.getByTestId('profile-email')).toHaveText(USER.email);
  });

  test('renaming yourself updates the nav without signing out', async ({ page }) => {
    await login(page, USER.email, USER.password);
    await page.goto('/profile');

    await page.getByTestId('profile-name-input').fill('Renamed Person');
    await page.getByTestId('profile-name-save').click();
    await expect(page.getByTestId('profile-name-saved')).toBeVisible();

    // The DB-backed jwt callback re-reads the user each request, so this lands
    // on the next navigation rather than requiring a fresh login.
    await page.goto('/dashboard');
    await expect(page.getByTestId('nav-user-name')).toHaveText('Renamed Person');
  });

  test('a wrong current password is refused and changes nothing', async ({ page }) => {
    await login(page, USER.email, USER.password);
    await page.goto('/profile');

    await page.getByTestId('current-password').fill('definitely-not-the-password');
    await page.getByTestId('new-password').fill(PROFILE_NEW_PASSWORD);
    await page.getByTestId('confirm-password').fill(PROFILE_NEW_PASSWORD);
    await page.getByTestId('change-password-submit').click();

    await expect(page.getByTestId('password-error')).toContainText('current password');
    await expect(page.getByTestId('password-changed')).toHaveCount(0);
  });

  test('mismatched confirmation is refused', async ({ page }) => {
    await login(page, USER.email, USER.password);
    await page.goto('/profile');

    await page.getByTestId('current-password').fill(USER.password);
    await page.getByTestId('new-password').fill(PROFILE_NEW_PASSWORD);
    await page.getByTestId('confirm-password').fill('something-else-entirely');
    await page.getByTestId('change-password-submit').click();

    await expect(page.getByTestId('password-error')).toContainText('match');
  });

  // Runs last in the serial block: it invalidates the password above.
  test('changing your password actually changes the credential you sign in with', async ({
    page,
  }) => {
    await login(page, USER.email, USER.password);
    await page.goto('/profile');

    await page.getByTestId('current-password').fill(USER.password);
    await page.getByTestId('new-password').fill(PROFILE_NEW_PASSWORD);
    await page.getByTestId('confirm-password').fill(PROFILE_NEW_PASSWORD);
    await page.getByTestId('change-password-submit').click();
    await expect(page.getByTestId('password-changed')).toBeVisible();

    await page.getByTestId('nav-signout').click();
    await page.waitForURL(/\/login/);

    // The old password must no longer work…
    await page.fill('#email', USER.email);
    await page.fill('#password', USER.password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('nav')).toHaveCount(0);

    // …and the new one must.
    await login(page, USER.email, PROFILE_NEW_PASSWORD);
    await expect(page.getByTestId('nav')).toBeVisible();
  });
});
