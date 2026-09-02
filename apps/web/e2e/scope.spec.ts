import { expect, test, type Page } from '@playwright/test';

import { COSTED_ESTIMATE, TEST_USERS } from './global-setup';

/**
 * The scope configurator, end to end — AEH-235.
 *
 * This drives the whole slice in one pass, deliberately: author a dependency on
 * the estimate, then watch the cascade act on it. Seeding the edge directly in
 * global-setup would test the configurator against a graph the app never
 * produced, and the authoring half is exactly where a wrong id or a bad
 * candidate filter would hide.
 *
 * Note what is NOT set up here: neither seeded card has a `sourcePresetId`, and
 * the test preset library is irrelevant to all of it. The graph belongs to the
 * estimate. If a regression made the configurator depend on preset matches,
 * every assertion below would fail — which is the point, since 128 of the 140
 * cards in the live database have no preset behind them.
 */

/** `next dev`'s first compile of a route outlasts the default expect budget. */
const COLD_COMPILE = 30_000;

const [FIRST, SECOND] = COSTED_ESTIMATE.itemIds;

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#email', TEST_USERS.estimator.email);
  await page.fill('#password', TEST_USERS.estimator.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard/);
}

/**
 * Wait for the in-flight save to land.
 *
 * The count assertions pass the moment React re-renders, while the write behind
 * them is still in flight — and a `page.reload()` at that point aborts it. The
 * toggles are disabled for exactly the duration of the write (the configurator
 * serialises them on purpose), so their coming back is the signal, and it is a
 * real user-visible one rather than a sleep.
 */
async function saveSettled(page: Page, cardId: string) {
  await expect(page.getByTestId(`scope-toggle-${cardId}`)).toBeEnabled({ timeout: COLD_COMPILE });
}

/** How many modules the summary currently reports. */
async function moduleCount(page: Page): Promise<number> {
  const text = (await page.getByTestId('scope-modules').textContent()) ?? '';
  return Number(text.trim().split(' ')[0]);
}

async function openScope(page: Page) {
  await page.goto(`/estimates/${COSTED_ESTIMATE.id}/scope`);
  await expect(page.getByTestId('scope-graph-toggle')).toBeVisible({ timeout: COLD_COMPILE });
}

/**
 * Make SECOND depend on FIRST, unless it already does.
 *
 * Specs share one database and run serially, so the graph authored by an
 * earlier test is still there. Re-authoring is not merely redundant, it is
 * impossible: with the edge in place, FIRST is no longer a legal candidate for
 * SECOND, so the picker correctly stops offering it and the select disappears.
 * That is the candidate rule working, not a bug — so this checks first.
 */
async function ensureDependency(page: Page) {
  const alreadyAuthored = await page.getByTestId('scope-totals').isVisible();
  if (alreadyAuthored) return;

  await page.getByTestId('scope-graph-toggle').click();
  await expect(page.getByTestId('scope-graph-editor')).toBeVisible();

  // The candidate list is the shared legality rule, so choosing FIRST here is
  // only possible if the server would also accept it.
  await page.getByTestId(`scope-edit-add-${SECOND}`).selectOption(FIRST!);
  await page.getByTestId('scope-graph-save').click();
  await expect(page.getByTestId('scope-graph-message')).toContainText('Saved 1 dependency', {
    timeout: COLD_COMPILE,
  });
}

test.describe('scope configurator', () => {
  test.slow();

  test('authors a dependency, then cascades on it', async ({ page }) => {
    await login(page);
    await openScope(page);

    await ensureDependency(page);

    // With a graph, the configurator itself appears.
    await expect(page.getByTestId('scope-totals')).toBeVisible({ timeout: COLD_COMPILE });
    const hoursBefore = await page.getByTestId('scope-hours').textContent();
    await expect(page.getByTestId('scope-modules')).toContainText('2 modules of 2');

    // Switching off the prerequisite must take its dependent with it, and say so
    // by name rather than silently. The reference artifact removes dependents
    // with no warning at all; that was the one behaviour we deliberately changed.
    await page.getByTestId(`scope-toggle-${FIRST}`).click();
    await expect(page.getByTestId('scope-notice')).toBeVisible();
    await expect(page.getByTestId('scope-notice')).toContainText('went with it');
    await expect(page.getByTestId('scope-modules')).toContainText('0 modules of 2');

    // Excluded work is still priced — it just does not count.
    await expect(page.getByTestId('scope-excluded')).toBeVisible();

    // Undo is the same snapshot mechanism as revert-on-failure, so this also
    // exercises the path a failed save takes.
    await page.getByTestId('scope-undo').click();
    await expect(page.getByTestId('scope-modules')).toContainText('2 modules of 2');
    await expect(page.getByTestId('scope-hours')).toHaveText(hoursBefore ?? '');

    // Reload before finishing, and not out of caution: it upgrades the claim
    // from "the UI updated" to "the undo persisted", and it stops the next spec
    // reading whichever pick set happened to land.
    await saveSettled(page, FIRST!);
    await page.reload();
    await expect(page.getByTestId('scope-modules')).toContainText('2 modules of 2', {
      timeout: COLD_COMPILE,
    });
  });

  test('a configured scope survives a reload, and never touches the estimate', async ({ page }) => {
    await login(page);
    await openScope(page);
    await ensureDependency(page);
    await expect(page.getByTestId('scope-totals')).toBeVisible({ timeout: COLD_COMPILE });

    // Relative, not absolute: this spec must not depend on the pick set another
    // test left behind. Switching off the DEPENDENT drops it alone, because
    // nothing needs it — the asymmetry with the previous test is the point.
    const before = await moduleCount(page);
    await page.getByTestId(`scope-toggle-${SECOND}`).click();
    await expect(page.getByTestId('scope-notice')).toBeVisible();
    await expect(page.getByTestId('scope-modules')).toContainText(`${before - 1} module`);

    await saveSettled(page, SECOND!);
    await page.reload();
    await expect(page.getByTestId('scope-modules')).toContainText(`${before - 1} module`, {
      timeout: COLD_COMPILE,
    });

    // The estimate is untouched. This is the load-bearing claim of the whole
    // feature: a scenario is a planning artifact with no write path to
    // MenuItem.enabled, so switching a module off above must not exclude the
    // card here.
    //
    // Asserted through the rollup's excluded-hours block rather than the row's
    // toggle. The toggle is not a reliable probe: `estimate-refine.spec.ts`
    // runs before this file and FINALISES this estimate, and MenuCardEditor
    // hides the whole hover cluster once finalised — so the toggle is simply
    // absent, which reads as a failure rather than as "the card is on". The
    // rollup block renders whenever any card is off, whatever the status.
    await page.goto(`/estimates/${COSTED_ESTIMATE.id}`);
    await expect(page.getByTestId('estimate-detail')).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByTestId('rollup-totals')).toBeVisible();
    await expect(page.getByTestId('rollup-excluded')).toBeHidden();
  });
});

/**
 * Deliberately last in the file.
 *
 * Playwright runs describes in declaration order, these specs share one
 * estimate, and deriving REPLACES its graph and its foundation flags. Run
 * before the hand-authoring specs above, this block leaves card 1 marked
 * always-included — at which point their toggle on it is correctly inert and
 * they fail for a reason that has nothing to do with what they test.
 *
 * The alternative, having every block reset the estimate first, buys
 * independence this file does not need and costs a fixture reset per spec.
 */
test.describe('deriving the graph with the Cartographer', () => {
  test.slow();

  // Deriving REPLACES the graph, so it asks first whenever there is something
  // to lose — and by this point in the file there always is. Playwright
  // auto-DISMISSES dialogs, which would make every click below a silent no-op,
  // so the accept has to be registered for the whole block rather than per
  // spec. Registered on every navigation because `router.refresh()` and
  // `page.reload()` both re-arm it.
  test.beforeEach(async ({ page }) => {
    page.on('dialog', (d) => void d.accept());
  });

  test('works out the dependencies, then the configurator cascades on them', async ({ page }) => {
    await login(page);
    await openScope(page);

    // The stub DERIVES its answer from the corpus it is handed — it reads the
    // card numbers out of the rendered list and chains them — so this exercises
    // the real number-to-id mapping. A canned payload would pass even if that
    // mapping were broken, which is the whole reason the stub works this way.
    await page.getByTestId('scope-graph-derive').click();
    await expect(page.getByTestId('scope-graph-derived')).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByTestId('scope-graph-derived')).toContainText('Found 1 dependency');

    // With a graph, the configurator appears and cascades over it. The stub
    // chains card 2 onto card 1 and marks card 1 as always-included, so card 1
    // renders as foundation and its toggle does nothing.
    await expect(page.getByTestId('scope-totals')).toBeVisible({ timeout: COLD_COMPILE });
    await expect(page.getByTestId(`scope-foundation-${FIRST}`)).toBeVisible();

    // Reload before measuring. The derive finishes with `router.refresh()`,
    // which re-renders the server component asynchronously — reading a count
    // mid-refresh gets the pre-refresh number and the assertion then races the
    // new one. A reload makes the state unambiguously server-rendered.
    await page.reload();
    await expect(page.getByTestId('scope-totals')).toBeVisible({ timeout: COLD_COMPILE });

    // Establish a known selection before measuring one. The specs above leave
    // the scenario in whatever state they finished in, and "toggle a card off"
    // is only meaningful if it was on — otherwise the click turns it ON and the
    // count goes the other way, which is what caught this out. Reset makes it
    // as-proposed, which for this estimate is everything on.
    await page.getByTestId('scope-reset').click();
    await expect(page.getByTestId('scope-modules')).toContainText('2 modules of 2');
    await saveSettled(page, SECOND!);

    // Now the cascade, over a graph nobody typed: card 2 needs card 1, so
    // switching card 2 off drops it alone and leaves the foundation standing.
    await page.getByTestId(`scope-toggle-${SECOND}`).click();
    await expect(page.getByTestId('scope-modules')).toContainText('1 module of 2');
    await saveSettled(page, SECOND!);
  });

  test('a second pass replaces the graph rather than stacking on it', async ({ page }) => {
    await login(page);
    await openScope(page);

    // Derive twice in a row. The claim is that the second pass REPLACES — so
    // the recorded count has to be the same afterwards, not double. That is
    // asserted on the count itself rather than on the page still rendering,
    // which an earlier version of this spec did and which proved nothing.
    await page.getByTestId('scope-graph-derive').click();
    await expect(page.getByTestId('scope-graph-derived')).toContainText('Found 1 dependency', {
      timeout: COLD_COMPILE,
    });
    await expect(page.getByTestId('scope-graph-count')).toContainText('1 recorded', {
      timeout: COLD_COMPILE,
    });

    await page.getByTestId('scope-graph-derive').click();
    await expect(page.getByTestId('scope-graph-derived')).toContainText('Found 1 dependency', {
      timeout: COLD_COMPILE,
    });
    await expect(page.getByTestId('scope-graph-count')).toContainText('1 recorded', {
      timeout: COLD_COMPILE,
    });
  });
});
