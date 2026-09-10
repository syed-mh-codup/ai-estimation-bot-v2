import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from './generated/client/index.js';
import { forkEstimate } from './fork';
import { applyReconciliation } from './reconcile-apply';

/**
 * AEH-236. Writing an accepted reconciliation to the ledger.
 *
 * The pass proposes and this is the only thing that writes, so the tests that
 * matter are about what does NOT get written: a rejected proposal, an
 * undecided one, a locked card, and a ledger that moved while the review was
 * open. Each of those is a number a client might see moving without anybody
 * having decided it should.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let forkId = '';
let recId = '';
const made: string[] = [];

const rows = (hours: number) => ({
  rows: [
    {
      role: 'DEV',
      title: 'Reconciled work',
      baseHours: hours,
      taxedHours: hours,
      notes: null,
      touchesFrontend: false,
      touchesBackend: true,
    },
  ],
});

async function proposal(
  kind: 'ADD' | 'MODIFY' | 'REMOVE',
  over: Record<string, unknown> = {},
): Promise<string> {
  const p = await db.reconciliationProposal.create({
    data: {
      reconciliationId: recId,
      kind,
      title: `${kind} card`,
      rationale: 'Because the brief moved.',
      payload: rows(7) as never,
      supersedesMenuItemIds: [],
      ...over,
    },
    select: { id: true },
  });
  return p.id;
}

const cardsOf = async () =>
  db.menuItem.findMany({
    where: { estimateId: forkId },
    select: { id: true, title: true, carriedIntact: true, lineItems: { select: { baseHours: true } } },
    orderBy: { title: 'asc' },
  });

/** Fingerprint as the dispatcher computes it: newest write in the ledger. */
async function fingerprint(): Promise<Date | null> {
  const [c, r] = await Promise.all([
    db.menuItem.findFirst({ where: { estimateId: forkId }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
    db.roleLineItem.findFirst({ where: { menuItem: { estimateId: forkId } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
  ]);
  const ts = [c?.updatedAt, r?.updatedAt].filter((d): d is Date => d instanceof Date);
  return ts.length === 0 ? null : ts.reduce((a, b) => (a > b ? a : b));
}

beforeAll(async () => {
  await db.$connect();
  const u = await db.user.create({
    data: { email: `apply-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = u.id;
});

afterAll(async () => {
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  made.length = 0;
  const parent = await db.estimate.create({
    data: {
      title: 'Apply parent',
      sowText: 'x',
      status: 'REVIEW',
      configVersion: 1,
      agentState: {},
      ownerId: userId,
      menuItems: {
        create: [
          {
            taxonomyKey: 'a',
            title: 'Card A',
            lineItems: { create: [{ role: 'DEV', baseHours: 10, taxedHours: 10 }] },
          },
          {
            taxonomyKey: 'b',
            title: 'Card B',
            lineItems: { create: [{ role: 'DEV', baseHours: 20, taxedHours: 20 }] },
          },
        ],
      },
    },
    select: { id: true },
  });
  made.push(parent.id);

  const out = await forkEstimate(db, {
    parentId: parent.id,
    title: 'Apply fork',
    kind: 'SUCCESSOR',
    steer: null,
    ownerId: userId,
  });
  if (out.kind !== 'ok') throw new Error('fork refused in setup');
  forkId = out.estimateId;
  made.push(forkId);

  const rec = await db.estimateReconciliation.create({
    data: {
      estimateId: forkId,
      actorId: userId,
      prompt: 'Reconcile.',
      posture: 'SUCCESSOR',
      status: 'PROPOSED',
      fingerprint: await fingerprint(),
    },
    select: { id: true },
  });
  recId = rec.id;
});

afterEach(async () => {
  for (const id of [...made].reverse()) {
    await db.estimate.delete({ where: { id } }).catch(() => {});
  }
});

describe('nothing is written without a decision', () => {
  it('refuses when nothing has been accepted', async () => {
    await proposal('MODIFY', { menuItemId: (await cardsOf())[0]!.id });
    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out.kind).toBe('NOTHING_ACCEPTED');
    expect((await cardsOf())[0]!.lineItems[0]!.baseHours).toBe(10);
  });

  it('leaves a REJECTED proposal alone, and keeps its rationale', async () => {
    const cards = await cardsOf();
    const id = await proposal('MODIFY', { menuItemId: cards[0]!.id, decision: 'REJECTED' });
    await proposal('MODIFY', { menuItemId: cards[1]!.id, decision: 'ACCEPTED' });

    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out.kind).toBe('APPLIED');

    const after = await cardsOf();
    // Card A untouched, Card B re-priced.
    expect(after[0]!.lineItems[0]!.baseHours).toBe(10);
    expect(after[1]!.lineItems[0]!.baseHours).toBe(7);

    // The rejection survives with its reasoning — the whole point of recording
    // one. "Why is this still 10h when the brief changed" has an answer.
    const rejected = await db.reconciliationProposal.findUniqueOrThrow({
      where: { id },
      select: { decision: true, rationale: true },
    });
    expect(rejected.decision).toBe('REJECTED');
    expect(rejected.rationale).toContain('brief moved');
  });

  it('leaves an undecided proposal alone', async () => {
    const cards = await cardsOf();
    await proposal('MODIFY', { menuItemId: cards[0]!.id }); // PENDING by default
    await proposal('MODIFY', { menuItemId: cards[1]!.id, decision: 'ACCEPTED' });
    await applyReconciliation(db, { reconciliationId: recId });
    expect((await cardsOf())[0]!.lineItems[0]!.baseHours).toBe(10);
  });
});

describe('what an accepted proposal does', () => {
  it('replaces a card’s rows and marks the card amended', async () => {
    const cards = await cardsOf();
    expect(cards[0]!.carriedIntact).toBe(true);
    await proposal('MODIFY', { menuItemId: cards[0]!.id, decision: 'ACCEPTED' });

    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out).toMatchObject({ kind: 'APPLIED', modified: 1, added: 0, removed: 0 });

    const after = await cardsOf();
    expect(after[0]!.lineItems).toHaveLength(1);
    expect(after[0]!.lineItems[0]!.baseHours).toBe(7);
    // The margin rule must stop claiming this row still matches the parent.
    expect(after[0]!.carriedIntact).toBe(false);
  });

  it('creates a card with no carriage for work that has no counterpart', async () => {
    await proposal('ADD', { decision: 'ACCEPTED', title: 'Loyalty scheme' });
    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out).toMatchObject({ kind: 'APPLIED', added: 1 });

    const card = await db.menuItem.findFirstOrThrow({
      where: { estimateId: forkId, title: 'Loyalty scheme' },
      select: { carriedFromId: true, lineItems: { select: { provenance: true, baseHours: true } } },
    });
    // No lineage to claim: this work was never on the parent.
    expect(card.carriedFromId).toBeNull();
    expect(card.lineItems[0]!.provenance).toBe('STEERED');
    expect(card.lineItems[0]!.baseHours).toBe(7);
  });

  it('gives an added card the requirement it was costed against', async () => {
    // Without this the card is invisible to every future reconciliation:
    // `requirementForCard` reads `meta.requirementIds`, so a card created with
    // no meta can never be re-priced by a later pass. Invisible from birth.
    await db.reconciliationProposal.create({
      data: {
        reconciliationId: recId,
        kind: 'ADD',
        title: 'Loyalty scheme',
        rationale: 'New requirement.',
        decision: 'ACCEPTED',
        supersedesMenuItemIds: [],
        payload: { ...rows(9), requirementIds: ['REQ-042'] } as never,
      },
    });

    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out.kind).toBe('APPLIED');

    const card = await db.menuItem.findFirstOrThrow({
      where: { estimateId: forkId, title: 'Loyalty scheme' },
      select: { meta: true },
    });
    expect((card.meta as { requirementIds?: string[] })?.requirementIds).toEqual(['REQ-042']);
  });

  it('deletes a removed card and everything on it', async () => {
    const cards = await cardsOf();
    await proposal('REMOVE', { menuItemId: cards[1]!.id, decision: 'ACCEPTED' });
    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out).toMatchObject({ kind: 'APPLIED', removed: 1 });
    expect((await cardsOf()).map((c) => c.title)).toEqual(['Card A']);
  });

  it('collapses several cards into one, in a single transaction', async () => {
    // A stack change dissolves cards rather than re-pricing them. The ledger
    // must never hold both the old cards and the thing that supersedes them.
    const cards = await cardsOf();
    await proposal('ADD', {
      decision: 'ACCEPTED',
      title: 'Configure and extend WooCommerce',
      supersedesMenuItemIds: [cards[0]!.id, cards[1]!.id],
    });
    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out).toMatchObject({ kind: 'APPLIED', added: 1, removed: 2 });
    expect((await cardsOf()).map((c) => c.title)).toEqual(['Configure and extend WooCommerce']);
  });

  it('settles the reconciliation itself', async () => {
    await proposal('ADD', { decision: 'ACCEPTED' });
    await applyReconciliation(db, { reconciliationId: recId });
    const rec = await db.estimateReconciliation.findUniqueOrThrow({
      where: { id: recId },
      select: { status: true, appliedAt: true, error: true },
    });
    expect(rec.status).toBe('APPLIED');
    expect(rec.appliedAt).not.toBeNull();
    expect(rec.error).toBeNull();
  });
});

describe('it refuses rather than overwrite', () => {
  it('parks a conflict when the ledger moved while the review was open', async () => {
    const cards = await cardsOf();
    await proposal('MODIFY', { menuItemId: cards[0]!.id, decision: 'ACCEPTED' });

    // Somebody edits while the proposal sits there.
    await new Promise((r) => setTimeout(r, 10));
    await db.roleLineItem.updateMany({
      where: { menuItem: { estimateId: forkId } },
      data: { baseHours: 99 },
    });

    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out.kind).toBe('CONFLICT');
    // Nothing written — the edit that landed is still there.
    expect((await cardsOf())[0]!.lineItems[0]!.baseHours).toBe(99);
  });

  it('applies over a conflict when a person says to', async () => {
    const cards = await cardsOf();
    await proposal('MODIFY', { menuItemId: cards[0]!.id, decision: 'ACCEPTED' });
    await new Promise((r) => setTimeout(r, 10));
    await db.roleLineItem.updateMany({
      where: { menuItem: { estimateId: forkId } },
      data: { baseHours: 99 },
    });

    const out = await applyReconciliation(db, { reconciliationId: recId, overwriteConflict: true });
    expect(out.kind).toBe('APPLIED');
    expect((await cardsOf())[0]!.lineItems[0]!.baseHours).toBe(7);
  });

  it('refuses outright when a line in the write set is frozen', async () => {
    // A lock is a person saying these hours are settled. It outranks a
    // proposal, and the refusal names how many rather than writing half.
    const cards = await cardsOf();
    const row = await db.roleLineItem.findFirstOrThrow({
      where: { menuItemId: cards[0]!.id },
      select: { id: true },
    });
    await db.ledgerLock.create({
      data: { estimateId: forkId, lineItemId: row.id, declaredScope: 'LINE', lockedById: userId },
    });
    await proposal('MODIFY', { menuItemId: cards[0]!.id, decision: 'ACCEPTED' });

    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out.kind).toBe('REFUSED_LOCKED');
    expect((await cardsOf())[0]!.lineItems[0]!.baseHours).toBe(10);

    const rec = await db.estimateReconciliation.findUniqueOrThrow({
      where: { id: recId },
      select: { status: true, error: true },
    });
    expect(rec.status).toBe('FAILED');
    expect(rec.error).toMatch(/frozen/);
  });

  it('writes nothing at all when one proposal in the batch is refused', async () => {
    // All-or-nothing. Half a reconciliation is a ledger matching neither the
    // old approach nor the new one, with nothing on screen saying which half.
    const cards = await cardsOf();
    const row = await db.roleLineItem.findFirstOrThrow({
      where: { menuItemId: cards[0]!.id },
      select: { id: true },
    });
    await db.ledgerLock.create({
      data: { estimateId: forkId, lineItemId: row.id, declaredScope: 'LINE', lockedById: userId },
    });
    await proposal('MODIFY', { menuItemId: cards[0]!.id, decision: 'ACCEPTED' });
    await proposal('ADD', { decision: 'ACCEPTED', title: 'Would have been added' });

    const out = await applyReconciliation(db, { reconciliationId: recId });
    expect(out.kind).toBe('REFUSED_LOCKED');
    // The ADD did not sneak through.
    expect((await cardsOf()).map((c) => c.title)).toEqual(['Card A', 'Card B']);
  });
});
