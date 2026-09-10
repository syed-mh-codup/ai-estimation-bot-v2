import { describe, expect, it } from 'vitest';

import { carriedMark } from './dto';

/**
 * AEH-236. What the margin rule draws beside a row.
 *
 * A pure function, and deliberately so: the rule has to agree between the page,
 * the two server actions that return an edited row, and anything that reads it
 * next. Pinning it here is what stops those four growing four opinions.
 *
 * The cases below are named for the SITUATION rather than the flags, because
 * every one of them is a real thing that happens to a forked estimate and the
 * flag combinations on their own read as arbitrary.
 */

const CARRIED_CARD = { carriedFromId: 'parent-card' };
const NEW_CARD = { carriedFromId: null };

const row = (over: Partial<{ carriedFromId: string | null; carriedIntact: boolean; carriedVerified: boolean }> = {}) => ({
  carriedFromId: 'parent-row',
  carriedIntact: true,
  carriedVerified: false,
  ...over,
});

describe('carriedMark', () => {
  it('draws nothing on an estimate that was never forked', () => {
    // The overwhelmingly common case: no parent, no margin, and the ledger
    // renders exactly as it did before this feature existed.
    expect(carriedMark(NEW_CARD, row({ carriedFromId: null }))).toBeNull();
  });

  it('draws nothing for work added to a brand-new card on a fork', () => {
    // The card itself is new, so nothing about it traces to the parent — even
    // though the estimate as a whole does.
    expect(carriedMark(NEW_CARD, row())).toBeNull();
  });

  it('marks a row that came across untouched', () => {
    expect(carriedMark(CARRIED_CARD, row())).toBe('carried');
  });

  it('marks a row somebody had signed off on the parent', () => {
    // The lock did not carry — a lock is a statement about the estimate it sits
    // on. The evidence that it existed did, and this is what it buys.
    expect(carriedMark(CARRIED_CARD, row({ carriedVerified: true }))).toBe('verified');
  });

  it('marks an edited row as amended, not as new', () => {
    expect(carriedMark(CARRIED_CARD, row({ carriedIntact: false }))).toBe('amended');
  });

  it('still marks a signed-off row as amended once it moves', () => {
    // "Was checked" and "still matches" are different claims, and the second
    // one losing does not resurrect the first. A green rule on a row whose
    // hours have changed would assert the current number was approved.
    expect(carriedMark(CARRIED_CARD, row({ carriedVerified: true, carriedIntact: false }))).toBe(
      'amended',
    );
  });

  it('marks a RE-PRICED row as amended, though its own carriage is gone', () => {
    // This is why the card is consulted at all. `applyRegionReplace` deletes a
    // re-priced row and creates a fresh one, so `carriedFromId` is null and the
    // row is indistinguishable from hand-added work. Read from the row alone,
    // re-priced work on a quoted card would show NO rule — losing exactly the
    // "was in that price and has moved" signal the mark exists for.
    expect(carriedMark(CARRIED_CARD, row({ carriedFromId: null }))).toBe('amended');
  });

  it('leaves a carried row solid when its CARD gained a line', () => {
    // The card is no longer intact, but these rows are untouched and still say
    // what was quoted. Card-level churn belongs in the card's header, not in
    // the margin of rows it did not change.
    expect(carriedMark({ carriedFromId: 'parent-card' }, row())).toBe('carried');
  });
});
