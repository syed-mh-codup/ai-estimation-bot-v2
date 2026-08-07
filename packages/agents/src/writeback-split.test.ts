import { describe, it, expect } from 'vitest';
import { splitDevHours, PROMOTION_MATCH_THRESHOLD } from './writeback';
import type { RoleLineItem } from '@repo/shared';

/**
 * The defect these tests exist to prevent:
 *
 *   const beHours = sum(DEV taxedHours);
 *   const feHours = Math.round(beHours * 0.4);   // "approximate FE split"
 *
 * That comment said "split" but the code was a markup — 100% of DEV to backend
 * and another 40% added on top, storing 1.4x the estimate. Because a promoted
 * preset becomes the next estimate's anchor, the error compounded every cycle
 * (100h → 140 → 196 → 274). The invariant below is the fix: the partition
 * always sums to the DEV total.
 */

const li = (
  role: RoleLineItem['role'],
  taxedHours: number,
  side?: 'fe' | 'be' | 'both',
): RoleLineItem =>
  ({
    role,
    baseHours: taxedHours,
    taxedHours,
    edited: false,
    aiAssistApplied: false,
    dependsOn: [],
    anchorPresetIds: [],
    touchesFrontend: side === 'fe' || side === 'both',
    touchesBackend: side === 'be' || side === 'both',
  }) as RoleLineItem;

const total = (s: { beHours: number; feHours: number }) => s.beHours + s.feHours;

describe('splitDevHours', () => {
  it('partitions fully tagged dev hours exactly, summing to the DEV total', () => {
    const s = splitDevHours([
      li('DEV', 10, 'be'),
      li('DEV', 6, 'fe'),
      li('QA', 20, undefined), // must be ignored entirely
      li('PM', 8, undefined),
    ]);

    expect(s).toMatchObject({ beHours: 10, feHours: 6, basis: 'tagged', untaggedHours: 0 });
    expect(total(s)).toBe(16); // NOT 22.4 (the old 1.4x), and QA/PM excluded
  });

  it('halves a genuinely inseparable full-stack item', () => {
    const s = splitDevHours([li('DEV', 4, 'both')]);
    expect(s).toMatchObject({ beHours: 2, feHours: 2, basis: 'tagged' });
    expect(total(s)).toBe(4);
  });

  it('apportions untagged hours by the library ratio and says so', () => {
    const s = splitDevHours([li('DEV', 100)]);
    // 68/32, the library's hours-weighted share — not a 40% markup.
    expect(s).toMatchObject({ beHours: 68, feHours: 32, basis: 'estimated', untaggedHours: 100 });
    expect(total(s)).toBe(100);
  });

  it('reports "mixed" when some items are tagged and some are not', () => {
    const s = splitDevHours([li('DEV', 10, 'be'), li('DEV', 10)]);
    expect(s.basis).toBe('mixed');
    expect(s.untaggedHours).toBe(10);
    expect(total(s)).toBe(20);
  });

  it('never exceeds the DEV total, whatever the mix of tags', () => {
    const cases: RoleLineItem[][] = [
      [li('DEV', 3, 'be'), li('DEV', 5, 'fe'), li('DEV', 2, 'both'), li('DEV', 7)],
      [li('DEV', 0.25, 'fe')],
      [li('DEV', 1.5, 'both'), li('DEV', 1.5, 'both')],
      [li('DEV', 13, 'be'), li('QA', 99), li('BA', 50)],
    ];
    for (const items of cases) {
      const devTotal = items.filter((i) => i.role === 'DEV').reduce((s, i) => s + i.taxedHours, 0);
      expect(total(splitDevHours(items))).toBeCloseTo(devTotal, 2);
    }
  });

  it('returns zeroes for a card with no dev work rather than inventing any', () => {
    const s = splitDevHours([li('QA', 10), li('PM', 4)]);
    expect(s).toMatchObject({ beHours: 0, feHours: 0, untaggedHours: 0 });
  });
});

describe('PROMOTION_MATCH_THRESHOLD', () => {
  it('is strict enough that an ordinary-strength match will not overwrite a preset', () => {
    // Live scores run ~0.46-0.62 on ordinary SOWs; those must mint new presets,
    // not rewrite the established anchor they loosely resemble.
    expect(PROMOTION_MATCH_THRESHOLD).toBeGreaterThan(0.62);
    expect(PROMOTION_MATCH_THRESHOLD).toBeLessThanOrEqual(0.85);
  });
});
