import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * Locks enforced THROUGH the server actions, against a real database — AEH-238.
 *
 * `packages/db/src/ledger-locks.test.ts` covers the lock logic itself. This
 * covers the wiring, which is a different and more fragile thing: that every
 * guarded action actually calls its guard. A refactor that drops one of those
 * calls leaves the lock logic perfectly correct, every one of those 15 tests
 * green, and the lock silently unenforced. This file is what fails instead.
 *
 * So the assertions here are deliberately about the ACTION refusing, not about
 * the guard function returning — and one of them asserts the opposite, because
 * `moveMenuItem` is exempt on purpose: placement is presentational, and a
 * reviewer tidying the board is not editing settled work. That exemption is
 * load-bearing (it is why locks are materialised to rows rather than tested
 * against section membership), so it is pinned here rather than left to be
 * "fixed" later by someone adding the missing guard.
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
import { auth } from '@/lib/auth';
import { requireUser } from '@/lib/rbac';
import {
  createLineItem,
  deleteLineItem,
  deleteMenuItem,
  moveMenuItem,
  renameMenuItem,
  setEstimateTaxPct,
  setItemEnabled,
  setLineItemSide,
  updateLineItem,
} from './actions';
import { lockRegion, unlockRegion } from './lock-actions';

const NS = `aeh238-${Math.random().toString(36).slice(2, 10)}`;
const CONFIG_VERSION = 800_000 + Math.floor(Math.random() * 90_000);

const ALICE = `${NS}-alice`;
const BOB = `${NS}-bob`;
const EST = `${NS}-est`;
const CARD = `${NS}-card`;
const OTHER_CARD = `${NS}-other`;
const SECTION = `${NS}-section`;

let devLineId = '';
let qaLineId = '';

/**
 * Who the mocked session says is calling.
 *
 * Both are stubbed because the actions do not agree on which to use, and that
 * disagreement is meaningful: `moveMenuItem` is the one mutation with no lock
 * guard, so it never needed the caller's identity and still reads `auth()`
 * through `requireSession`. Everything guarded reads `requireUser`, because a
 * refusal has to be able to say "by you".
 */
function actingAs(userId: string): void {
  (requireUser as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: userId,
    role: 'ESTIMATOR',
  });
  (auth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: userId, role: 'ESTIMATOR' },
  });
}

beforeAll(async () => {
  actingAs(ALICE);

  await prisma.user.createMany({
    data: [
      { id: ALICE, email: `${NS}-alice@example.test`, name: 'Alice', hash: 'x' },
      { id: BOB, email: `${NS}-bob@example.test`, name: 'Bob', hash: 'x' },
    ],
  });

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
      ownerId: ALICE,
      configVersion: CONFIG_VERSION,
      status: 'REVIEW',
    },
  });

  await prisma.estimateSection.create({
    data: { id: SECTION, estimateId: EST, title: 'Phase one', order: 0 },
  });

  const card = await prisma.menuItem.create({
    data: {
      id: CARD,
      estimateId: EST,
      taxonomyKey: `${NS}.work`,
      title: 'Checkout',
      sectionId: SECTION,
      lineItems: {
        create: [
          { role: 'DEV', title: 'dev work', baseHours: 4, taxedHours: 4 },
          { role: 'QA', title: 'qa work', baseHours: 2, taxedHours: 2.4 },
        ],
      },
    },
    select: { lineItems: { select: { id: true, role: true } } },
  });
  devLineId = card.lineItems.find((l) => l.role === 'DEV')!.id;
  qaLineId = card.lineItems.find((l) => l.role === 'QA')!.id;

  await prisma.menuItem.create({
    data: {
      id: OTHER_CARD,
      estimateId: EST,
      taxonomyKey: `${NS}.other`,
      title: 'Reports',
      sectionId: SECTION,
      lineItems: { create: [{ role: 'DEV', title: 'other dev', baseHours: 1, taxedHours: 1 }] },
    },
  });
});

afterAll(async () => {
  await prisma.lockEvent.deleteMany({ where: { estimateId: EST } });
  await prisma.ledgerLock.deleteMany({ where: { estimateId: EST } });
  await prisma.estimateTaxChange.deleteMany({ where: { estimateId: EST } });
  await prisma.roleLineItem.deleteMany({ where: { menuItem: { estimateId: EST } } });
  await prisma.menuItem.deleteMany({ where: { estimateId: EST } });
  await prisma.estimateSection.deleteMany({ where: { estimateId: EST } });
  await prisma.estimate.deleteMany({ where: { id: EST } });
  await prisma.estimationConfig.deleteMany({ where: { version: CONFIG_VERSION } });
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
});

beforeEach(async () => {
  actingAs(ALICE);
  await prisma.ledgerLock.deleteMany({ where: { estimateId: EST } });
  await prisma.lockEvent.deleteMany({ where: { estimateId: EST } });
  await prisma.menuItem.update({ where: { id: CARD }, data: { sectionId: SECTION, enabled: true } });
});

/** Freeze just the DEV row on CARD, as Alice. */
async function lockDev(): Promise<void> {
  await lockRegion(EST, { scope: 'LINE', id: devLineId }, []);
}

describe('a frozen row refuses every action that would change it', () => {
  it('refuses an hours edit, and names who holds the lock', async () => {
    await lockDev();
    await expect(updateLineItem(devLineId, { baseHours: 9 })).rejects.toThrow(/locked/i);
    // Named, not just refused: a bare "no" sends someone hunting through rows.
    await expect(updateLineItem(devLineId, { baseHours: 9 })).rejects.toThrow(/by you/i);
    // And the stored number really did not move.
    const row = await prisma.roleLineItem.findUniqueOrThrow({ where: { id: devLineId } });
    expect(row.baseHours).toBe(4);
  });

  it('refuses a description edit', async () => {
    await lockDev();
    await expect(updateLineItem(devLineId, { title: 'rewritten' })).rejects.toThrow(/locked/i);
  });

  it('refuses a side-tag change, which is part of the description', async () => {
    await lockDev();
    await expect(
      setLineItemSide(devLineId, { touchesFrontend: true, touchesBackend: false }),
    ).rejects.toThrow(/locked/i);
  });

  it('refuses deleting the row', async () => {
    await lockDev();
    await expect(deleteLineItem(devLineId)).rejects.toThrow(/locked/i);
    expect(await prisma.roleLineItem.count({ where: { id: devLineId } })).toBe(1);
  });

  it('leaves an unlocked row on the same card fully editable', async () => {
    await lockDev();
    // The envelope does not cascade: freezing DEV says nothing about QA.
    const updated = await updateLineItem(qaLineId, { baseHours: 3 });
    expect(updated.baseHours).toBe(3);
  });
});

describe('a frozen row constrains its card', () => {
  it('refuses a new line of the frozen role, because it moves that slice’s total', async () => {
    await lockDev();
    await expect(createLineItem(CARD, 'DEV')).rejects.toThrow(/locked/i);
    // A different role is unaffected.
    const created = await createLineItem(CARD, 'BA');
    expect(created.id).toBeTruthy();
    await prisma.roleLineItem.delete({ where: { id: created.id } });
  });

  it('refuses deleting the card, which would take the locked row with it', async () => {
    await lockDev();
    await expect(deleteMenuItem(CARD)).rejects.toThrow(/locked/i);
    expect(await prisma.menuItem.count({ where: { id: CARD } })).toBe(1);
  });

  it('refuses switching the card off, which removes those hours from every total', async () => {
    await lockDev();
    await expect(setItemEnabled(CARD, false)).rejects.toThrow(/locked/i);
    const card = await prisma.menuItem.findUniqueOrThrow({ where: { id: CARD } });
    expect(card.enabled).toBe(true);
  });

  it('allows a rename while only one role is frozen, and refuses it once all are', async () => {
    await lockDev();
    // A title describes the whole card, so one frozen slice says nothing about it.
    await renameMenuItem(CARD, 'Checkout v2');
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: CARD } })).title).toBe(
      'Checkout v2',
    );

    await lockRegion(EST, { scope: 'CARD', id: CARD }, ['DEV', 'QA', 'PM', 'BA']);
    await expect(renameMenuItem(CARD, 'Checkout v3')).rejects.toThrow(/locked/i);
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: CARD } })).title).toBe(
      'Checkout v2',
    );
  });

  it('still allows the card to be moved — placement is deliberately free', async () => {
    await lockRegion(EST, { scope: 'CARD', id: CARD }, ['DEV', 'QA', 'PM', 'BA']);
    // Not an oversight. This exemption is why locks are pinned to rows instead
    // of being tested against section membership: if a lock were evaluated
    // live, this call would be a way to escape one.
    await moveMenuItem(CARD, null, [CARD, OTHER_CARD]);
    const card = await prisma.menuItem.findUniqueOrThrow({ where: { id: CARD } });
    expect(card.sectionId).toBeNull();
    // ...and the lock survived the move.
    expect(await prisma.ledgerLock.count({ where: { lineItemId: devLineId } })).toBe(1);
  });
});

describe('a frozen role refuses a buffer move', () => {
  it('refuses because a buffer change re-taxes every row of the role', async () => {
    await lockRegion(EST, { scope: 'LINE', id: qaLineId }, []);
    await expect(setEstimateTaxPct(EST, 'QA', 35)).rejects.toThrow(/locked/i);
    // The buffer really did not move.
    const est = await prisma.estimate.findUniqueOrThrow({ where: { id: EST } });
    expect(est.qaRegressionBufferPctOverride).toBeNull();
  });

  it('allows a buffer move on a role with nothing frozen', async () => {
    await lockRegion(EST, { scope: 'LINE', id: qaLineId }, []);
    const res = await setEstimateTaxPct(EST, 'PM', 30);
    expect(res.effective.PM).toBe(30);
    await setEstimateTaxPct(EST, 'PM', null);
  });
});

describe('overriding somebody else’s lock', () => {
  it('leaves it standing without override, and releases it with one', async () => {
    actingAs(BOB);
    await lockRegion(EST, { scope: 'LINE', id: devLineId }, []);

    actingAs(ALICE);
    const refused = await unlockRegion(EST, { scope: 'LINE', id: devLineId }, [], false);
    expect(refused.changed).toBe(0);
    expect(refused.notice).toMatch(/Bob/);
    // Still enforced, so Alice still cannot edit.
    await expect(updateLineItem(devLineId, { baseHours: 9 })).rejects.toThrow(/Bob/);

    const overridden = await unlockRegion(EST, { scope: 'LINE', id: devLineId }, [], true);
    expect(overridden.changed).toBe(1);
    // Recorded as an override, naming both parties — this is the event an audit
    // is looking for, which is why it is its own kind rather than a flag.
    const events = await prisma.lockEvent.findMany({
      where: { estimateId: EST, lineItemId: devLineId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.kind)).toEqual(['LOCKED', 'OVERRIDDEN']);
    expect(events.at(-1)?.actorId).toBe(ALICE);
    expect(events.at(-1)?.priorHolderId).toBe(BOB);

    // And the edit now goes through.
    const updated = await updateLineItem(devLineId, { baseHours: 9 });
    expect(updated.baseHours).toBe(9);
    await updateLineItem(devLineId, { baseHours: 4 });
  });
});
