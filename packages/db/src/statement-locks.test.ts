import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { lockHistoryFor } from './ledger-locks.js';
import { reconcileStatements, replaceStatements } from './estimate-statements.js';
import {
  lockStatements,
  lockedStatementTextsMissing,
  resolveStatementTarget,
  statementLockStateFor,
  statementLocksOn,
  unlockStatements,
} from './statement-locks.js';
import { PrismaClient } from './generated/client/index.js';

/**
 * AEH-238. Locks on the narrative and the assumptions.
 *
 * Most of this mirrors `ledger-locks.test.ts`, because the mechanism is the
 * same one. What is NOT a mirror, and what the most valuable tests here are
 * about, is the text-identity trap:
 *
 *   `reconcileStatements` matches the submitted list to existing rows by TEXT.
 *   So rewording a locked statement is a delete plus a create, and the lock's
 *   foreign key cascades. If the save were allowed to run, the lock would
 *   disappear along with the row it was protecting — no error, no event, and a
 *   lock nobody removed. `lockedStatementTextsMissing` has to catch that BEFORE
 *   the reconcile, and the "reword" and "delete" cases below are why.
 *
 * Fixtures are namespaced and cleaned up by that namespace: vitest runs files
 * in parallel against one database.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const NS = `aeh238slock-${Math.random().toString(36).slice(2, 10)}`;
let userId = '';
let otherId = '';
let estimateId = '';
/** text -> statement id, for the ASSUMPTION list. */
const stmt: Record<string, string> = {};

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `${NS}@example.test`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
  const other = await db.user.create({
    data: { email: `${NS}-other@example.test`, hash: 'x', name: 'Dana', role: 'ESTIMATOR' },
  });
  otherId = other.id;

  const est = await db.estimate.create({
    data: {
      title: `${NS} estimate`,
      sowText: 'x',
      status: 'REVIEW',
      configVersion: 1,
      agentState: {},
      ownerId: userId,
    },
    select: { id: true },
  });
  estimateId = est.id;
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  await db.statementLock.deleteMany({ where: { estimateId } });
  await db.lockEvent.deleteMany({ where: { estimateId } });
  await db.estimateStatement.deleteMany({ where: { estimateId } });

  await db.$transaction(async (tx) => {
    await replaceStatements(tx, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Auth already exists.', 'The payment provider stays.', 'No data migration.'],
    });
    await replaceStatements(tx, {
      estimateId,
      kind: 'NARRATIVE',
      texts: ['A rebuild in three tranches.'],
    });
  });

  const rows = await db.estimateStatement.findMany({
    where: { estimateId, kind: 'ASSUMPTION' },
    select: { id: true, text: true },
  });
  for (const r of rows) stmt[r.text] = r.id;
});

const assumptionTexts = async (): Promise<string[]> =>
  (
    await db.estimateStatement.findMany({
      where: { estimateId, kind: 'ASSUMPTION' },
      orderBy: { order: 'asc' },
      select: { text: true },
    })
  ).map((r) => r.text);

describe('resolveStatementTarget', () => {
  it('resolves one statement, verified through the estimate', async () => {
    const ids = await resolveStatementTarget(db, estimateId, {
      scope: 'STATEMENT',
      id: stmt['Auth already exists.']!,
    });
    expect(ids).toEqual([stmt['Auth already exists.']]);
  });

  it('resolves a whole list, and only that list', async () => {
    const ids = await resolveStatementTarget(db, estimateId, {
      scope: 'STATEMENT_LIST',
      kind: 'ASSUMPTION',
    });
    expect(ids.sort()).toEqual(Object.values(stmt).sort());
  });

  it('refuses a statement belonging to another estimate', async () => {
    const other = await db.estimate.create({
      data: {
        title: `${NS} other`,
        sowText: 'x',
        status: 'REVIEW',
        configVersion: 1,
        agentState: {},
        ownerId: userId,
        statements: { create: [{ kind: 'ASSUMPTION', text: 'Theirs.', order: 0 }] },
      },
      select: { statements: { select: { id: true } } },
    });
    // A stale client's id must not reach another estimate's rows.
    expect(
      await resolveStatementTarget(db, estimateId, {
        scope: 'STATEMENT',
        id: other.statements[0]!.id,
      }),
    ).toEqual([]);
  });
});

describe('lockStatements', () => {
  it('freezes one line and records the event', async () => {
    const result = await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id: stmt['No data migration.']! },
      actorId: userId,
    });
    expect(result.locked).toEqual([stmt['No data migration.']]);

    const history = await lockHistoryFor(db, estimateId, {
      statementId: stmt['No data migration.']!,
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.kind).toBe('LOCKED');
    // The declaration is kept, not just the fact: "locked on its own" and
    // "locked with the whole list" are different statements about intent.
    expect(history[0]?.declaredScope).toBe('STATEMENT');
  });

  it('freezes a whole list without touching the other one', async () => {
    const result = await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT_LIST', kind: 'ASSUMPTION' },
      actorId: userId,
    });
    expect(result.locked).toHaveLength(3);

    const { byStatement, listsFullyLocked } = await statementLockStateFor(db, estimateId);
    expect(byStatement.size).toBe(3);
    expect([...listsFullyLocked]).toEqual(['ASSUMPTION']);
  });

  it('leaves a colleague’s lock alone and reports it', async () => {
    await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id: stmt['Auth already exists.']! },
      actorId: otherId,
    });
    const result = await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT_LIST', kind: 'ASSUMPTION' },
      actorId: userId,
    });
    // "You locked 2 of 3, Dana already had the other" is a different thing to
    // be told than "done".
    expect(result.locked).toHaveLength(2);
    expect(result.alreadyLocked.map((l) => l.lockedById)).toEqual([otherId]);
    expect((await statementLocksOn(db, [stmt['Auth already exists.']!])).get(
      stmt['Auth already exists.']!,
    )?.lockedById).toBe(otherId);
  });
});

describe('unlockStatements', () => {
  it('releases your own in one call', async () => {
    await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT_LIST', kind: 'ASSUMPTION' },
      actorId: userId,
    });
    const result = await unlockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT_LIST', kind: 'ASSUMPTION' },
      actorId: userId,
    });
    expect(result.unlocked).toHaveLength(3);
    expect(await db.statementLock.count({ where: { estimateId } })).toBe(0);
  });

  it('refuses a colleague’s without override, and records OVERRIDDEN with it', async () => {
    const id = stmt['The payment provider stays.']!;
    await lockStatements(db, { estimateId, target: { scope: 'STATEMENT', id }, actorId: otherId });

    const refused = await unlockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id },
      actorId: userId,
    });
    expect(refused.unlocked).toEqual([]);
    expect(refused.heldByOthers.map((l) => l.lockedById)).toEqual([otherId]);

    const overridden = await unlockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id },
      actorId: userId,
      override: true,
    });
    expect(overridden.unlocked).toEqual([id]);

    const history = await lockHistoryFor(db, estimateId, { statementId: id });
    expect(history.map((e) => e.kind)).toEqual(['LOCKED', 'OVERRIDDEN']);
    // Whose lock it was, so the record answers "who did somebody override".
    expect(history[1]?.priorHolderId).toBe(otherId);
  });

  it('releases your own even when a colleague holds another in the same list', async () => {
    await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id: stmt['Auth already exists.']! },
      actorId: otherId,
    });
    await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id: stmt['No data migration.']! },
      actorId: userId,
    });

    const result = await unlockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT_LIST', kind: 'ASSUMPTION' },
      actorId: userId,
    });
    // A partial release, not a refusal: freeing your own should not fail
    // because somebody holds another.
    expect(result.unlocked).toEqual([stmt['No data migration.']]);
    expect(result.heldByOthers).toHaveLength(1);
  });
});

describe('statementLockStateFor', () => {
  it('does not call an empty list fully locked', async () => {
    await db.estimateStatement.deleteMany({ where: { estimateId, kind: 'NARRATIVE' } });
    const { listsFullyLocked } = await statementLockStateFor(db, estimateId);
    // Vacuously true of nothing, and reading it as locked would freeze a list
    // nobody had written yet.
    expect(listsFullyLocked.has('NARRATIVE')).toBe(false);
  });

  it('reports a list as fully locked once every line is, however it happened', async () => {
    // One at a time rather than the list declaration: the two ways of arriving
    // here say the same thing and must be indistinguishable.
    for (const id of Object.values(stmt)) {
      await lockStatements(db, { estimateId, target: { scope: 'STATEMENT', id }, actorId: userId });
    }
    const { listsFullyLocked } = await statementLockStateFor(db, estimateId);
    expect(listsFullyLocked.has('ASSUMPTION')).toBe(true);
  });
});

describe('lockedStatementTextsMissing', () => {
  it('passes a save that keeps every locked line verbatim', async () => {
    await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id: stmt['Auth already exists.']! },
      actorId: userId,
    });
    // A line ADDED, and an unlocked one reworded. Neither touches the lock.
    expect(
      await lockedStatementTextsMissing(db, {
        estimateId,
        kind: 'ASSUMPTION',
        texts: [
          'Brand new.',
          'Auth already exists.',
          'The payment provider stays, on its current plan.',
          'No data migration.',
        ],
      }),
    ).toEqual([]);
  });

  it('catches a REWORDED locked line — the case the cascade would have hidden', async () => {
    const id = stmt['Auth already exists.']!;
    await lockStatements(db, { estimateId, target: { scope: 'STATEMENT', id }, actorId: userId });

    const missing = await lockedStatementTextsMissing(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: [
        'Auth already exists in a form we can reuse.',
        'The payment provider stays.',
        'No data migration.',
      ],
    });
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ statementId: id, lockedById: userId });
  });

  it('catches a DELETED locked line', async () => {
    const id = stmt['No data migration.']!;
    await lockStatements(db, { estimateId, target: { scope: 'STATEMENT', id }, actorId: userId });
    const missing = await lockedStatementTextsMissing(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Auth already exists.', 'The payment provider stays.'],
    });
    expect(missing.map((m) => m.statementId)).toEqual([id]);
  });

  it('ignores locks in the other list', async () => {
    const narrative = await db.estimateStatement.findFirstOrThrow({
      where: { estimateId, kind: 'NARRATIVE' },
      select: { id: true },
    });
    await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT', id: narrative.id },
      actorId: userId,
    });
    // Saving the assumptions must not be refused by a locked narrative line.
    expect(
      await lockedStatementTextsMissing(db, {
        estimateId,
        kind: 'ASSUMPTION',
        texts: ['Auth already exists.'],
      }),
    ).toEqual([]);
  });

  it('needs identical text back TWICE when two identical lines are locked', async () => {
    await db.estimateStatement.deleteMany({ where: { estimateId, kind: 'ASSUMPTION' } });
    await db.$transaction(async (tx) => {
      await replaceStatements(tx, {
        estimateId,
        kind: 'ASSUMPTION',
        texts: ['Same wording.', 'Same wording.'],
      });
    });
    await lockStatements(db, {
      estimateId,
      target: { scope: 'STATEMENT_LIST', kind: 'ASSUMPTION' },
      actorId: userId,
    });

    // Two specialists really do collate the same assumption, so the check is a
    // multiset: one copy back is one copy short.
    expect(
      await lockedStatementTextsMissing(db, {
        estimateId,
        kind: 'ASSUMPTION',
        texts: ['Same wording.'],
      }),
    ).toHaveLength(1);
    expect(
      await lockedStatementTextsMissing(db, {
        estimateId,
        kind: 'ASSUMPTION',
        texts: ['Same wording.', 'Same wording.'],
      }),
    ).toEqual([]);
  });

  it('proves the trap is real: an unguarded reconcile DOES destroy the lock', async () => {
    const id = stmt['Auth already exists.']!;
    await lockStatements(db, { estimateId, target: { scope: 'STATEMENT', id }, actorId: userId });

    // Called WITHOUT the guard, exactly as the action would if somebody removed
    // it. This is what the guard is standing in front of, asserted rather than
    // described — so a later change that drops the guard fails a test that says
    // why.
    await reconcileStatements(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Auth already exists, and is reusable.', 'The payment provider stays.'],
    });

    expect(await db.statementLock.count({ where: { statementId: id } })).toBe(0);
    expect(await assumptionTexts()).toEqual([
      'Auth already exists, and is reusable.',
      'The payment provider stays.',
    ]);
  });
});
