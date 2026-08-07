import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { PrismaClient } from '../../../packages/db/src/generated/client/index.js';
import { TEST_USERS } from './global-setup';

/**
 * Disabling an account must end a session that is ALREADY signed in, not merely
 * block the next login. With `session: { strategy: 'jwt' }` there is no session
 * table to revoke, so that only works because the DB-backed jwt callback
 * re-reads the user on every request — which is exactly the thing worth proving
 * in a browser rather than a unit test.
 *
 * Runs serially: the admin toggles state the second browser context observes.
 */
test.describe.configure({ mode: 'serial' });

const COLD_COMPILE = 30_000;
const TARGET = TEST_USERS.disableTarget;

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
}

async function loginExpectingSuccess(page: Page, email: string, password: string) {
  await login(page, email, password);
  await page.waitForURL(/\/dashboard/, { timeout: COLD_COMPILE });
  await expect(page.getByTestId('nav')).toBeVisible();
}

async function userId(email: string): Promise<string> {
  const db = new PrismaClient({
    datasources: { db: { url: process.env['TEST_DATABASE_URL']! } },
  });
  try {
    const u = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    return u.id;
  } finally {
    await db.$disconnect();
  }
}

test.describe('disable a user', () => {
  test('disabling ejects a user who is already signed in', async ({ browser, page }) => {
    const id = await userId(TARGET.email);

    // The target signs in and is working normally.
    const victimCtx: BrowserContext = await browser.newContext();
    const victim = await victimCtx.newPage();
    await loginExpectingSuccess(victim, TARGET.email, TARGET.password);

    // An admin disables them, in a different browser context.
    await loginExpectingSuccess(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');
    await page.getByTestId(`toggle-disabled-${id}`).click();
    await expect(page.getByTestId(`disabled-${id}`)).toBeVisible();

    // The victim's NEXT navigation drops them — no logout, no token expiry.
    await victim.goto('/dashboard');
    await expect(victim).toHaveURL(/\/login/, { timeout: COLD_COMPILE });

    await victimCtx.close();
  });

  test('a disabled user cannot sign back in', async ({ page }) => {
    await login(page, TARGET.email, TARGET.password);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId('nav')).toHaveCount(0);
  });

  test('re-enabling lets them sign in again', async ({ page, browser }) => {
    const id = await userId(TARGET.email);

    await loginExpectingSuccess(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');
    await page.getByTestId(`toggle-disabled-${id}`).click();
    await expect(page.getByTestId(`disabled-${id}`)).toHaveCount(0);

    const ctx = await browser.newContext();
    const restored = await ctx.newPage();
    await loginExpectingSuccess(restored, TARGET.email, TARGET.password);
    await ctx.close();
  });

  test('an admin cannot disable their own account', async ({ page }) => {
    await loginExpectingSuccess(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    const me = await userId(TEST_USERS.admin.email);
    await page.goto('/admin/users');
    // Disabling yourself would eject you on the very next request.
    await expect(page.getByTestId(`toggle-disabled-${me}`)).toBeDisabled();
  });
});

test.describe('reassign estimates', () => {
  test('an admin moves a user’s estimates to someone else', async ({ page }) => {
    const fromId = await userId(TEST_USERS.estimator.email);
    const toId = await userId(TEST_USERS.reassignTarget.email);

    await loginExpectingSuccess(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');

    const before = Number(
      (await page.getByTestId(`estimate-count-${fromId}`).textContent())?.trim() ?? '0',
    );
    expect(before).toBeGreaterThan(0);

    // Reassignment stands alone — no deletion involved.
    await page.getByTestId(`reassign-${fromId}`).click();
    await expect(page.getByTestId('reassign-form')).toBeVisible();
    await page.getByTestId('reassign-to').selectOption(toId);
    await page.getByTestId('reassign-submit').click();

    await expect(page.getByTestId(`estimate-count-${fromId}`)).toHaveText('0', {
      timeout: COLD_COMPILE,
    });
    await expect(page.getByTestId(`estimate-count-${toId}`)).toHaveText(String(before));

    // Put them back so the rest of the suite's fixtures still belong to
    // `estimator` — several specs assert on that ownership.
    await page.getByTestId(`reassign-${toId}`).click();
    await page.getByTestId('reassign-to').selectOption(fromId);
    await page.getByTestId('reassign-submit').click();
    await expect(page.getByTestId(`estimate-count-${fromId}`)).toHaveText(String(before), {
      timeout: COLD_COMPILE,
    });
  });

  test('a user who owns estimates cannot be deleted, and the reason says why', async ({ page }) => {
    const id = await userId(TEST_USERS.estimator.email);
    await loginExpectingSuccess(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/users');

    const del = page.getByTestId(`delete-user-${id}`);
    await expect(del).toBeDisabled();
    await expect(del).toHaveAttribute('title', /reassign them first|disable this account/);
  });
});
