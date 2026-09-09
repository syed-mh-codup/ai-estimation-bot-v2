import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { lockEnvelope } from './ledger-locks.js';
import {
  applyRegionReplace,
  applyRestructure,
  regionFingerprint,
  revertRegion,
  snapshotRegion,
  type ProposedRow,
} from './ledger-edit.js';
import { PrismaClient } from './generated/client/index.js';

/**
 * AEH-238. Region replace: the write a steered edit makes.
 *
 * What these guard, in order of how expensive the mistake would be:
 *
 * 1. Only the pinned rows are deleted. The pipeline's persist deletes every
 *    card on the estimate; this one must not, and the sibling rows asserted on
 *    below are the difference between an edit and a re-run.
 * 2. Reverting one edit does not destroy another's rows. The first version of
 *    this code identified an edit's output by card plus provenance, which also
 *    matches an EARLIER steered edit on the same card — so putting one back
 *    silently deleted the other's work. The two-edit case is what catches it.
 * 3. A row locked WHILE the job ran is refused outright, not offered for
 *    approval. Approving would be a lock bypass with none of the override
 *    ceremony.
 * 4. A moved region parks rather than writes, and the parked proposal is what
 *    an approval later applies.
 *
 * Fixtures are namespaced and cleaned up by that namespace: vitest runs files
 * in parallel against one database.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const NS = `aeh238edit-${Math.random().toString(36).slice(2, 10)}`;
const CONFIG_VERSION = 700_000 + Math.floor(Math.random() * 90_000);

let userId = '';
let estimateId = '';
let cardId = '';
let otherCardId = '';
/** role -> lineItemId on `cardId` */
const line: Record<string, string> = {};

/** DEV untaxed, QA at 20% — so a wrong percent shows up as a wrong figure. */
const EFFECTIVE = { DEV: 0, QA: 20, PM: 12, BA: 8 };

async function newEdit(pinned: string[], cards: string[], fingerprint: Date | null) {
  return db.ledgerEdit.create({
    data: {
      estimateId,
      actorId: userId,
      prompt: 'the hours are too heavy, re-think the work',
      declaredScope: 'CARD',
      declaredTargetId: cards[0] ?? null,
      roles: ['DEV'],
      pinnedLineItemIds: pinned,
      pinnedCardIds: cards,
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

  await db.estimationConfig.create({
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

  const est = await db.estimate.create({
    data: {
      title: `${NS} estimate`,
      sowText: 'x',
      status: 'REVIEW',
      configVersion: CONFIG_VERSION,
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
    select: { id: true },
  });
  estimateId = est.id;
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.estimationConfig.deleteMany({ where: { version: CONFIG_VERSION } });
  await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  await db.ledgerEdit.deleteMany({ where: { estimateId } });
  await db.ledgerLock.deleteMany({ where: { estimateId } });
  await db.lockEvent.deleteMany({ where: { estimateId } });
  await db.menuItem.deleteMany({ where: { estimateId } });

  const card = await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: `${NS}.checkout`,
      title: 'Checkout',
      lineItems: {
        create: [
          { role: 'DEV', title: 'dev one', baseHours: 4, taxedHours: 4, provenance: 'CREW' },
          { role: 'QA', title: 'qa one', baseHours: 2, taxedHours: 2.4, provenance: 'HUMAN' },
        ],
      },
    },
    select: { id: true, lineItems: { select: { id: true, role: true } } },
  });
  cardId = card.id;
  for (const li of card.lineItems) line[li.role] = li.id;

  const other = await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: `${NS}.reports`,
      title: 'Reports',
      lineItems: {
        create: [{ role: 'DEV', title: 'other dev', baseHours: 3, taxedHours: 3 }],
      },
    },
    select: { id: true },
  });
  otherCardId = other.id;
});

const rowsOn = (menuItemId: string) =>
  db.roleLineItem.findMany({
    where: { menuItemId },
    orderBy: [{ role: 'asc' }, { baseHours: 'asc' }],
    select: { title: true, role: true, baseHours: true, taxedHours: true, provenance: true },
  });

describe('applyRegionReplace', () => {
  it('replaces the pinned rows and touches nothing else', async () => {
    const fp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['DEV']!] });
    const edit = await newEdit([line['DEV']!], [cardId], fp);

    const proposed: ProposedRow[] = [
      { menuItemId: cardId, role: 'DEV', title: 'lighter dev A', baseHours: 1.5 },
      { menuItemId: cardId, role: 'DEV', title: 'lighter dev B', baseHours: 1 },
    ];
    const outcome = await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['DEV']!],
      pinnedCardIds: [cardId],
      proposed,
      effective: EFFECTIVE,
      expectFingerprint: fp,
    });
    expect(outcome.kind).toBe('APPLIED');

    const rows = await rowsOn(cardId);
    // The one DEV row became two; the QA row on the SAME card is untouched,
    // provenance included. That is the whole difference from a re-run.
    expect(rows.filter((r) => r.role === 'DEV').map((r) => r.title)).toEqual([
      'lighter dev B',
      'lighter dev A',
    ]);
    const qa = rows.find((r) => r.role === 'QA');
    expect(qa).toMatchObject({ title: 'qa one', baseHours: 2, provenance: 'HUMAN' });

    // And the other card is entirely untouched.
    expect((await rowsOn(otherCardId)).map((r) => r.title)).toEqual(['other dev']);
  });

  it('writes STEERED, and taxes against the percents it was handed', async () => {
    const fp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['QA']!] });
    const edit = await newEdit([line['QA']!], [cardId], fp);
    await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['QA']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'QA', title: 'new qa', baseHours: 2 }],
      effective: EFFECTIVE,
      expectFingerprint: fp,
    });
    const qa = (await rowsOn(cardId)).find((r) => r.role === 'QA');
    // 2h at the 20% QA buffer is 2.4, which `taxedHoursFor` then snaps UP to
    // 2.5 — the taxed figure obeys the same quarter-hour granularity as the
    // base. Asserting the un-snapped 2.4 here would be asserting a bug.
    //
    // A row taxed at the wrong percent, or not taxed at all, shows up as a
    // different number: DEV is deliberately 0% in this fixture, so a mix-up
    // between the roles' buffers cannot pass.
    expect(qa).toMatchObject({ baseHours: 2, taxedHours: 2.5, provenance: 'STEERED' });
  });

  it('snaps to the quarter hour and refuses to exceed the four-hour cap', async () => {
    const fp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['DEV']!] });
    const edit = await newEdit([line['DEV']!], [cardId], fp);
    await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['DEV']!],
      pinnedCardIds: [cardId],
      proposed: [
        { menuItemId: cardId, role: 'DEV', title: 'ragged', baseHours: 3.7 },
        { menuItemId: cardId, role: 'DEV', title: 'oversized', baseHours: 9 },
      ],
      effective: EFFECTIVE,
      expectFingerprint: fp,
    });
    const dev = (await rowsOn(cardId)).filter((r) => r.role === 'DEV');
    // 3.7 snaps, 9 clamps. Both would render and sum perfectly while quietly
    // breaking the decomposition rule every other row obeys.
    expect(dev.map((r) => r.baseHours).sort()).toEqual([3.75, 4]);
  });

  it('parks the proposal when the region moved, and writes nothing', async () => {
    const fp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['DEV']!] });
    const edit = await newEdit([line['DEV']!], [cardId], fp);

    // Somebody edits the card while the job is running.
    await db.menuItem.update({ where: { id: cardId }, data: { title: 'Checkout (renamed)' } });

    const outcome = await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['DEV']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'DEV', title: 'would-be', baseHours: 2 }],
      effective: EFFECTIVE,
      expectFingerprint: fp,
    });
    expect(outcome.kind).toBe('CONFLICT');

    // The ledger is exactly as it was — a conflict is not a partial write.
    const dev = (await rowsOn(cardId)).filter((r) => r.role === 'DEV');
    expect(dev.map((r) => r.title)).toEqual(['dev one']);

    const row = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: edit.id },
      select: { status: true, afterSnapshot: true, hoursBefore: true, hoursAfter: true },
    });
    expect(row.status).toBe('PENDING_CONFLICT');
    // Parked, so an approval has something to apply.
    expect((row.afterSnapshot as { rows: unknown[] }).rows).toHaveLength(1);
    expect(row.hoursBefore).toBe(4);
    expect(row.hoursAfter).toBe(2);
  });

  it('applies a parked proposal when a person approves it', async () => {
    const fp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['DEV']!] });
    const edit = await newEdit([line['DEV']!], [cardId], fp);
    await db.menuItem.update({ where: { id: cardId }, data: { title: 'moved' } });
    await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['DEV']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'DEV', title: 'approved', baseHours: 2 }],
      effective: EFFECTIVE,
      expectFingerprint: fp,
    });

    const outcome = await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['DEV']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'DEV', title: 'approved', baseHours: 2 }],
      effective: EFFECTIVE,
      expectFingerprint: null,
      overwriteConflict: true,
    });
    expect(outcome.kind).toBe('APPLIED');
    const row = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: edit.id },
      select: { status: true, overwroteConflict: true },
    });
    expect(row).toEqual({ status: 'APPLIED', overwroteConflict: true });
  });

  it('refuses outright when a pinned row was locked while it ran', async () => {
    const fp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['DEV']!] });
    const edit = await newEdit([line['DEV']!], [cardId], fp);

    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'LINE', id: line['DEV']! }, roles: [] },
      actorId: userId,
    });

    const outcome = await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['DEV']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'DEV', title: 'nope', baseHours: 1 }],
      effective: EFFECTIVE,
      expectFingerprint: fp,
    });
    // FAILED, not PENDING_CONFLICT. There is deliberately no approval path for
    // this: approving would bypass a lock without the override ceremony.
    expect(outcome.kind).toBe('REFUSED_LOCKED');
    const row = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: edit.id },
      select: { status: true, error: true },
    });
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/locked/i);
    expect((await rowsOn(cardId)).filter((r) => r.role === 'DEV').map((r) => r.title)).toEqual([
      'dev one',
    ]);
  });
});

describe('revertRegion', () => {
  it('puts the rows back with their original provenance', async () => {
    const fp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['QA']!] });
    const edit = await newEdit([line['QA']!], [cardId], fp);
    await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: [line['QA']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'QA', title: 'steered qa', baseHours: 1 }],
      effective: EFFECTIVE,
      expectFingerprint: fp,
    });

    await revertRegion(db, { editId: edit.id, revertedById: userId });

    const qa = (await rowsOn(cardId)).filter((r) => r.role === 'QA');
    // The human's row comes back AS a human's row. A revert asserts the edit
    // did not happen, so a restored line reading "steered" would be a record of
    // something that was undone.
    expect(qa).toEqual([
      { title: 'qa one', role: 'QA', baseHours: 2, taxedHours: 2.4, provenance: 'HUMAN' },
    ]);
    const row = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: edit.id },
      select: { status: true, revertedById: true },
    });
    expect(row).toEqual({ status: 'REVERTED', revertedById: userId });
  });

  it('does not destroy a different edit’s rows on the same card', async () => {
    // Two steered edits on ONE card, different roles. This is the case the
    // first version got wrong: it identified an edit's output by card plus
    // provenance, which also matches the other edit's rows.
    const devFp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['DEV']!] });
    const devEdit = await newEdit([line['DEV']!], [cardId], devFp);
    await applyRegionReplace(db, {
      editId: devEdit.id,
      pinnedLineItemIds: [line['DEV']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'DEV', title: 'steered dev', baseHours: 2 }],
      effective: EFFECTIVE,
      expectFingerprint: devFp,
    });

    const qaFp = await regionFingerprint(db, { cardIds: [cardId], lineItemIds: [line['QA']!] });
    const qaEdit = await newEdit([line['QA']!], [cardId], qaFp);
    await applyRegionReplace(db, {
      editId: qaEdit.id,
      pinnedLineItemIds: [line['QA']!],
      pinnedCardIds: [cardId],
      proposed: [{ menuItemId: cardId, role: 'QA', title: 'steered qa', baseHours: 1 }],
      effective: EFFECTIVE,
      expectFingerprint: qaFp,
    });

    // Put ONLY the QA one back.
    await revertRegion(db, { editId: qaEdit.id, revertedById: userId });

    const rows = await rowsOn(cardId);
    // The DEV edit's row survives, still steered.
    expect(rows.filter((r) => r.role === 'DEV')).toEqual([
      { title: 'steered dev', role: 'DEV', baseHours: 2, taxedHours: 2, provenance: 'STEERED' },
    ]);
    // ...and QA is back to the human's original.
    expect(rows.filter((r) => r.role === 'QA').map((r) => r.provenance)).toEqual(['HUMAN']);
  });

  it('refuses to put back anything that was not applied', async () => {
    const edit = await newEdit([line['DEV']!], [cardId], null);
    await expect(revertRegion(db, { editId: edit.id, revertedById: userId })).rejects.toThrow(
      /applied/i,
    );
  });
});

describe('snapshotRegion', () => {
  it('is stable for an unchanged region, so "did anything move" is comparable', async () => {
    const a = await snapshotRegion(db, [line['DEV']!, line['QA']!]);
    const b = await snapshotRegion(db, [line['QA']!, line['DEV']!]);
    // Ordered by id, so the argument order cannot change the answer.
    expect(a).toEqual(b);
    expect(a.baseHours).toBe(6);
  });
});

describe('applyRestructure', () => {
  it('splits a card, moving lines rather than recreating them', async () => {
    const result = await applyRestructure(db, {
      estimateId,
      sourceCardIds: [cardId],
      cards: [
        {
          reuseMenuItemId: cardId,
          title: 'Checkout - payment',
          taxonomyKey: `${NS}.pay`,
          category: null,
          phase: 'Core',
          lineItemIds: [line['DEV']!],
        },
        {
          reuseMenuItemId: null,
          title: 'Checkout - receipts',
          taxonomyKey: `${NS}.receipts`,
          category: null,
          phase: 'Core',
          lineItemIds: [line['QA']!],
        },
      ],
    });

    expect(result.cardIds).toHaveLength(2);
    expect(result.cardIds[0]).toBe(cardId);
    expect(result.removedCardIds).toEqual([]);

    // The row MOVED: same id, new card. That is what lets a re-cost see the
    // rows as they stand, and what keeps their provenance and envelope meta.
    const moved = await db.roleLineItem.findUnique({
      where: { id: line['QA']! },
      select: { menuItemId: true, provenance: true },
    });
    expect(moved?.menuItemId).toBe(result.cardIds[1]);
    expect(moved?.provenance).toBe('HUMAN');

    const kept = await db.roleLineItem.findUnique({
      where: { id: line['DEV']! },
      select: { menuItemId: true },
    });
    expect(kept?.menuItemId).toBe(cardId);
  });

  it('drops matchScore on every card it touches, and keeps the anchor', async () => {
    await db.menuItem.update({
      where: { id: cardId },
      data: { sourcePresetId: 'preset-x', matchScore: 0.87 },
    });

    await applyRestructure(db, {
      estimateId,
      sourceCardIds: [cardId],
      cards: [
        {
          reuseMenuItemId: cardId,
          title: 'Half a card',
          taxonomyKey: `${NS}.half`,
          category: null,
          phase: null,
          lineItemIds: [line['DEV']!],
        },
        {
          reuseMenuItemId: null,
          title: 'The other half',
          taxonomyKey: `${NS}.other-half`,
          category: null,
          phase: null,
          lineItemIds: [line['QA']!],
        },
      ],
    });

    // Half a card is no longer the thing the Archivist measured, and promotion
    // and writeback both read this figure — so it goes null rather than being
    // carried across or, worse, invented.
    const after = await db.menuItem.findMany({
      where: { estimateId, title: { in: ['Half a card', 'The other half'] } },
      select: { matchScore: true, sourcePresetId: true },
    });
    expect(after).toHaveLength(2);
    for (const c of after) expect(c.matchScore).toBeNull();
    // The anchor itself survives: it still says what the card came from.
    expect(after.some((c) => c.sourcePresetId === 'preset-x')).toBe(true);
  });

  it('merges two cards into one and removes the emptied one', async () => {
    const otherLineId = (
      await db.roleLineItem.findFirstOrThrow({
        where: { menuItemId: otherCardId },
        select: { id: true },
      })
    ).id;

    const result = await applyRestructure(db, {
      estimateId,
      sourceCardIds: [cardId, otherCardId],
      cards: [
        {
          reuseMenuItemId: cardId,
          title: 'Checkout and reports',
          taxonomyKey: `${NS}.both`,
          category: null,
          phase: null,
          lineItemIds: [line['DEV']!, line['QA']!, otherLineId],
        },
      ],
    });

    expect(result.cardIds).toEqual([cardId]);
    expect(result.removedCardIds).toEqual([otherCardId]);
    expect(await db.menuItem.count({ where: { id: otherCardId } })).toBe(0);
    // Every line survived. A card disappearing must never take work with it.
    expect(await db.roleLineItem.count({ where: { menuItemId: cardId } })).toBe(3);
  });

  it('invalidates the scopes and edges cut from the old card set, and unlinks findings', async () => {
    const scenario = await db.scopeScenario.create({
      data: { estimateId, name: 'A cut', createdById: userId },
      select: { id: true },
    });
    await db.scopeScenarioPick.create({ data: { scenarioId: scenario.id, menuItemId: cardId } });
    await db.menuItemDependency.create({
      data: { estimateId, dependentId: cardId, prerequisiteId: otherCardId, source: 'MANUAL' },
    });
    const finding = await db.hiddenWorkFinding.create({
      data: {
        estimateId,
        riskFlag: `${NS}-FLAG`,
        claim: 'rate limiting',
        citation: 'p3',
        requirementId: 'REQ-001',
        outcome: 'ACCEPTED',
        menuItemId: cardId,
      },
      select: { id: true },
    });

    await applyRestructure(db, {
      estimateId,
      sourceCardIds: [cardId],
      cards: [
        {
          reuseMenuItemId: cardId,
          title: 'Reshaped',
          taxonomyKey: `${NS}.reshaped`,
          category: null,
          phase: null,
          lineItemIds: [line['DEV']!, line['QA']!],
        },
      ],
    });

    // The rule the pipeline's own persist already states: dependencies, and
    // the scopes cut from them, are properties of one particular set of cards.
    expect(await db.scopeScenarioPick.count({ where: { scenarioId: scenario.id } })).toBe(0);
    expect(await db.menuItemDependency.count({ where: { estimateId } })).toBe(0);
    // The decision survives; only the link goes.
    expect(
      await db.hiddenWorkFinding.findUniqueOrThrow({
        where: { id: finding.id },
        select: { outcome: true, menuItemId: true },
      }),
    ).toEqual({ outcome: 'ACCEPTED', menuItemId: null });
  });

  it('gives a created card the anchor section and its injected/overhead flags', async () => {
    const section = await db.estimateSection.create({
      data: { estimateId, title: 'Phase one', order: 0 },
      select: { id: true },
    });
    await db.menuItem.update({
      where: { id: cardId },
      data: { sectionId: section.id, injected: true, overhead: true, order: 5 },
    });

    const result = await applyRestructure(db, {
      estimateId,
      sourceCardIds: [cardId],
      cards: [
        {
          reuseMenuItemId: cardId,
          title: 'Kept',
          taxonomyKey: `${NS}.kept`,
          category: null,
          phase: null,
          lineItemIds: [line['DEV']!],
        },
        {
          reuseMenuItemId: null,
          title: 'Carved out',
          taxonomyKey: `${NS}.carved`,
          category: null,
          phase: null,
          lineItemIds: [line['QA']!],
        },
      ],
    });

    // A card carved out of inferred work is still inferred, and one carved out
    // of an overhead card is still overhead. Both flags change behaviour
    // elsewhere, so losing them would be a silent miscount.
    expect(
      await db.menuItem.findUniqueOrThrow({
        where: { id: result.cardIds[1]! },
        select: { sectionId: true, injected: true, overhead: true, order: true },
      }),
    ).toEqual({ sectionId: section.id, injected: true, overhead: true, order: 6 });
  });
});
