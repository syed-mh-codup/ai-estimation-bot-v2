import { describe, it, expect } from 'vitest';
import { retaxRole, type ItemDTO } from './dto';

/**
 * The client's optimistic half of a buffer change.
 *
 * What these assert is not the arithmetic — `tax-rates.test.ts` owns that — but
 * the SCOPE of it: which line items a buffer change is allowed to move. The
 * roll-up is a plain sum over `taxedHours`, so getting the scope wrong shows up
 * as a headline number that disagrees with the database for one round trip and
 * then jumps when the server answers.
 */

const line = (id: string, role: 'DEV' | 'QA' | 'PM' | 'BA', base: number, taxed: number) => ({
  id,
  role,
  title: `${role} ${base}h`,
  baseHours: base,
  taxedHours: taxed,
  provenance: 'CREW' as const,
  touchesFrontend: false,
  touchesBackend: false,
  envelope: { complexity: null, aiAssistApplied: false, anchorPresetIds: [] },
  carried: null,
});

const card = (id: string, overhead: boolean, lineItems: ItemDTO['lineItems']): ItemDTO =>
  ({
    id,
    title: id,
    enabled: true,
    injected: overhead,
    overhead,
    taxonomyKey: overhead ? 'process.manual-e2e' : 'work.thing',
    sectionId: null,
    order: 0,
    category: null,
    phase: null,
    sourcePresetId: null,
    matchScore: null,
    flags: { toggleable: true, notSafelyRemovable: false, thinSlice: false },
    lineItems,
  }) as ItemDTO;

/** Ordinary work plus one delivery-overhead card, all at a 20% QA buffer. */
const ITEMS: ItemDTO[] = [
  card('work', false, [
    line('dev', 'DEV', 10, 10),
    line('qa', 'QA', 3, 3.5),
    line('pm', 'PM', 4, 4.5),
    line('ba', 'BA', 2, 2.25),
  ]),
  card('overhead', true, [line('oh-qa', 'QA', 9, 9)]),
];

const grand = (items: ItemDTO[]) =>
  items.reduce((s, it) => s + it.lineItems.reduce((t, li) => t + li.taxedHours, 0), 0);

const roleTotal = (items: ItemDTO[], role: string) =>
  items.reduce(
    (s, it) => s + it.lineItems.filter((li) => li.role === role).reduce((t, li) => t + li.taxedHours, 0),
    0,
  );

const find = (items: ItemDTO[], id: string) =>
  items.flatMap((it) => it.lineItems).find((li) => li.id === id);

describe('retaxRole', () => {
  it('moves the total, which is the whole point of the feature', () => {
    expect(grand(ITEMS)).toBe(29.25);
    // 3h at 40% is 4.2, which snaps to 4.25 — up 0.75 from 3.5.
    expect(grand(retaxRole(ITEMS, 'QA', 40))).toBe(30);
  });

  it('re-taxes the role it was given', () => {
    const next = retaxRole(ITEMS, 'QA', 40);
    expect(find(next, 'qa')?.taxedHours).toBe(4.25);
    expect(roleTotal(next, 'QA')).toBe(13.25);
  });

  it('leaves every other role exactly where it was', () => {
    const next = retaxRole(ITEMS, 'QA', 40);
    expect(find(next, 'dev')?.taxedHours).toBe(10);
    expect(find(next, 'pm')?.taxedHours).toBe(4.5);
    expect(find(next, 'ba')?.taxedHours).toBe(2.25);
  });

  /**
   * The one that would silently inflate an estimate. An overhead card's hours
   * are already a percentage OF taxed hours, so re-taxing it charges the buffer
   * twice — and it would land in the headline number without anything saying so.
   */
  it('never touches a delivery-overhead card, at any buffer', () => {
    for (const pct of [0, 20, 40, 100]) {
      const next = retaxRole(ITEMS, 'QA', pct);
      expect(find(next, 'oh-qa')?.taxedHours).toBe(9);
    }
  });

  it('leaves a recomputed line’s provenance alone', () => {
    const next = retaxRole(ITEMS, 'QA', 40);
    // A buffer move is not a person's judgement and not the council re-pricing,
    // so it must not claim to be either.
    expect(next.flatMap((it) => it.lineItems).every((li) => li.provenance === 'CREW')).toBe(true);
  });

  /** Resetting to inherit is just a re-tax at the house rate. */
  it('returns the original figures when re-taxed at the rate already in force', () => {
    expect(grand(retaxRole(ITEMS, 'QA', 20))).toBe(29.25);
    expect(find(retaxRole(ITEMS, 'QA', 20), 'qa')?.taxedHours).toBe(3.5);
  });

  it('does not mutate the array it was given', () => {
    const before = grand(ITEMS);
    retaxRole(ITEMS, 'QA', 90);
    expect(grand(ITEMS)).toBe(before);
  });

  /**
   * The dead zone reaching the headline. At 20% -> 21% the only QA line here is
   * 3h, which does move — but a 2h or 4h line would not, and a total that does
   * not budge on a one-point nudge is the documented, accepted behaviour rather
   * than a broken handler.
   */
  it('can leave the total unmoved on a one-point nudge', () => {
    const twoAndFour = [card('w', false, [line('a', 'QA', 2, 2.5), line('b', 'QA', 4, 4.75)])];
    expect(grand(twoAndFour)).toBe(7.25);
    expect(grand(retaxRole(twoAndFour, 'QA', 21))).toBe(7.25);
  });
});
