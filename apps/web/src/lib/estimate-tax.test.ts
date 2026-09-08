import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The buffers an estimate is costed against come from the config version it is
 * PINNED to, never from whichever version happens to be active.
 *
 * That distinction is the whole reason this module exists. Before AEH-335 the
 * two copies of this logic both read `where: { active: true }`, so an estimate
 * costed under v3 picked up v4's rates on any line edited after v4 was
 * activated — its stored hours became a mix of two config versions while the
 * page still displayed "Config v3" beside them. These tests are what stop that
 * being reintroduced by someone reaching for the active config because it is
 * the easier query to write.
 */

vi.mock('@repo/db', () => ({ prisma: {} }));

import { houseRatesFor, latestTaxChanges, taxContextFor } from './estimate-tax';

const V3 = { pmCommunicationTaxPct: 12, baCommunicationTaxPct: 8, qaRegressionBufferPct: 20 };
const V4 = { pmCommunicationTaxPct: 30, baCommunicationTaxPct: 30, qaRegressionBufferPct: 30 };

const findUnique = vi.fn();
const findFirst = vi.fn();

/** A stand-in for the narrow slice of PrismaClient these helpers accept. */
const client = () =>
  ({
    estimationConfig: { findUnique, findFirst },
  }) as unknown as Parameters<typeof houseRatesFor>[1];

beforeEach(() => {
  vi.clearAllMocks();
  // v4 is active; the estimate under test is pinned to v3.
  findUnique.mockImplementation(async ({ where }: { where: { version: number } }) =>
    where.version === 3 ? V3 : null,
  );
  findFirst.mockResolvedValue(V4);
});

describe('houseRatesFor', () => {
  it('reads the pinned version, not the active one', async () => {
    await expect(houseRatesFor(3, client())).resolves.toEqual(V3);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { version: 3 } }),
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  /**
   * `configVersion` defaults to 0 for an estimate created while no config was
   * active at all, and version 0 has never existed. Zeroing those estimates'
   * buffers would silently reprice them, so the fallback preserves exactly the
   * behaviour they have today.
   */
  it('falls back to the active config when the pinned version has no row', async () => {
    await expect(houseRatesFor(0, client())).resolves.toEqual(V4);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { active: true } }),
    );
  });
});

describe('taxContextFor', () => {
  const pinnedToV3 = {
    configVersion: 3,
    pmCommunicationTaxPctOverride: null,
    baCommunicationTaxPctOverride: null,
    qaRegressionBufferPctOverride: null,
  };

  /** The acceptance criterion: an older pin is honoured while a newer config is live. */
  it('costs an estimate pinned to v3 at v3 rates while v4 is active', async () => {
    const ctx = await taxContextFor(pinnedToV3, client());
    expect(ctx.effective).toEqual({ DEV: 0, QA: 20, PM: 12, BA: 8 });
    expect(ctx.configVersion).toBe(3);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('lets an override win over the pinned house rate', async () => {
    const ctx = await taxContextFor(
      { ...pinnedToV3, qaRegressionBufferPctOverride: 35 },
      client(),
    );
    expect(ctx.effective.QA).toBe(35);
    // The others still come from the pin, not from active v4.
    expect(ctx.effective.PM).toBe(12);
    expect(ctx.effective.BA).toBe(8);
  });

  it('reports the house rates alongside, so a reset can name what it reverts to', async () => {
    const ctx = await taxContextFor(
      { ...pinnedToV3, qaRegressionBufferPctOverride: 35 },
      client(),
    );
    expect(ctx.house).toEqual(V3);
    expect(ctx.overrides.qaRegressionBufferPctOverride).toBe(35);
  });
});

describe('latestTaxChanges', () => {
  const rows = vi.fn();
  const users = vi.fn();
  const provClient = () =>
    ({
      estimateTaxChange: { findMany: rows },
      user: { findMany: users },
    }) as unknown as Parameters<typeof latestTaxChanges>[1];

  beforeEach(() => {
    rows.mockReset();
    users.mockReset();
  });

  it('is empty when no buffer has ever been moved', async () => {
    rows.mockResolvedValue([]);
    await expect(latestTaxChanges('est-1', provClient())).resolves.toEqual({});
    expect(users).not.toHaveBeenCalled();
  });

  it('names the person and preformats the date', async () => {
    rows.mockResolvedValue([
      {
        role: 'QA',
        fromPct: 20,
        toPct: 35,
        createdAt: new Date('2026-09-08T11:00:00.000Z'),
        changedBy: 'user-1',
      },
    ]);
    users.mockResolvedValue([{ id: 'user-1', email: 'casey@codup.co' }]);

    const changes = await latestTaxChanges('est-1', provClient());
    expect(changes.QA).toEqual({
      fromPct: 20,
      toPct: 35,
      atLabel: '8 Sept 2026',
      by: 'casey@codup.co',
    });
  });

  /** One query, not one per role — `distinct` over a descending sort. */
  it('asks for the newest row per role in a single query', async () => {
    rows.mockResolvedValue([]);
    await latestTaxChanges('est-1', provClient());
    expect(rows).toHaveBeenCalledTimes(1);
    expect(rows).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { createdAt: 'desc' },
        distinct: ['role'],
      }),
    );
  });

  /** The record has to outlive the account, so a deleted user is not an error. */
  it('reports a change whose author no longer exists', async () => {
    rows.mockResolvedValue([
      {
        role: 'PM',
        fromPct: null,
        toPct: 5,
        createdAt: new Date('2026-09-08T11:00:00.000Z'),
        changedBy: 'gone',
      },
    ]);
    users.mockResolvedValue([]);
    const changes = await latestTaxChanges('est-1', provClient());
    expect(changes.PM?.by).toBeNull();
    expect(changes.PM?.toPct).toBe(5);
  });
});
