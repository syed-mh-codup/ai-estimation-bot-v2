import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * Statement locks enforced THROUGH the server actions — AEH-238.
 *
 * The sibling of `lock-enforcement-db.test.ts`, and it exists for the same
 * reason: `packages/db/src/statement-locks.test.ts` proves the lock logic, and
 * this proves the wiring. A refactor that drops one guard call leaves that
 * logic perfectly correct, every one of its tests green, and the lock silently
 * unenforced.
 *
 * Two of these matter more than the rest.
 *
 * `updateAssumptions` must refuse a save that rewords a locked line. Not
 * because rewording is worse than deleting, but because of HOW the save works:
 * `reconcileStatements` matches by text, so a reword is a delete plus a create
 * and the lock's foreign key cascades. Without the guard the save succeeds and
 * the lock disappears — no error, no event, and a lock nobody removed.
 *
 * And a re-run must be refused while any statement is locked, which is a hole
 * that is easy to miss: `assertEstimateUnlockedForRerun` was about line items,
 * and a run calls `replaceStatements`, which deletes both lists wholesale.
 *
 * Fixtures are namespaced and cleaned up by that namespace. Vitest runs files
 * in parallel against one database, so a broad `deleteMany` here would break
 * unrelated files — see the local-dev-env-traps memory.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/rbac', () => ({ requireUser: vi.fn() }));
vi.mock('next/server', () => ({ after: (fn: () => unknown) => fn() }));
vi.mock('@/lib/email', () => ({ sendCustodyAssignedEmail: vi.fn() }));

import { prisma, replaceStatements } from '@repo/db';
import { auth } from '@/lib/auth';
import { requireUser } from '@/lib/rbac';
import { assertEstimateUnlockedForRerun } from '@/lib/lock-guards';
import { updateAssumptions, updateNarrative } from './actions';
import { lockStatementRegion, unlockStatementRegion } from './lock-actions';

const NS = `aeh238stmtlock-${Math.random().toString(36).slice(2, 10)}`;
const CONFIG_VERSION = 850_000 + Math.floor(Math.random() * 40_000);

const ALICE = `${NS}-alice`;
const BOB = `${NS}-bob`;
const EST = `${NS}-est`;

/** text -> id, for the ASSUMPTION list. */
let ids: Record<string, string> = {};

const SEEDED = ['Auth already exists.', 'The payment provider stays.', 'No data migration.'];

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
      pmCommunicationTaxPct: 12,
      baCommunicationTaxPct: 8,
      qaRegressionBufferPct: 20,
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
});

afterAll(async () => {
  await prisma.lockEvent.deleteMany({ where: { estimateId: EST } });
  await prisma.statementLock.deleteMany({ where: { estimateId: EST } });
  await prisma.estimateStatement.deleteMany({ where: { estimateId: EST } });
  await prisma.estimate.deleteMany({ where: { id: EST } });
  await prisma.estimationConfig.deleteMany({ where: { version: CONFIG_VERSION } });
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
});

beforeEach(async () => {
  actingAs(ALICE);
  await prisma.statementLock.deleteMany({ where: { estimateId: EST } });
  await prisma.lockEvent.deleteMany({ where: { estimateId: EST } });
  await prisma.estimateStatement.deleteMany({ where: { estimateId: EST } });

  await prisma.$transaction(async (tx) => {
    await replaceStatements(tx, { estimateId: EST, kind: 'ASSUMPTION', texts: SEEDED });
    await replaceStatements(tx, {
      estimateId: EST,
      kind: 'NARRATIVE',
      texts: ['A rebuild in three tranches.'],
    });
  });

  const rows = await prisma.estimateStatement.findMany({
    where: { estimateId: EST, kind: 'ASSUMPTION' },
    select: { id: true, text: true },
  });
  ids = Object.fromEntries(rows.map((r) => [r.text, r.id]));
});

const assumptionsNow = async (): Promise<string[]> =>
  (
    await prisma.estimateStatement.findMany({
      where: { estimateId: EST, kind: 'ASSUMPTION' },
      orderBy: { order: 'asc' },
      select: { text: true },
    })
  ).map((r) => r.text);

/** Freeze one assumption, as Alice. */
const lockOne = (text: string) =>
  lockStatementRegion(EST, { scope: 'STATEMENT', id: ids[text]! });

describe('a frozen statement refuses the saves that would change it', () => {
  it('refuses a REWORDED locked line, and names who holds the lock', async () => {
    await lockOne('Auth already exists.');
    await expect(
      updateAssumptions(EST, [
        'Auth already exists in a form we can reuse.',
        'The payment provider stays.',
        'No data migration.',
      ]),
    ).rejects.toThrow(/locked assumption/i);
    // Named, not just refused: a bare "no" sends somebody hunting.
    await expect(
      updateAssumptions(EST, ['Auth already exists in a form we can reuse.']),
    ).rejects.toThrow(/by you/);
    // And nothing was written.
    expect(await assumptionsNow()).toEqual(SEEDED);
  });

  it('refuses a DELETED locked line', async () => {
    await lockOne('No data migration.');
    await expect(
      updateAssumptions(EST, ['Auth already exists.', 'The payment provider stays.']),
    ).rejects.toThrow(/would be reworded or removed/);
    expect(await assumptionsNow()).toEqual(SEEDED);
  });

  it('names the colleague when the lock is theirs', async () => {
    actingAs(BOB);
    await lockOne('Auth already exists.');
    actingAs(ALICE);
    await expect(updateAssumptions(EST, ['Reworded.'])).rejects.toThrow(/by Bob/);
  });

  it('leaves the lock standing after a refusal', async () => {
    await lockOne('Auth already exists.');
    await expect(updateAssumptions(EST, ['Reworded.'])).rejects.toThrow();
    // THE assertion this file exists for. Without the guard the save would have
    // succeeded and the cascade would have taken the lock with it.
    expect(await prisma.statementLock.count({ where: { estimateId: EST } })).toBe(1);
  });
});

describe('what a statement lock deliberately does NOT stop', () => {
  it('allows a line to be ADDED while another is locked', async () => {
    await lockOne('Auth already exists.');
    await updateAssumptions(EST, ['Brand new.', ...SEEDED]);
    expect(await assumptionsNow()).toEqual(['Brand new.', ...SEEDED]);
    // A lock says one sentence is settled. It does not close the list.
    expect(await prisma.statementLock.count({ where: { estimateId: EST } })).toBe(1);
  });

  it('allows an UNLOCKED line to be reworded', async () => {
    await lockOne('Auth already exists.');
    await updateAssumptions(EST, [
      'Auth already exists.',
      'The payment provider stays, on its current plan.',
      'No data migration.',
    ]);
    expect(await assumptionsNow()).toEqual([
      'Auth already exists.',
      'The payment provider stays, on its current plan.',
      'No data migration.',
    ]);
  });

  it('does not let a locked assumption block a narrative save', async () => {
    await lockOne('Auth already exists.');
    await updateNarrative(EST, ['A rebuild, in two tranches instead of three.']);
    expect(
      (
        await prisma.estimateStatement.findMany({
          where: { estimateId: EST, kind: 'NARRATIVE' },
          select: { text: true },
        })
      ).map((r) => r.text),
    ).toEqual(['A rebuild, in two tranches instead of three.']);
  });
});

describe('locking and releasing through the actions', () => {
  it('returns the whole lock state, not a patch', async () => {
    const result = await lockOne('Auth already exists.');
    expect(result.changed).toBe(1);
    expect(Object.keys(result.state.statements)).toEqual([ids['Auth already exists.']]);
    expect(result.state.listsFullyLocked).toEqual([]);
  });

  it('reports a whole list as locked once every line is', async () => {
    const result = await lockStatementRegion(EST, {
      scope: 'STATEMENT_LIST',
      kind: 'ASSUMPTION',
    });
    expect(result.changed).toBe(3);
    expect(result.state.listsFullyLocked).toEqual(['ASSUMPTION']);
  });

  it('refuses a colleague’s lock without override, and says who to confirm against', async () => {
    actingAs(BOB);
    await lockOne('Auth already exists.');
    actingAs(ALICE);

    const refused = await unlockStatementRegion(EST, {
      scope: 'STATEMENT',
      id: ids['Auth already exists.']!,
    });
    expect(refused.changed).toBe(0);
    expect(refused.notice).toMatch(/locked by Bob/);
    expect(refused.notice).toMatch(/Confirm to override/);

    const overridden = await unlockStatementRegion(
      EST,
      { scope: 'STATEMENT', id: ids['Auth already exists.']! },
      true,
    );
    expect(overridden.changed).toBe(1);
    expect(overridden.state.statements).toEqual({});
  });
});

describe('a re-run is refused while a statement is locked', () => {
  it('names statements as well as lines', async () => {
    await lockOne('Auth already exists.');
    // A run calls `replaceStatements`, which deletes both lists wholesale
    // before writing the new ones — so a locked assumption is destroyed by a
    // re-run exactly as surely as a locked line item.
    await expect(assertEstimateUnlockedForRerun(EST)).rejects.toThrow(/1 statement/);
    await expect(assertEstimateUnlockedForRerun(EST)).rejects.toThrow(
      /both statement lists from scratch/,
    );
  });

  it('allows a re-run when nothing is locked', async () => {
    await expect(assertEstimateUnlockedForRerun(EST)).resolves.toBeUndefined();
  });
});
