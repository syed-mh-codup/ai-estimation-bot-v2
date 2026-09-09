import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { replaceStatements } from './estimate-statements.js';
import { lockStatements } from './statement-locks.js';
import {
  applyStatementRevision,
  revertStatementRevision,
  snapshotStatements,
  statementFingerprint,
} from './statement-edit.js';
import { PrismaClient } from './generated/client/index.js';

/**
 * AEH-238. Writing a steered statement revision.
 *
 * What these guard, in order of how expensive the mistake would be:
 *
 * 1. Only the PINNED statements can change. A proposal naming anything else is
 *    dropped rather than written — the boundary the person declared has to hold
 *    even if the agent stops filtering its own output.
 * 2. A statement locked WHILE the job ran is refused outright, not offered for
 *    approval. Approving would be a lock bypass with none of the override
 *    ceremony.
 * 3. A revert is EXACT: rewritten lines keep their ids, and a line a merge
 *    deleted comes back with the id it had. That is the difference from the
 *    hours revert, which can only recreate rows with new ids.
 * 4. A moved region parks rather than writes, and the parked proposal is what
 *    an approval later applies.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const NS = `aeh238sedit-${Math.random().toString(36).slice(2, 10)}`;
let userId = '';
let estimateId = '';
/** text -> statement id, for the ASSUMPTION list. */
const stmt: Record<string, string> = {};

async function newEdit(pinned: string[], fingerprint: Date | null) {
  return db.ledgerEdit.create({
    data: {
      estimateId,
      actorId: userId,
      prompt: 'these two say the same thing — merge them',
      mode: 'REVISE_STATEMENTS',
      declaredScope: 'STATEMENT',
      declaredTargetId: pinned[0] ?? null,
      roles: [],
      pinnedLineItemIds: [],
      pinnedCardIds: [],
      pinnedStatementIds: pinned,
      fingerprint,
      status: 'RUNNING',
    },
    select: { id: true },
  });
}

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
  await db.ledgerEdit.deleteMany({ where: { estimateId } });
  await db.statementLock.deleteMany({ where: { estimateId } });
  await db.lockEvent.deleteMany({ where: { estimateId } });
  await db.estimateStatement.deleteMany({ where: { estimateId } });

  await db.$transaction(async (tx) => {
    await replaceStatements(tx, {
      estimateId,
      kind: 'ASSUMPTION',
      texts: ['Auth already exists.', 'Auth is in place.', 'No data migration.'],
    });
  });
  const rows = await db.estimateStatement.findMany({
    where: { estimateId, kind: 'ASSUMPTION' },
    select: { id: true, text: true },
  });
  for (const r of rows) stmt[r.text] = r.id;
});

const listNow = async () =>
  db.estimateStatement.findMany({
    where: { estimateId, kind: 'ASSUMPTION' },
    orderBy: { order: 'asc' },
    select: { id: true, text: true, provenance: true },
  });

describe('applyStatementRevision', () => {
  it('rewrites the pinned line, stamps STEERED, and touches nothing else', async () => {
    const id = stmt['No data migration.']!;
    const fp = await statementFingerprint(db, [id]);
    const edit = await newEdit([id], fp);

    const outcome = await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [id],
      proposed: [{ statementId: id, text: 'Existing data is carried across as it stands.' }],
      expectFingerprint: fp,
      reasoning: 'Said in plainer words.',
    });

    expect(outcome).toEqual({ kind: 'APPLIED', rewritten: 1, deleted: 0 });
    expect(await listNow()).toEqual([
      { id: stmt['Auth already exists.'], text: 'Auth already exists.', provenance: 'CREW' },
      { id: stmt['Auth is in place.'], text: 'Auth is in place.', provenance: 'CREW' },
      {
        id,
        text: 'Existing data is carried across as it stands.',
        // A person decided, a model wrote the words. Neither HUMAN nor CREW.
        provenance: 'STEERED',
      },
    ]);
  });

  it('merges by deleting the absorbed line, and keeps the merged one’s id', async () => {
    const keep = stmt['Auth already exists.']!;
    const absorb = stmt['Auth is in place.']!;
    const fp = await statementFingerprint(db, [keep, absorb]);
    const edit = await newEdit([keep, absorb], fp);

    const outcome = await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [keep, absorb],
      proposed: [
        { statementId: keep, text: 'Authentication already exists and is reused as it stands.' },
        // An empty string deletes. That is how a merge is expressed.
        { statementId: absorb, text: '' },
      ],
      expectFingerprint: fp,
    });

    expect(outcome).toEqual({ kind: 'APPLIED', rewritten: 1, deleted: 1 });
    const rows = await listNow();
    expect(rows.map((r) => r.text)).toEqual([
      'Authentication already exists and is reused as it stands.',
      'No data migration.',
    ]);
    expect(rows[0]?.id).toBe(keep);

    const record = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: edit.id },
      select: { rowsBefore: true, rowsAfter: true, hoursBefore: true, hoursAfter: true },
    });
    expect(record).toEqual({
      rowsBefore: 2,
      rowsAfter: 1,
      // Null rather than zero, deliberately: this edit moved no hours, and
      // recording 0 would put it in the list of things that changed a number.
      hoursBefore: null,
      hoursAfter: null,
    });
  });

  it('drops a proposal for a statement outside the pinned set', async () => {
    const pinned = stmt['No data migration.']!;
    const outsider = stmt['Auth already exists.']!;
    const fp = await statementFingerprint(db, [pinned]);
    const edit = await newEdit([pinned], fp);

    await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [pinned],
      proposed: [
        { statementId: pinned, text: 'Data is carried across.' },
        // The agent already filters this out. The boundary must hold anyway.
        { statementId: outsider, text: 'Something nobody asked for.' },
      ],
      expectFingerprint: fp,
    });

    const rows = await listNow();
    expect(rows.find((r) => r.id === outsider)).toEqual({
      id: outsider,
      text: 'Auth already exists.',
      provenance: 'CREW',
    });
  });

  it('refuses outright when a pinned statement was locked while it ran', async () => {
    const id = stmt['No data migration.']!;
    const fp = await statementFingerprint(db, [id]);
    const edit = await newEdit([id], fp);

    await lockStatements(db, { estimateId, target: { scope: 'STATEMENT', id }, actorId: userId });

    const outcome = await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [id],
      proposed: [{ statementId: id, text: 'Rewritten anyway.' }],
      expectFingerprint: fp,
    });

    // Not PENDING_CONFLICT: approving that would be a lock bypass with none of
    // the override ceremony.
    expect(outcome).toEqual({ kind: 'REFUSED_LOCKED', lockedStatementIds: [id] });
    const row = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: edit.id },
      select: { status: true, error: true },
    });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/locked while the edit was running/);
    expect((await listNow()).find((r) => r.id === id)?.text).toBe('No data migration.');
  });

  it('parks the proposal when the region moved, and writes nothing', async () => {
    const id = stmt['No data migration.']!;
    const stale = await statementFingerprint(db, [id]);
    const edit = await newEdit([id], stale);

    // Somebody edits it while the job is running.
    await db.estimateStatement.update({
      where: { id },
      data: { text: 'Somebody else got here first.' },
    });

    const outcome = await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [id],
      proposed: [{ statementId: id, text: 'The job’s wording.' }],
      expectFingerprint: stale,
    });

    expect(outcome.kind).toBe('CONFLICT');
    expect((await listNow()).find((r) => r.id === id)?.text).toBe('Somebody else got here first.');
    const row = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: edit.id },
      select: { status: true, afterSnapshot: true },
    });
    expect(row.status).toBe('PENDING_CONFLICT');
    // The proposal is parked so a person can decide — a background job cannot
    // ask a question.
    expect((row.afterSnapshot as { statements?: unknown[] }).statements).toHaveLength(1);
  });

  it('applies a parked proposal when a person approves it', async () => {
    const id = stmt['No data migration.']!;
    const edit = await newEdit([id], null);
    await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [id],
      proposed: [{ statementId: id, text: 'The approved wording.' }],
      // Already parked once for this reason; the person has now decided.
      expectFingerprint: null,
      overwriteConflict: true,
    });
    expect((await listNow()).find((r) => r.id === id)?.text).toBe('The approved wording.');
    expect(
      (
        await db.ledgerEdit.findUniqueOrThrow({
          where: { id: edit.id },
          select: { overwroteConflict: true },
        })
      ).overwroteConflict,
    ).toBe(true);
  });
});

describe('snapshotStatements', () => {
  it('is stable for an unchanged region, so "did anything move" is comparable', async () => {
    const ids = Object.values(stmt);
    expect(await snapshotStatements(db, ids)).toEqual(await snapshotStatements(db, ids));
  });
});

describe('revertStatementRevision', () => {
  it('puts the wording back onto the SAME ids, with the original provenance', async () => {
    const id = stmt['No data migration.']!;
    const fp = await statementFingerprint(db, [id]);
    const edit = await newEdit([id], fp);
    await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [id],
      proposed: [{ statementId: id, text: 'Rewritten.' }],
      expectFingerprint: fp,
    });

    const result = await revertStatementRevision(db, { editId: edit.id, revertedById: userId });
    expect(result.statementsRestored).toBe(1);

    const row = (await listNow()).find((r) => r.id === id);
    expect(row).toEqual({ id, text: 'No data migration.', provenance: 'CREW' });
    // Not STEERED. A revert is the assertion that the edit did not happen, and
    // a line reading "steered" afterwards would record something undone.
  });

  it('resurrects a merged-away line WITH the id it had', async () => {
    const keep = stmt['Auth already exists.']!;
    const absorb = stmt['Auth is in place.']!;
    const fp = await statementFingerprint(db, [keep, absorb]);
    const edit = await newEdit([keep, absorb], fp);
    await applyStatementRevision(db, {
      editId: edit.id,
      pinnedStatementIds: [keep, absorb],
      proposed: [
        { statementId: keep, text: 'Merged.' },
        { statementId: absorb, text: '' },
      ],
      expectFingerprint: fp,
    });
    expect(await db.estimateStatement.count({ where: { id: absorb } })).toBe(0);

    await revertStatementRevision(db, { editId: edit.id, revertedById: userId });

    // THE difference from the hours revert, which can only recreate rows with
    // new ids: nothing that referred to this statement ends up dangling.
    const rows = await listNow();
    expect(rows.map((r) => r.id)).toEqual([keep, absorb, stmt['No data migration.']]);
    expect(rows.map((r) => r.text)).toEqual([
      'Auth already exists.',
      'Auth is in place.',
      'No data migration.',
    ]);
  });

  it('refuses to put back anything that was not applied', async () => {
    const edit = await newEdit([stmt['No data migration.']!], null);
    await expect(
      revertStatementRevision(db, { editId: edit.id, revertedById: userId }),
    ).rejects.toThrow(/Only an applied edit/);
  });

  it('refuses an edit that changed no statements', async () => {
    const edit = await db.ledgerEdit.create({
      data: {
        estimateId,
        actorId: userId,
        prompt: 'the hours are heavy',
        mode: 'REPRICE',
        declaredScope: 'CARD',
        roles: ['DEV'],
        pinnedLineItemIds: [],
        pinnedCardIds: [],
        pinnedStatementIds: [],
        status: 'APPLIED',
      },
      select: { id: true },
    });
    await expect(
      revertStatementRevision(db, { editId: edit.id, revertedById: userId }),
    ).rejects.toThrow(/did not change any statements/);
  });
});
