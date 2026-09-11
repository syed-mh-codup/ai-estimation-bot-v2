import { describe, it, expect } from 'vitest';
import type { ItemDTO, LineItemDTO } from './dto';
import { EMPTY_ENVELOPE } from './dto';
import { cardMarks, isDimmed, markCounts, type MarkContext } from './marks';

const NO_LOCKS: MarkContext = { overheadStale: false, lockedLineIds: new Set() };

function line(over: Partial<LineItemDTO> = {}): LineItemDTO {
  return {
    id: 'li-1',
    role: 'DEV',
    title: 'Do the thing',
    baseHours: 8,
    taxedHours: 8,
    provenance: 'CREW',
    touchesFrontend: false,
    touchesBackend: true,
    envelope: EMPTY_ENVELOPE,
    carried: null,
    ...over,
  };
}

function card(over: Partial<ItemDTO> = {}): ItemDTO {
  return {
    id: 'card-1',
    title: 'B2B Pricing',
    enabled: true,
    taxonomyKey: 'commerce.pricing',
    sectionId: null,
    order: 0,
    injected: false,
    overhead: false,
    category: 'Commerce',
    phase: 'Build',
    sourcePresetId: 'wc-b2b-pricing-v3',
    matchScore: 0.81,
    carriedFromId: null,
    carriedIntact: true,
    flags: { toggleable: true, notSafelyRemovable: false, thinSlice: false },
    lineItems: [line()],
    ...over,
  };
}

describe('cardMarks', () => {
  it('marks nothing on an ordinary crew-priced card', () => {
    expect(cardMarks(card(), NO_LOCKS)).toEqual([]);
  });

  it('reads inferred, off and edited off the card and its rows', () => {
    const it_ = card({
      injected: true,
      enabled: false,
      lineItems: [line({ provenance: 'HUMAN' })],
    });
    expect(cardMarks(it_, NO_LOCKS)).toEqual(['inferred', 'edited', 'off']);
  });

  it('treats a steered row as edited — it carries a person’s judgement', () => {
    expect(cardMarks(card({ lineItems: [line({ provenance: 'STEERED' })] }), NO_LOCKS)).toEqual([
      'edited',
    ]);
  });

  it('marks a card amended when any one of its rows has moved since the fork', () => {
    const it_ = card({
      carriedFromId: 'parent-card',
      lineItems: [line({ id: 'a', carried: 'carried' }), line({ id: 'b', carried: 'amended' })],
    });
    expect(cardMarks(it_, NO_LOCKS)).toContain('amended');
  });

  it('does not mark a fork whose rows all came across intact', () => {
    const it_ = card({
      carriedFromId: 'parent-card',
      lineItems: [line({ id: 'a', carried: 'carried' }), line({ id: 'b', carried: 'verified' })],
    });
    expect(cardMarks(it_, NO_LOCKS)).not.toContain('amended');
  });

  it('marks a card locked when one of its rows is frozen, not only when all are', () => {
    const it_ = card({ lineItems: [line({ id: 'a' }), line({ id: 'b' })] });
    const ctx: MarkContext = { overheadStale: false, lockedLineIds: new Set(['b']) };
    expect(cardMarks(it_, ctx)).toEqual(['locked']);
  });

  it('marks a card the Archivist could not anchor', () => {
    expect(cardMarks(card({ sourcePresetId: null }), NO_LOCKS)).toEqual(['unmatched']);
  });

  it('never calls an overhead card unmatched — it never had a preset to match', () => {
    const it_ = card({ overhead: true, sourcePresetId: null });
    expect(cardMarks(it_, NO_LOCKS)).not.toContain('unmatched');
  });

  it('marks an overhead card stale only once a buffer has actually moved', () => {
    const it_ = card({ overhead: true, sourcePresetId: null });
    expect(cardMarks(it_, NO_LOCKS)).toEqual([]);
    expect(cardMarks(it_, { ...NO_LOCKS, overheadStale: true })).toEqual(['stale']);
  });

  it('does not call an ordinary card stale when the overhead rates have moved', () => {
    expect(cardMarks(card(), { ...NO_LOCKS, overheadStale: true })).toEqual([]);
  });
});

describe('markCounts', () => {
  it('omits every mark nothing on the estimate carries', () => {
    const counts = markCounts([card(), card({ id: 'c2' })], NO_LOCKS);
    expect(counts).toEqual({});
  });

  it('counts cards, not rows — two edited rows on one card is one card', () => {
    const it_ = card({
      lineItems: [line({ id: 'a', provenance: 'HUMAN' }), line({ id: 'b', provenance: 'HUMAN' })],
    });
    expect(markCounts([it_], NO_LOCKS)).toEqual({ edited: 1 });
  });

  it('counts a card under every mark it carries', () => {
    const counts = markCounts(
      [
        card({ id: 'a', injected: true }),
        card({ id: 'b', injected: true, enabled: false }),
        card({ id: 'c', sourcePresetId: null }),
      ],
      NO_LOCKS,
    );
    expect(counts).toEqual({ inferred: 2, off: 1, unmatched: 1 });
  });
});

describe('isDimmed', () => {
  it('dims nothing while no mark is being looked at', () => {
    expect(isDimmed(card({ injected: true }), null, NO_LOCKS)).toBe(false);
    expect(isDimmed(card(), null, NO_LOCKS)).toBe(false);
  });

  it('keeps the cards carrying the mark and dims the rest', () => {
    expect(isDimmed(card({ injected: true }), 'inferred', NO_LOCKS)).toBe(false);
    expect(isDimmed(card(), 'inferred', NO_LOCKS)).toBe(true);
  });

  it('agrees with the count — every undimmed card is one the chip counted', () => {
    const cards = [
      card({ id: 'a', injected: true }),
      card({ id: 'b' }),
      card({ id: 'c', injected: true, enabled: false }),
    ];
    const counts = markCounts(cards, NO_LOCKS);
    const shown = cards.filter((c) => !isDimmed(c, 'inferred', NO_LOCKS));
    expect(shown).toHaveLength(counts.inferred ?? 0);
  });
});
