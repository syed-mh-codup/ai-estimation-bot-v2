import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * `setEstimateTaxPct` against a real database.
 *
 * The sibling `buffer-override.test.ts` mocks Prisma and pins the decisions;
 * this one exists because a mock cannot fail the way Prisma can. Four query
 * shapes here have no other coverage: the nested relation filter
 * (`menuItem: { estimateId, overhead: false }`) that keeps overhead cards out
 * of the recompute, the `{ ...RATE_SELECT, overheadRatesStale: true }` select,
 * `distinct: ['role']` under a descending sort, and the whole thing running
 * inside one interactive transaction.
 *
 * The pinned config here is deliberately `active: false`. That is the
 * acceptance criterion stated as a fixture: the rates have to come from the
 * version the estimate names, and a config nothing has activated is the
 * clearest possible proof that "whichever row is active" is not what is being
 * read.
 *
 * Fixtures are namespaced and cleaned up by that namespace. Vitest runs files
 * in parallel against one shared database, so a broad `deleteMany` here would
 * break unrelated files — see the local-dev-env-traps memory.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ requireUser: vi.fn() }));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }));
vi.mock('@/lib/email', () => ({ sendCustodyAssignedEmail: vi.fn() }));

import { prisma } from '@repo/db';
import { requireUser } from '@/lib/rbac';
import { latestTaxChanges, taxContextForEstimate } from '@/lib/estimate-tax';
import { setEstimateTaxPct } from './actions';

const NS = `aeh335-${Math.random().toString(36).slice(2, 10)}`;
// Well clear of any seeded or test-created config version.
const CONFIG_VERSION = 900_000 + Math.floor(Math.random() * 90_000);

const USER = `${NS}-user`;
const EST = `${NS}-est`;
const CARD = `${NS}-card`;
const OVERHEAD = `${NS}-overhead`;

beforeAll(async () => {
  (requireUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: USER,
    role: 'ESTIMATOR',
  });

  await prisma.user.create({
    data: { id: USER, email: `${NS}@example.test`, name: 'Buffer Fixture', hash: 'x' },
  });

  // active: false on purpose — see the note at the top of this file.
  await prisma.estimationConfig.create({
    data: {
      version: CONFIG_VERSION,
      active: false,
      complexityRules: {},
      pmCommunicationTaxPct: 12,
      baCommunicationTaxPct: 8,
      qaRegressionBufferPct: 20,
      infraBaseline: {},
    },
  });

  await prisma.estimate.create({
    data: {
      id: EST,
      title: `${NS} estimate`,
      sowText: 'fixture',
      agentState: {},
      ownerId: USER,
      configVersion: CONFIG_VERSION,
    },
  });

  // Ordinary work: three QA lines, taxed at the pinned 20%.
  await prisma.menuItem.create({
    data: {
      id: CARD,
      estimateId: EST,
      taxonomyKey: `${NS}.work`,
      title: 'Real work',
      overhead: false,
      lineItems: {
        create: [
          { role: 'QA', title: '2h', baseHours: 2, taxedHours: 2.5 },
          { role: 'QA', title: '3h', baseHours: 3, taxedHours: 3.5 },
          { role: 'PM', title: 'pm', baseHours: 4, taxedHours: 4.5 },
        ],
      },
    },
  });

  // A delivery-overhead card: its hours are already a percentage OF taxed
  // hours, so the recompute must not come near it.
  await prisma.menuItem.create({
    data: {
      id: OVERHEAD,
      estimateId: EST,
      taxonomyKey: 'process.manual-e2e',
      title: 'Manual End-to-End Passes',
      injected: true,
      overhead: true,
      lineItems: { create: [{ role: 'QA', title: 'e2e', baseHours: 9, taxedHours: 9 }] },
    },
  });
});

afterAll(async () => {
  await prisma.estimateTaxChange.deleteMany({ where: { estimateId: EST } });
  await prisma.roleLineItem.deleteMany({ where: { menuItem: { estimateId: EST } } });
  await prisma.menuItem.deleteMany({ where: { estimateId: EST } });
  await prisma.estimate.deleteMany({ where: { id: EST } });
  await prisma.estimationConfig.deleteMany({ where: { version: CONFIG_VERSION } });
  await prisma.user.deleteMany({ where: { id: USER } });
});

const qaHours = async () =>
  (
    await prisma.roleLineItem.findMany({
      where: { role: 'QA', menuItem: { estimateId: EST, overhead: false } },
      orderBy: { baseHours: 'asc' },
      select: { baseHours: true, taxedHours: true, provenance: true },
    })
  ).map((l) => ({ ...l }));

describe('setEstimateTaxPct against a real database', () => {
  it('reads the rates off the pinned config even though it is not active', async () => {
    const ctx = await taxContextForEstimate(EST);
    expect(ctx.configVersion).toBe(CONFIG_VERSION);
    expect(ctx.effective).toEqual({ DEV: 0, QA: 20, PM: 12, BA: 8 });
  });

  it('re-taxes the role it was given, leaves the other role alone', async () => {
    const pmBefore = await prisma.roleLineItem.findFirst({
      where: { role: 'PM', menuItemId: CARD },
      select: { taxedHours: true },
    });

    const res = await setEstimateTaxPct(EST, 'QA', 30);

    // 2h -> 2.6 -> snaps to 2.5 (unmoved); 3h -> 3.9 -> snaps to 4.
    expect(await qaHours()).toEqual([
      { baseHours: 2, taxedHours: 2.5, provenance: 'CREW' },
      { baseHours: 3, taxedHours: 4, provenance: 'CREW' },
    ]);
    // Only the line that actually moved comes back.
    expect(res.lineItems).toHaveLength(1);
    expect(res.effective.QA).toBe(30);

    const pmAfter = await prisma.roleLineItem.findFirst({
      where: { role: 'PM', menuItemId: CARD },
      select: { taxedHours: true },
    });
    expect(pmAfter?.taxedHours).toBe(pmBefore?.taxedHours);
  });

  it('never re-taxes a delivery-overhead card', async () => {
    const overhead = await prisma.roleLineItem.findFirst({
      where: { menuItemId: OVERHEAD },
      select: { baseHours: true, taxedHours: true },
    });
    // Still base == taxed. Taxing it would have compounded a percentage.
    expect(overhead).toEqual({ baseHours: 9, taxedHours: 9 });
  });

  it('marks the overhead cards stale, because this estimate has one', async () => {
    const est = await prisma.estimate.findUniqueOrThrow({
      where: { id: EST },
      select: { overheadRatesStale: true, qaRegressionBufferPctOverride: true },
    });
    expect(est.overheadRatesStale).toBe(true);
    expect(est.qaRegressionBufferPctOverride).toBe(30);
  });

  it('records the change, and reads it back with the person who made it', async () => {
    const changes = await latestTaxChanges(EST);
    expect(changes.QA).toMatchObject({ fromPct: null, toPct: 30, by: `${NS}@example.test` });
    expect(changes.QA?.atLabel).toMatch(/\d{4}$/);
  });

  it('is idempotent — setting the same figure again writes nothing new', async () => {
    const before = await qaHours();
    const res = await setEstimateTaxPct(EST, 'QA', 30);
    expect(res.lineItems).toHaveLength(0);
    expect(await qaHours()).toEqual(before);
    expect(await prisma.estimateTaxChange.count({ where: { estimateId: EST } })).toBe(1);
  });

  it('goes back to the pinned house rate when reset to inherit', async () => {
    const res = await setEstimateTaxPct(EST, 'QA', null);
    expect(res.effective.QA).toBe(20);
    expect(await qaHours()).toEqual([
      { baseHours: 2, taxedHours: 2.5, provenance: 'CREW' },
      { baseHours: 3, taxedHours: 3.5, provenance: 'CREW' },
    ]);
    const est = await prisma.estimate.findUniqueOrThrow({
      where: { id: EST },
      select: { qaRegressionBufferPctOverride: true },
    });
    expect(est.qaRegressionBufferPctOverride).toBeNull();
  });

  it('keeps the newest change per role when a role has moved twice', async () => {
    const changes = await latestTaxChanges(EST);
    expect(changes.QA).toMatchObject({ fromPct: 30, toPct: null });
    expect(await prisma.estimateTaxChange.count({ where: { estimateId: EST } })).toBe(2);
  });

  it('refuses once the estimate is finalised', async () => {
    await prisma.estimate.update({ where: { id: EST }, data: { status: 'FINALISED' } });
    await expect(setEstimateTaxPct(EST, 'QA', 40)).rejects.toThrow(/finalised/i);
    await prisma.estimate.update({ where: { id: EST }, data: { status: 'DRAFT' } });
  });
});
