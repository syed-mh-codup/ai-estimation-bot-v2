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
 * them is still in flight — and a `page.reload()` at that point aborts it.
 *
 * Waits on the save indicator rather than on the toggle being re-enabled. Both
 * work, but this one says what it means: the indicator exists precisely to tell
 * a human whether the numbers on screen are the saved ones, so a spec that
 * waits on it is waiting on the same fact the user is reading. Asserted as
 * "no longer saving" rather than "saved", because the confirmation clears
 * itself after a couple of seconds and a slow machine would miss the window.
 */
async function saveSettled(page: Page, _cardId?: string) {
  await expect(page.getByTestId('scope-save-state')).not.toHaveAttribute('data-state', 'saving', {
    timeout: COLD_COMPILE,
  });
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

    // The numbers changed; the indicator is what says they were kept. Without
    // it a cascade in front of a client shows a total that moved and nothing
    // saying whether it stuck.
    await expect(page.getByTestId('scope-save-state')).toHaveAttribute('data-state', 'saved', {
      timeout: COLD_COMPILE,
    });

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
 * Press Derive and see the confirmation through.
 *
 * Re-deriving REPLACES the graph, so it asks first whenever there is something
 * to lose — and it asks INLINE, as a two-step panel in the page
 * (`ScopeDerive.tsx`), not as a `confirm()` dialog. That distinction is the
 * whole reason this helper exists. An earlier version of this file registered
 * `page.on('dialog', accept)` instead, which was correct when the component
 * used `confirm()` and became a no-op 48 minutes later when the component moved
 * to the inline panel and the spec was not updated with it. Nothing failed
 * loudly: the click opened a panel nobody answered, `derive()` was never
 * called, and the assertion sat waiting for a summary that was never coming.
 * CI has been red on exactly these two specs ever since.
 *
 * So: click, give the panel a bounded moment to appear, and answer it if it
 * does. `setConfirming` runs inside the click handler, so the panel is one
 * React render away or it is never coming — two seconds is around twenty times
 * the margin that needs, and it is only ever spent on a first derivation, in a
 * `test.slow()` block.
 *
 * Deliberately NOT written as a race against the finished summary. On a second
 * pass that summary is still on screen from the first one, so whichever
 * appeared first would resolve immediately, the panel would go unanswered, and
 * the assertions afterwards would pass against the OLD result — a green test
 * proving nothing, which is worse than the red one this replaces. Returns
 * whether it actually confirmed so a caller that knows a graph exists can insist
 * on it.
 */
async function derive(page: Page): Promise<boolean> {
  await page.getByTestId('scope-graph-derive').click();

  const askedToConfirm = page.getByTestId('scope-derive-confirm-yes');
  await askedToConfirm.waitFor({ state: 'visible', timeout: 2_000 }).catch(() => {});
  if (!(await askedToConfirm.isVisible())) return false;

  await askedToConfirm.click();
  return true;
}

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

  test('works out the dependencies, then the configurator cascades on them', async ({ page }) => {
    await login(page);
    await openScope(page);

    // The stub DERIVES its answer from the corpus it is handed — it reads the
    // card numbers out of the rendered list and chains them — so this exercises
    // the real number-to-id mapping. A canned payload would pass even if that
    // mapping were broken, which is the whole reason the stub works this way.
    //
    // A graph already exists by now, because the specs above type one, so this
    // MUST be asked to confirm before it replaces anything. Checked rather than
    // assumed: an unanswered confirmation is exactly how this spec broke.
    expect(await derive(page)).toBe(true);
    await expect(page.getByTestId('scope-graph-derived')).toBeVisible({ timeout: COLD_COMPILE });

    // Nought found, and that is the correct answer.
    //
    // The stub chains card 2 onto card 1, which is precisely the pair a person
    // typed above, and `MenuItemDependency` is unique per ordered pair. Because
    // preserved edges are seeded first, the proposal collides with the very edge
    // it agrees with and is refused — so a re-derive over a hand-typed graph
    // writes nothing and keeps what was typed. That preservation IS the feature
    // (`replaceEstimateGraph(..., { preserve: ['MANUAL'] })`), so it is worth
    // stating outright rather than reading as a disappointment.
    //
    // This spec asserted `Found 1 dependency` until now, which was right while a
    // re-derive wiped hand-typed edges too and stopped being right the moment it
    // stopped doing that — see the note on `derive` above for the other half of
    // the same unupdated commit.
    await expect(page.getByTestId('scope-graph-derived')).toContainText(
      'Found 0 dependencies · kept 1 you typed',
    );

    // With a graph, the configurator appears and cascades over it. The stub
    // chains card 2 onto card 1 and marks card 1 as always-included, so card 1
    // renders as foundation and its toggle does nothing.
    //
    // This foundation assertion is also what still proves the number-to-id
    // mapping, now that the refused edge cannot: card 1 only becomes FIRST's
    // flag if the number resolved to the right card, and the summary above
    // reports a refusal identically whether the cause was this deliberate
    // collision or the model inventing a card number.
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

    // Derive twice in a row. The claim is that a second pass does not STACK —
    // the recorded count has to be the same afterwards, not double. That is
    // asserted on the count itself rather than on the page still rendering,
    // which an earlier version of this spec did and which proved nothing.
    //
    // Both passes have a graph to lose by the time they run — the specs above
    // leave one — so both MUST have been asked to confirm. Asserting that is
    // what stops a skipped confirmation from turning this into a test that
    // measures the first pass twice.
    //
    // Worth being straight about what this can and cannot show now. The fixture
    // has two cards, so the only edge the stub can ever chain is 2 onto 1 — the
    // same pair a person typed — and a hand-typed edge is preserved rather than
    // replaced. So what these two passes demonstrate is idempotence and
    // preservation: deriving repeatedly neither doubles the graph nor erodes the
    // typed edge. They do NOT exercise replacing a previously DERIVED edge,
    // which would need either a third card or a block that starts from a graph
    // nobody typed. Left as it stands rather than redesigned here, because that
    // is a decision about what the suite should cover, not a CI repair.
    for (const pass of ['first', 'second'] as const) {
      expect(await derive(page), `${pass} pass should be asked to confirm`).toBe(true);
      await expect(page.getByTestId('scope-graph-derived')).toContainText(
        'Found 0 dependencies · kept 1 you typed',
        { timeout: COLD_COMPILE },
      );
      await expect(page.getByTestId('scope-graph-count')).toContainText('1 recorded', {
        timeout: COLD_COMPILE,
      });
    }
  });
});
