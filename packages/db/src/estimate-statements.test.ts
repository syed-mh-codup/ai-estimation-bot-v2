import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appendStatement,
  loadStatements,
  loadStatementTexts,
  reconcileStatements,
  replaceStatements,
} from './estimate-statements.js';
import { PrismaClient } from './generated/client/index.js';

/**
 * AEH-238. The narrative and the assumptions as addressable rows.
 *
 * The whole reason these left `String[]` was identity, so identity is what
 * these tests are about — and the case that matters most is inserting a line at
 * the TOP of a list. Under the array there was nothing to preserve. Under a
 * naive row implementation that matched by position, every line below the
 * insertion would look changed, get rewritten, and be restamped as somebody's
 * hand edit — destroying exactly the provenance signal the column exists for.
 *
 * So `reconcileStatements` matches by TEXT. The tests below are mostly that
 * distinction, from several angles.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const NS = `aeh238stmt-${Math.random().toString(36).slice(2, 10)}`;
let userId = '';
let estimateId = '';

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `${NS}@example.test`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
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
  await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  await db.estimateStatement.deleteMany({ where: { estimateId } });
});

/** Seed one kind, as a run would. */
async function seed(texts: string[]): Promise<void> {
  await db.$transaction(async (tx) => {
    await replaceStatements(tx, { estimateId, kind: 'ASSUMPTION', texts });
  });
}

const assumptions = async () => (await loadStatements(db, estimateId)).assumptions;

describe('replaceStatements', () => {
  it('writes a run’s list in order, as the crew’s', async () => {
    await seed(['Auth already exists.', 'The payment provider stays.']);
    const rows = await assumptions();
    expect(rows.map((r) => r.text)).toEqual(['Auth already exists.', 'The payment provider stays.']);
    expect(rows.map((r) => r.order)).toEqual([0, 1]);
    // The Architect and the specialists produce these, so CREW is the honest
    // default rather than a guess.
    expect(rows.every((r) => r.provenance === 'CREW')).toBe(true);
  });

  it('drops blank entries rather than storing an empty line', async () => {
    await seed(['Real.', '   ', '']);
    expect((await assumptions()).map((r) => r.text)).toEqual(['Real.']);
  });

  it('leaves the other kind alone', async () => {
    await db.$transaction(async (tx) => {
      await replaceStatements(tx, { estimateId, kind: 'NARRATIVE', texts: ['A rebuild.'] });
      await replaceStatements(tx, { estimateId, kind: 'ASSUMPTION', texts: ['Auth exists.'] });
      await replaceStatements(tx, { estimateId, kind: 'ASSUMPTION', texts: ['Auth is new.'] });
    });
    const both = await loadStatementTexts(db, estimateId);
    expect(both).toEqual({ narrative: ['A rebuild.'], assumptions: ['Auth is new.'] });
  });
});

describe('reconcileStatements', () => {
  it('keeps every id when a line is inserted at the top', async () => {
    await seed(['First.', 'Second.']);
    const before = await assumptions();

    const after = await reconcileStatements(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Brand new.', 'First.', 'Second.'],
    });

    // THE case this table exists for. Position matching would have called all
    // three rows changed, rewritten them, and restamped the crew's two as a
    // human's — losing the one distinction the provenance column carries.
    const keptIds = after.filter((a) => a.text !== 'Brand new.').map((a) => a.id);
    expect(keptIds.sort()).toEqual(before.map((b) => b.id).sort());
    expect(after.map((a) => a.text)).toEqual(['Brand new.', 'First.', 'Second.']);
    expect(after.map((a) => a.order)).toEqual([0, 1, 2]);
    // Only the new line is the human's.
    expect(after.find((a) => a.text === 'Brand new.')?.provenance).toBe('HUMAN');
    expect(after.filter((a) => a.text !== 'Brand new.').every((a) => a.provenance === 'CREW')).toBe(
      true,
    );
  });

  it('does not touch updatedAt on a line nobody changed', async () => {
    await seed(['Untouched.', 'Also untouched.']);
    const before = await db.estimateStatement.findMany({
      where: { estimateId },
      select: { id: true, updatedAt: true },
      orderBy: { order: 'asc' },
    });

    await reconcileStatements(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Untouched.', 'Also untouched.'],
    });

    const after = await db.estimateStatement.findMany({
      where: { estimateId },
      select: { id: true, updatedAt: true },
      orderBy: { order: 'asc' },
    });
    // `updatedAt` is a staleness signal the edit engine reads, so a save that
    // changed nothing must not make every line look freshly edited.
    expect(after).toEqual(before);
  });

  it('renumbers when a line is removed, and forgets the row', async () => {
    await seed(['Keep.', 'Delete me.', 'Keep too.']);
    const after = await reconcileStatements(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Keep.', 'Keep too.'],
    });
    expect(after.map((a) => a.text)).toEqual(['Keep.', 'Keep too.']);
    expect(after.map((a) => a.order)).toEqual([0, 1]);
    expect(await db.estimateStatement.count({ where: { estimateId } })).toBe(2);
  });

  it('treats an edited line as new, which is what an edit is', async () => {
    await seed(['Auth already exists.']);
    const before = await assumptions();
    const after = await reconcileStatements(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Auth already exists in a form we can reuse.'],
    });
    // Rewording IS a change, so it gets a new row stamped HUMAN. The crew's
    // original wording is gone, which is correct — the person replaced it.
    expect(after[0]?.id).not.toBe(before[0]?.id);
    expect(after[0]?.provenance).toBe('HUMAN');
  });

  it('handles two lines with identical text without losing one', async () => {
    // Not hypothetical: two specialists can collate the same assumption.
    await seed(['Same wording.', 'Same wording.']);
    const after = await reconcileStatements(db, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Same wording.', 'Same wording.'],
    });
    expect(after).toHaveLength(2);
    expect(after.every((a) => a.provenance === 'CREW')).toBe(true);
  });

  it('empties the list when everything is deleted', async () => {
    await seed(['Gone.']);
    expect(await reconcileStatements(db, { estimateId, kind: 'ASSUMPTION', texts: [] })).toEqual([]);
    expect(await db.estimateStatement.count({ where: { estimateId } })).toBe(0);
  });
});

describe('appendStatement', () => {
  it('adds to the end and stamps what it is told', async () => {
    await seed(['First.']);
    const added = await appendStatement(db, {
      estimateId,
      kind: 'ASSUMPTION',
      text: '  The existing platform covers this.  ',
      provenance: 'STEERED',
    });
    // Trimmed, ordered last, and STEERED — a person decided, a model wrote the
    // words. That is the Oracle's suggested-assumption path.
    expect(added.text).toBe('The existing platform covers this.');
    expect(added.order).toBe(1);
    expect(added.provenance).toBe('STEERED');
  });

  it('starts at zero on an empty list', async () => {
    const added = await appendStatement(db, {
      estimateId,
      kind: 'NARRATIVE',
      text: 'A rebuild in three tranches.',
    });
    expect(added.order).toBe(0);
  });

  it('refuses an empty statement', async () => {
    await expect(
      appendStatement(db, { estimateId, kind: 'ASSUMPTION', text: '   ' }),
    ).rejects.toThrow(/empty/i);
  });
});
