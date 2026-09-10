import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS, COSTED_ESTIMATE } from './global-setup';

/**
 * AEH-236. Forking an estimate, through the real UI.
 *
 * The independence test at the bottom is the one that matters. Every other
 * assertion here would still pass if the fork shared rows with its parent
 * instead of copying them — a shared row renders identically to a copied one.
 * Only editing BOTH and checking neither moved proves they are separate
 * documents, which is the ticket's load-bearing requirement.
 */

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
}

/** Fork the costed estimate and return the new estimate's id. */
async function fork(page: Page, opts: { title: string; branch?: boolean; steer?: string }): Promise<string> {
  await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
  await page.getByTestId('open-fork').click();
  await expect(page.getByTestId('fork-dialog')).toBeVisible();

  const title = page.getByTestId('fork-title');
  await title.fill(opts.title);
  if (opts.branch) await page.getByTestId('fork-kind-branch').click();
  if (opts.steer) await page.getByTestId('fork-steer').fill(opts.steer);

  await page.getByTestId('submit-fork').click();
  // No documents attached, so the fork is immediate — no ingest to wait on.
  await page.waitForURL(/\/estimates\/(?!e2e-costed-estimate)[^/]+$/, { timeout: 30_000 });
  const id = new URL(page.url()).pathname.split('/').pop()!;
  expect(id).not.toBe(COSTED_ESTIMATE.id);
  return id;
}

test.describe('AEH-236: forking an estimate', () => {
  test('a successor copies the ledger and says where it came from', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    const forkId = await fork(page, {
      title: 'Forked — September round',
      steer: 'Client dropped reporting and added a loyalty scheme.',
    });

    await expect(page.getByTestId('estimate-detail')).toBeVisible();
    await expect(page.getByTestId('estimate-title-input')).toHaveValue('Forked — September round');

    // Where it came from, and how.
    const from = page.getByTestId('forked-from');
    await expect(from).toBeVisible();
    await expect(from).toContainText('Successor to');
    await expect(from).toContainText(COSTED_ESTIMATE.title);

    // A copy of a costed estimate is not itself approved.
    await expect(page.getByTestId('estimate-detail')).toContainText('DRAFT');

    // The ledger came across, under ids of its own: the parent's card titles
    // are all here, and not one of the parent's card IDS is.
    await expect(page.getByTestId('menu-card').first()).toBeVisible();
    await expect(page.getByTestId('estimate-not-run')).toHaveCount(0);
    for (const parentItemId of COSTED_ESTIMATE.itemIds) {
      await expect(page.getByTestId(`item-title-${parentItemId}`)).toHaveCount(0);
    }
    const forkCards = await page.getByTestId('menu-card').count();
    expect(forkCards).toBeGreaterThan(0);

    // The parent now says it has been forked — the half that stops somebody
    // quoting a round-1 number that round 2 has already moved — and still holds
    // the same number of cards, so this was a copy and not a move.
    await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
    expect(await page.getByTestId('menu-card').count()).toBe(forkCards);
    const forks = page.getByTestId('forks-of-this');
    await expect(forks).toBeVisible();
    await expect(forks).toContainText('Forked — September round');
    await expect(forks).toContainText('successor');
    await expect(page.getByTestId(`fork-child-${forkId}`)).toBeVisible();
  });

  test('a branch reads as a branch on both ends', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);

    const forkId = await fork(page, {
      title: 'Forked — WordPress route',
      branch: true,
      steer: 'Same scope, WordPress with plugins instead of a custom build.',
    });

    await expect(page.getByTestId('forked-from')).toContainText('Branch of');

    await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
    await expect(page.getByTestId(`fork-child-${forkId}`)).toContainText('branch');
  });

  test('the fork and its parent are separate documents', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);
    const forkId = await fork(page, { title: 'Forked — independence check' });

    // Read the parent's first DEV hour input, then change it ON THE FORK.
    await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
    const parentInput = page.locator('[data-testid^="base-DEV-"]').first();
    await expect(parentInput).toBeVisible();
    const parentBefore = await parentInput.inputValue();

    await page.goto(`/estimates/${forkId}`);
    const forkInput = page.locator('[data-testid^="base-DEV-"]').first();
    await expect(forkInput).toBeVisible();
    expect(await forkInput.inputValue()).toBe(parentBefore);

    const moved = String(Number(parentBefore) + 9);
    const write = page.waitForResponse((r) => r.request().method() === 'POST');
    await forkInput.fill(moved);
    await forkInput.blur();
    await write;

    // The hours input is UNCONTROLLED, so its value is fixed at render and a
    // retrying assertion would re-read the same stale DOM. Poll around a
    // reload instead — see estimate-refine.spec.ts, which learned this the
    // hard way; do not simplify it back to a bare expect.
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.locator('[data-testid^="base-DEV-"]').first().inputValue();
        },
        { timeout: 20_000 },
      )
      .toBe(moved);

    // The parent must not have budged.
    await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
    await expect
      .poll(
        async () => {
          await page.reload();
          return page.locator('[data-testid^="base-DEV-"]').first().inputValue();
        },
        { timeout: 20_000 },
      )
      .toBe(parentBefore);
  });
});
