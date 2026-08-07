import { describe, it, expect } from 'vitest';
import { devEffortOf, PROMOTION_MATCH_THRESHOLD } from './writeback';
import type { RoleLineItem } from '@repo/shared';

/**
 * Dev effort is ONE figure. Frontend and backend are estimated together because
 * delivery is full-stack; the flags exist so the split can be reintroduced later
 * if that changes, not so hours can be divided now.
 *
 * This supersedes an interim version that partitioned the total using a library
 * ratio, which itself replaced the original defect:
 *   beHours = Σ DEV;  feHours = round(beHours * 0.4)
 * — all of DEV to backend plus another 40% on top, storing 1.4x the estimate and
 * compounding every time a promoted preset became the next estimate's anchor.
 * With one figure there is no ratio left to get wrong.
 */

const li = (role: RoleLineItem['role'], taxedHours: number, side?: 'fe' | 'be' | 'both'): RoleLineItem =>
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

describe('devEffortOf', () => {
  it('sums DEV hours into one figure and ignores other roles', () => {
    expect(devEffortOf([li('DEV', 20, 'be'), li('DEV', 10, 'fe'), li('QA', 8), li('PM', 4)])).toEqual({
      devHours: 30,
      touchesBackend: true,
      touchesFrontend: true,
      tagged: true,
    });
  });

  it('never scales, splits or marks up the total', () => {
    // The number that lands in the library is exactly the number estimated.
    // Old behaviour on this input: be=30, fe=12, total 42.
    expect(devEffortOf([li('DEV', 30, 'be')]).devHours).toBe(30);
    expect(devEffortOf([li('DEV', 100, 'both')]).devHours).toBe(100);
    expect(devEffortOf([li('DEV', 7.5, 'fe')]).devHours).toBe(8); // rounded to Int, not ratioed
  });

  it('ORs the flags across dev rows — the card covers what any item covers', () => {
    const e = devEffortOf([li('DEV', 4, 'be'), li('DEV', 4, 'fe')]);
    expect(e).toMatchObject({ touchesBackend: true, touchesFrontend: true, tagged: true });
  });

  it('reports untagged so callers can carry prior flags instead of erasing them', () => {
    const e = devEffortOf([li('DEV', 12), li('DEV', 6)]);
    expect(e).toMatchObject({ devHours: 18, touchesBackend: false, touchesFrontend: false, tagged: false });
  });

  it('counts a partially tagged card as tagged', () => {
    expect(devEffortOf([li('DEV', 4, 'be'), li('DEV', 4)]).tagged).toBe(true);
  });

  it('returns zero for a card with no dev work rather than inventing any', () => {
    expect(devEffortOf([li('QA', 10), li('BA', 4)])).toMatchObject({ devHours: 0, tagged: false });
  });
});

describe('PROMOTION_MATCH_THRESHOLD', () => {
  it('is strict enough that an ordinary-strength match will not overwrite a preset', () => {
    // Live scores run ~0.46-0.62 on ordinary SOWs; those must mint new presets.
    expect(PROMOTION_MATCH_THRESHOLD).toBeGreaterThan(0.62);
    expect(PROMOTION_MATCH_THRESHOLD).toBeLessThanOrEqual(0.85);
  });
});
