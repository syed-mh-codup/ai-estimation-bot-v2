import { test, expect, type Page } from '@playwright/test';
import { TEST_USERS, SEED_ESTIMATE, COSTED_ESTIMATE } from './global-setup';

/**
 * Oracle end to end — AEH-259.
 *
 * The model is stubbed (OPENROUTER_STUB, set in playwright.config), but the
 * stub quotes the estimate it was actually handed rather than a canned string,
 * so the citation and quote-jump assertions below exercise real matching. A
 * fixture that could pass with the matcher broken would be worth very little.
 */

/** `next dev`'s first compile of a heavy route outlasts the 5s expect budget. */
const COLD_COMPILE = 30_000;

const QUESTION = 'What does the source material say?';

async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId('nav')).toBeVisible();
}

async function openEstimate(page: Page) {
  await page.goto(`/estimates/${SEED_ESTIMATE.id}`);
  // /estimates/[id] is the heaviest route in the app; the first spec to reach
  // it pays the cold compile.
  await expect(page.getByTestId('estimate-detail')).toBeVisible({ timeout: COLD_COMPILE });
}

/** Opens Oracle with the keyboard shortcut, which is also the accessible path. */
async function openOracle(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('oracle-panel')).toBeVisible();
}

async function ask(page: Page, question: string) {
  await page.getByTestId('oracle-input').fill(question);
  await page.getByTestId('oracle-send').click();
  await expect(page.getByTestId('oracle-answer').first()).toBeVisible({ timeout: COLD_COMPILE });
}

test.describe('asking Oracle about an estimate', () => {
  test.slow();

  test('answers, cites the source, and survives a reload', async ({ page }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);
    await openEstimate(page);

    // The resting state is a notch, not a button sitting over the page.
    await expect(page.getByTestId('oracle-notch')).toBeVisible();
    await openOracle(page);

    await ask(page, QUESTION);

    // A quotation the checker verified against the live corpus, not just text
    // the model wrapped in markers.
    const quote = page.getByTestId('oracle-quote').first();
    await expect(quote).toBeVisible();
    await expect(page.getByTestId('oracle-quote-fabricated')).toHaveCount(0);

    // Activating it gets the panel out of the way and reveals the span.
    await quote.click();
    await expect(page.getByTestId('oracle-panel')).toBeHidden();
    await expect(page.getByTestId('sow-highlight')).toBeVisible();

    // Persisted, not just in component state.
    await page.reload();
    await expect(page.getByTestId('estimate-detail')).toBeVisible({ timeout: COLD_COMPILE });
    await openOracle(page);
    await expect(page.getByTestId('oracle-answer').first()).toBeVisible();
    await expect(page.getByTestId('oracle-panel')).toContainText(QUESTION);
  });

  test('a signed-in stranger cannot see the thread', async ({ page }) => {
    // The estimate itself is a shared workspace — they can open it. The
    // conversation is not.
    await login(page, TEST_USERS.nonOwner.email, TEST_USERS.nonOwner.password);
    await openEstimate(page);
    await openOracle(page);

    await expect(page.getByTestId('oracle-panel')).not.toContainText(QUESTION);
    await expect(page.getByTestId('oracle-answer')).toHaveCount(0);
  });
});

test.describe('Oracle is available whatever state the estimate is in', () => {
  test.slow();

  // The ticket lists DRAFT, REVIEW and FINALISED. Everything above runs against
  // SEED_ESTIMATE, which is DRAFT. COSTED_ESTIMATE carries a menu card and has
  // been through the refine spec by the time this runs, so it covers a costed
  // estimate — and its status is asserted rather than assumed, because that
  // spec finalises it and spec order is what decides which of the two states
  // this lands on.
  test('opens on a costed estimate, and the card affordance survives finalising', async ({
    page,
  }) => {
    await login(page, TEST_USERS.estimator.email, TEST_USERS.estimator.password);
    await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
    await expect(page.getByTestId('estimate-detail')).toBeVisible({ timeout: COLD_COMPILE });

    const status = await page.getByTestId('estimate-status').textContent();
    expect(['REVIEW', 'FINALISED']).toContain((status ?? '').trim());

    await openOracle(page);
    await expect(page.getByTestId('oracle-input')).toBeEnabled();
    await page.getByTestId('oracle-close').click();

    // "Ask about this card" must NOT be gated on !isFinalised — asking what
    // drove a number is exactly what you do once an estimate is signed off.
    const ask = page.getByTestId(`ask-oracle-item-${COSTED_ESTIMATE.itemIds[0]}`);
    await expect(ask).toHaveCount(1);
    await ask.click({ force: true });
    await expect(page.getByTestId('oracle-panel')).toBeVisible();
    await expect(page.getByTestId('oracle-input')).not.toHaveValue('');
  });
});

test.describe('an admin can read a thread but never post into one', () => {
  test.slow();

  test('reads it from the admin surface, with no way to reply', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);

    await page.goto('/admin/oracle');
    await expect(page.getByTestId('admin-oracle')).toBeVisible({ timeout: COLD_COMPILE });

    const row = page.getByTestId('oracle-threads-table').getByRole('link', { name: QUESTION });
    await expect(row).toBeVisible();
    await row.click();

    await expect(page.getByTestId('admin-oracle-thread')).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByTestId('admin-oracle-thread')).toContainText(QUESTION);

    // The rule the whole feature rests on: reading is not posting.
    await expect(page.getByTestId('oracle-input')).toHaveCount(0);
    await expect(page.getByTestId('oracle-send')).toHaveCount(0);
  });

  // Two tests rather than one, because each `page` fixture is a fresh context:
  // signing a second user in on the same one would hit /login while already
  // authenticated.
  test('sees the estimate’s threads in the rail', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await openEstimate(page);
    await expect(page.getByTestId('oracle-admin-panel')).toBeVisible();
  });

  test('an estimator gets no such panel', async ({ page }) => {
    await login(page, TEST_USERS.nonOwner.email, TEST_USERS.nonOwner.password);
    await openEstimate(page);
    await expect(page.getByTestId('oracle-admin-panel')).toHaveCount(0);
  });
});

test.describe('the agent catalogue on /admin/prompts', () => {
  test.slow();

  test('groups agents by track and puts Oracle under Supplemental', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/prompts');
    await expect(page.getByTestId('admin-prompts')).toBeVisible({ timeout: COLD_COMPILE });

    await expect(page.getByTestId('agent-track-RUN_CREW')).toContainText('Librarian');
    await expect(page.getByTestId('agent-pipeline')).toBeVisible();
    await expect(page.getByTestId('agent-track-SUPPLEMENTAL')).toContainText('Oracle');
    // The honest label: editing this one changes nothing until AEH-283.
    await expect(page.getByTestId('agent-track-REFERENCE')).toContainText('Supervisor');
  });

  test('picks a model from the dropdown and bumps the version', async ({ page }) => {
    await login(page, TEST_USERS.admin.email, TEST_USERS.admin.password);
    await page.goto('/admin/prompts/ORACLE');
    await expect(page.getByTestId('admin-prompt-editor')).toBeVisible({ timeout: COLD_COMPILE });

    // Says what a save will actually affect.
    await expect(page.getByTestId('prompt-impact')).toContainText('cannot change any estimate');

    await expect(page.getByTestId('prompt-active-version')).toHaveText('v1', {
      timeout: COLD_COMPILE,
    });

    await page.getByTestId('model-combobox-trigger').click();
    await page.getByTestId('model-combobox-search').fill('gemini');
    await page.getByTestId('combobox-option-google/gemini-2.5-pro').click();

    await page.getByTestId('prompt-change-reason').fill('e2e: switched model from the dropdown');
    await page.getByRole('button', { name: /save/i }).click();

    await expect(page.getByTestId('prompt-active-version')).toHaveText('v2', {
      timeout: COLD_COMPILE,
    });
    await expect(page.getByTestId('admin-prompt-editor')).toContainText('google/gemini-2.5-pro');
  });
});
