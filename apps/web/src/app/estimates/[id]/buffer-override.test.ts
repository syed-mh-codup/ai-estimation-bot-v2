import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Setting one role's buffer on one estimate.
 *
 * Three properties here are load-bearing and easy to break by "tidying":
 *
 *   1. The recompute is role-scoped. Re-taxing the whole estimate would heal
 *      PM/BA lines still carrying mixed-version hours from the defect AEH-335
 *      also fixes, so a QA nudge would move numbers nobody touched.
 *   2. Delivery-overhead cards are never re-taxed. Their hours are already a
 *      percentage OF taxed hours, so taxing them compounds a percentage on a
 *      percentage.
 *   3. `edited` is not touched. It marks a line a human typed into, and moving
 *      a buffer is not a touch of any individual line.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ requireUser: vi.fn() }));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }));
vi.mock('@/lib/due-date', () => ({ fromDateInputValue: () => null }));
vi.mock('@/lib/email', () => ({ sendCustodyAssignedEmail: vi.fn() }));

const estFindUnique = vi.fn();
const estFindUniqueOrThrow = vi.fn();
const estUpdate = vi.fn();
const cfgFindUnique = vi.fn();
const cfgFindFirst = vi.fn();
const lineFindMany = vi.fn();
const lineUpdateMany = vi.fn();
const itemCount = vi.fn();
const changeCreate = vi.fn();

// Built inside the factory: `vi.mock` is hoisted above every declaration in
// this file, so reading an outer object here would run before it exists. The
// spies are only ever *referenced* through arrows, which defers them until the
// call actually happens — by which time the consts above are initialised.
//
// `$transaction` hands the callback the same client, so the action's writes and
// its reads inside the transaction land on one set of spies.
vi.mock('@repo/db', () => {
  const client = {
    estimate: {
      findUnique: (...a: unknown[]) => estFindUnique(...a),
      findUniqueOrThrow: (...a: unknown[]) => estFindUniqueOrThrow(...a),
      update: (...a: unknown[]) => estUpdate(...a),
    },
    estimationConfig: {
      findUnique: (...a: unknown[]) => cfgFindUnique(...a),
      findFirst: (...a: unknown[]) => cfgFindFirst(...a),
    },
    roleLineItem: {
      findMany: (...a: unknown[]) => lineFindMany(...a),
      updateMany: (...a: unknown[]) => lineUpdateMany(...a),
    },
    menuItem: { count: (...a: unknown[]) => itemCount(...a) },
    estimateTaxChange: { create: (...a: unknown[]) => changeCreate(...a) },
  };
  return {
    prisma: { ...client, $transaction: (cb: (c: unknown) => unknown) => cb(client) },
  };
});

import { requireUser } from '@/lib/rbac';
import { setEstimateTaxPct } from './actions';

const mockRequireUser = requireUser as unknown as ReturnType<typeof vi.fn>;

const EST = 'est-1';
const HOUSE = { pmCommunicationTaxPct: 12, baCommunicationTaxPct: 8, qaRegressionBufferPct: 20 };
const NO_OVERRIDES = {
  pmCommunicationTaxPctOverride: null,
  baCommunicationTaxPctOverride: null,
  qaRegressionBufferPctOverride: null,
};

/** Four QA lines at 20%: 2h->2.5, 3h->3.5, 4h->4.75, 1h->1.25. */
const QA_LINES = [
  { id: 'qa-2h', baseHours: 2, taxedHours: 2.5 },
  { id: 'qa-3h', baseHours: 3, taxedHours: 3.5 },
  { id: 'qa-4h', baseHours: 4, taxedHours: 4.75 },
  { id: 'qa-1h', baseHours: 1, taxedHours: 1.25 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireUser.mockResolvedValue({ id: 'user-1', role: 'ESTIMATOR' });
  estFindUnique.mockResolvedValue({ status: 'DRAFT' });
  estFindUniqueOrThrow.mockResolvedValue({ configVersion: 3, ...NO_OVERRIDES });
  estUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    configVersion: 3,
    ...NO_OVERRIDES,
    ...data,
    overheadRatesStale: false,
  }));
  cfgFindUnique.mockResolvedValue(HOUSE);
  cfgFindFirst.mockResolvedValue(HOUSE);
  lineFindMany.mockResolvedValue(QA_LINES);
  lineUpdateMany.mockResolvedValue({ count: 0 });
  itemCount.mockResolvedValue(0);
  changeCreate.mockResolvedValue({});
});

describe('setEstimateTaxPct — what it refuses', () => {
  it('refuses a finalised estimate', async () => {
    estFindUnique.mockResolvedValue({ status: 'FINALISED' });
    await expect(setEstimateTaxPct(EST, 'QA', 30)).rejects.toThrow(/finalised/i);
    expect(estUpdate).not.toHaveBeenCalled();
  });

  /** DEV is untaxed by construction — the complexity multiplier already applies. */
  it('refuses DEV, which has no buffer to set', async () => {
    await expect(setEstimateTaxPct(EST, 'DEV', 10)).rejects.toThrow(/no buffer/i);
    expect(estUpdate).not.toHaveBeenCalled();
  });

  it('refuses a percentage outside the bounds', async () => {
    await expect(setEstimateTaxPct(EST, 'QA', 101)).rejects.toThrow(/between/i);
    await expect(setEstimateTaxPct(EST, 'QA', -1)).rejects.toThrow(/between/i);
    expect(estUpdate).not.toHaveBeenCalled();
  });

  it('refuses NaN, which is what a non-numeric input coerces to', async () => {
    await expect(setEstimateTaxPct(EST, 'QA', Number('abc'))).rejects.toThrow(/between/i);
    expect(estUpdate).not.toHaveBeenCalled();
  });
});

describe('setEstimateTaxPct — the recompute', () => {
  it('only looks at the role being changed, and never at an overhead card', async () => {
    await setEstimateTaxPct(EST, 'QA', 30);
    expect(lineFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { role: 'QA', menuItem: { estimateId: EST, overhead: false } },
      }),
    );
  });

  it('writes the new taxed hours, grouped by the resulting figure', async () => {
    await setEstimateTaxPct(EST, 'QA', 30);
    // At 30%: 2->2.5 (unchanged), 3->4, 4->5.25, 1->1.25 (unchanged).
    const writes = lineUpdateMany.mock.calls.map(([a]) => a as Record<string, unknown>);
    const byHours = new Map(
      writes.map((w) => [
        (w['data'] as { taxedHours: number }).taxedHours,
        ((w['where'] as { id: { in: string[] } }).id.in as string[]).sort(),
      ]),
    );
    expect(byHours.get(4)).toEqual(['qa-3h']);
    expect(byHours.get(5.25)).toEqual(['qa-4h']);
    expect(byHours.size).toBe(2);
  });

  /**
   * The rounding dead zone, at the persistence layer. A line whose figure does
   * not move must not be written at all — that is what makes a repeated call
   * free and keeps a no-op nudge from touching rows.
   */
  it('leaves alone the lines whose figure does not move', async () => {
    await setEstimateTaxPct(EST, 'QA', 30);
    const touched = lineUpdateMany.mock.calls.flatMap(
      ([a]) => ((a as { where: { id: { in: string[] } } }).where.id.in),
    );
    expect(touched).not.toContain('qa-2h');
    expect(touched).not.toContain('qa-1h');
  });

  /** `edited` marks a line a human typed into. A buffer change is not that. */
  it('never sets edited on a recomputed line', async () => {
    await setEstimateTaxPct(EST, 'QA', 30);
    for (const [arg] of lineUpdateMany.mock.calls) {
      expect((arg as { data: Record<string, unknown> }).data).not.toHaveProperty('edited');
    }
  });

  it('writes nothing at all when the buffer is set to what it already resolves to', async () => {
    await setEstimateTaxPct(EST, 'QA', 20);
    expect(lineUpdateMany).not.toHaveBeenCalled();
  });

  /** Null means inherit, and inherit means the PINNED config's rate. */
  it('falls back to the pinned house rate when reset to inherit', async () => {
    estFindUniqueOrThrow.mockResolvedValue({
      configVersion: 3,
      ...NO_OVERRIDES,
      qaRegressionBufferPctOverride: 50,
    });
    lineFindMany.mockResolvedValue([{ id: 'qa-3h', baseHours: 3, taxedHours: 4.5 }]);

    const res = await setEstimateTaxPct(EST, 'QA', null);

    expect(estUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { qaRegressionBufferPctOverride: null } }),
    );
    expect(res.effective.QA).toBe(20);
    expect(lineUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { taxedHours: 3.5 } }),
    );
  });
});

describe('setEstimateTaxPct — overhead staleness', () => {
  it('does not claim staleness when the estimate has no overhead card', async () => {
    itemCount.mockResolvedValue(0);
    const res = await setEstimateTaxPct(EST, 'QA', 30);
    expect(res.overheadRatesStale).toBe(false);
  });

  it('marks overhead stale once a buffer moves and overhead cards exist', async () => {
    itemCount.mockResolvedValue(2);
    const res = await setEstimateTaxPct(EST, 'QA', 30);
    expect(res.overheadRatesStale).toBe(true);
    expect(estUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { overheadRatesStale: true } }),
    );
  });

  /** A nudge that moves no hours has invalidated nothing. */
  it('does not mark overhead stale when no hours moved', async () => {
    itemCount.mockResolvedValue(2);
    const res = await setEstimateTaxPct(EST, 'QA', 20);
    expect(res.overheadRatesStale).toBe(false);
  });
});

describe('setEstimateTaxPct — provenance', () => {
  it('records who moved it, and from what to what', async () => {
    await setEstimateTaxPct(EST, 'QA', 30);
    expect(changeCreate).toHaveBeenCalledWith({
      data: {
        estimateId: EST,
        role: 'QA',
        fromPct: null,
        toPct: 30,
        changedBy: 'user-1',
      },
    });
  });

  /** No change reason is collected — see the note on the action. */
  it('asks for no change reason', async () => {
    await setEstimateTaxPct(EST, 'QA', 30);
    const arg = changeCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> } | undefined;
    expect(arg).toBeDefined();
    expect(arg?.data).not.toHaveProperty('changeReason');
  });

  it('records a reset back to inherit as a change to null', async () => {
    estFindUniqueOrThrow.mockResolvedValue({
      configVersion: 3,
      ...NO_OVERRIDES,
      qaRegressionBufferPctOverride: 50,
    });
    await setEstimateTaxPct(EST, 'QA', null);
    expect(changeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fromPct: 50, toPct: null }),
      }),
    );
  });

  it('records nothing when the override is set to the value it already had', async () => {
    estFindUniqueOrThrow.mockResolvedValue({
      configVersion: 3,
      ...NO_OVERRIDES,
      qaRegressionBufferPctOverride: 30,
    });
    await setEstimateTaxPct(EST, 'QA', 30);
    expect(changeCreate).not.toHaveBeenCalled();
  });
});
