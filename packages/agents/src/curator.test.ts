import { describe, expect, it, vi } from 'vitest';

import type { ChatResult, IModelProvider } from '@repo/providers';

import { runCurator, type CuratableCard } from './curator';

/**
 * AEH-238. The Curator decides what belongs together on a card.
 *
 * The model is faked, so what these guard is everything AROUND the call — and
 * that is where the dangerous failures are, because all of them are silent:
 *
 * A line the model forgets to assign is work quietly vanishing from the
 * estimate. A line it assigns twice is work counted twice. A proposal that
 * reuses no existing card would leave the original behind as an empty husk
 * while its work moved elsewhere.
 *
 * So most of the cases below hand it something wrong on purpose. An
 * implementation that wrote back whatever it was given would pass a test that
 * only checked the happy path.
 */

function providerReturning(payload: unknown): IModelProvider {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    chat: vi.fn().mockResolvedValue({ text, model: 'stub/model', usage: null } satisfies ChatResult),
    chatStream: async function* () {
      yield { type: 'delta' as const, text };
      yield { type: 'done' as const, usage: null, model: 'stub/model' };
    },
    embed: vi.fn(),
  } as unknown as IModelProvider;
}

const ctxWith = (payload: unknown) => ({
  modelProvider: providerReturning(payload),
  modelString: 'stub/model',
  instructions: 'You are the Curator.',
  recorder: { record: vi.fn() },
  levers: undefined,
});

/** One card, four lines: two DEV, two QA. */
const CARD: CuratableCard = {
  menuItemId: 'card-1',
  title: 'Checkout',
  taxonomyKey: 'ecom.checkout',
  category: 'Commerce',
  phase: 'Core',
  lines: [
    { lineItemId: 'li-1', role: 'DEV', description: 'payment intent', hours: 4 },
    { lineItemId: 'li-2', role: 'DEV', description: 'receipt email', hours: 2 },
    { lineItemId: 'li-3', role: 'QA', description: 'payment happy path', hours: 2 },
    { lineItemId: 'li-4', role: 'QA', description: 'receipt rendering', hours: 1 },
  ],
};

const ARGS = { cards: [CARD], instruction: 'split payment from receipts', ledgerContext: '- other' };

describe('runCurator', () => {
  it('does not collapse two proposals that give themselves the same ref', async () => {
    // `ref` is the model's own numbering and the schema only requires a
    // positive integer — nothing makes it unique. Keyed by ref, the second
    // proposal's reuse overwrote the first's, every line landed on one card,
    // and the original the first should have reused was left empty and deleted
    // by `applyRestructure`: a split silently became a merge that lost a card.
    const out = await runCurator(
      {
        ...ARGS,
        cards: [
          { ...CARD, lines: CARD.lines.slice(0, 2) },
          {
            ...CARD,
            menuItemId: 'card-2',
            title: 'Receipts',
            // Its own rows: spreading CARD's would give two cards the same
            // line ids, and the numbering the model answers against is one
            // flat list across both.
            lines: [
              { lineItemId: 'li-5', role: 'DEV', description: 'receipt pdf', hours: 3 },
              { lineItemId: 'li-6', role: 'QA', description: 'receipt checks', hours: 1 },
            ],
          },
        ],
      },
      ctxWith({
        cards: [
          { ref: 1, title: 'Payment', lines: [1, 2] },
          { ref: 1, title: 'Receipts', lines: [3, 4] },

        ],
      }),
    );

    expect(out.cards).toHaveLength(2);
    // Two proposals, two DIFFERENT existing cards reused — not one card twice.
    const reused = out.cards.map((c) => c.reuseMenuItemId);
    expect(new Set(reused).size).toBe(2);
    // And every line still assigned exactly once.
    expect(out.cards.flatMap((c) => c.lineItemIds).sort()).toEqual([
      'li-1',
      'li-2',
      'li-5',
      'li-6',
    ]);
  });

  it('assigns the lines it was told to, and resolves them to real ids', async () => {
    const out = await runCurator(
      ARGS,
      ctxWith({
        cards: [
          { ref: 1, title: 'Payment', lines: [1, 3] },
          { ref: 2, title: 'Receipts', lines: [2, 4] },
        ],
      }),
    );

    expect(out.cards.map((c) => c.title)).toEqual(['Payment', 'Receipts']);
    expect(out.cards[0]?.lineItemIds).toEqual(['li-1', 'li-3']);
    expect(out.cards[1]?.lineItemIds).toEqual(['li-2', 'li-4']);
  });

  it('rescues a line the model forgot, rather than letting the work disappear', async () => {
    const out = await runCurator(
      ARGS,
      ctxWith({
        cards: [
          { ref: 1, title: 'Payment', lines: [1, 3] },
          // li-4 is simply missing.
          { ref: 2, title: 'Receipts', lines: [2] },
        ],
      }),
    );

    const assigned = out.cards.flatMap((c) => c.lineItemIds);
    // Every line still has a home. Putting an orphan on the first card is an
    // arbitrary choice, deliberately: a misplaced line is a tidy-up somebody
    // can see and fix, a lost one is hours that silently left the estimate.
    expect(assigned.sort()).toEqual(['li-1', 'li-2', 'li-3', 'li-4']);
    expect(out.cards[0]?.lineItemIds).toContain('li-4');
  });

  it('keeps a duplicated line once, so nothing is counted twice', async () => {
    const out = await runCurator(
      ARGS,
      ctxWith({
        cards: [
          { ref: 1, title: 'Payment', lines: [1, 2, 3] },
          // li-2 claimed again.
          { ref: 2, title: 'Receipts', lines: [2, 4] },
        ],
      }),
    );

    const assigned = out.cards.flatMap((c) => c.lineItemIds);
    expect(assigned).toHaveLength(4);
    expect(new Set(assigned).size).toBe(4);
    // First mention wins, so the duplicate does not also move.
    expect(out.cards[0]?.lineItemIds).toContain('li-2');
    expect(out.cards[1]?.lineItemIds).not.toContain('li-2');
  });

  it('reuses the original card for the proposal that took most of its lines', async () => {
    const out = await runCurator(
      ARGS,
      ctxWith({
        cards: [
          { ref: 1, title: 'Receipts', lines: [2] },
          { ref: 2, title: 'Payment', lines: [1, 3, 4] },
        ],
      }),
    );

    // Reuse is decided here, not by the model. The bigger half inherits the
    // existing row, so the card's id — and everything pointing at it — survives
    // a split wherever it honestly can.
    const payment = out.cards.find((c) => c.title === 'Payment');
    const receipts = out.cards.find((c) => c.title === 'Receipts');
    expect(payment?.reuseMenuItemId).toBe('card-1');
    expect(receipts?.reuseMenuItemId).toBeNull();
  });

  it('inherits taxonomy, category and phase when the model omits them', async () => {
    const out = await runCurator(
      ARGS,
      ctxWith({ cards: [{ ref: 1, title: 'Everything', lines: [1, 2, 3, 4] }] }),
    );
    expect(out.cards[0]).toMatchObject({
      taxonomyKey: 'ecom.checkout',
      category: 'Commerce',
      phase: 'Core',
    });
  });

  it('falls back to the card’s own category when the model sends a blank one', async () => {
    const out = await runCurator(
      ARGS,
      ctxWith({
        cards: [{ ref: 1, title: 'Everything', category: '   ', lines: [1, 2, 3, 4] }],
      }),
    );
    // A blank category renders as an empty chip and is invisible in the
    // analysis, so keeping the one the card had is strictly better.
    expect(out.cards[0]?.category).toBe('Commerce');
  });

  it('carries the notes through, which is how a refusal reaches a person', async () => {
    const out = await runCurator(
      ARGS,
      ctxWith({
        cards: [{ ref: 1, title: 'Checkout', lines: [1, 2, 3, 4] }],
        notes: 'This work does not divide along that line, so it is unchanged.',
      }),
    );
    expect(out.notes).toMatch(/does not divide/);
    // Unchanged means unchanged: one card, still the original.
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]?.reuseMenuItemId).toBe('card-1');
  });

  it('does nothing at all when there are no lines to move', async () => {
    const out = await runCurator(
      { ...ARGS, cards: [{ ...CARD, lines: [] }] },
      ctxWith({ cards: [{ ref: 1, title: 'Anything', lines: [1] }] }),
    );
    // Returns before spending a model call: there is no shape to decide.
    expect(out.cards).toEqual([]);
    expect(out.notes).toMatch(/no line items/i);
  });

  it('merges by returning one card holding every line', async () => {
    const second: CuratableCard = {
      menuItemId: 'card-2',
      title: 'Reports',
      taxonomyKey: 'ecom.reports',
      category: 'Commerce',
      phase: 'Enhancement',
      lines: [{ lineItemId: 'li-5', role: 'DEV', description: 'sales report', hours: 3 }],
    };
    const out = await runCurator(
      { cards: [CARD, second], instruction: 'merge these', ledgerContext: '' },
      ctxWith({ cards: [{ ref: 1, title: 'Checkout and reports', lines: [1, 2, 3, 4, 5] }] }),
    );

    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]?.lineItemIds).toEqual(['li-1', 'li-2', 'li-3', 'li-4', 'li-5']);
    // It reuses the card it took the most from, so the merge keeps one real
    // row and `applyRestructure` removes the other once it is empty.
    expect(out.cards[0]?.reuseMenuItemId).toBe('card-1');
  });
});
