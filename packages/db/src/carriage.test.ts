import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from './generated/client/index.js';
import { forkEstimate } from './fork';
import { markAmended, markStatementsAmended } from './carriage';
import { applyRegionReplace } from './ledger-edit';

/**
 * AEH-236. Keeping the carried marks honest.
 *
 * The margin rule's whole value is the difference between "this was in the
 * parent's price and still is" and "this was in it and has since moved". A
 * write path that forgets to clear `carriedIntact` does not fail loudly — it
 * leaves a changed row drawing a solid rule, which is the ledger lying about
 * the one thing the mark was added to say.
 *
 * So this file is organised by WRITE PATH, not by behaviour. Each test names a
 * way a row can change and asserts the mark drops. Add a path that touches
 * hours, wording or existence, and it belongs here.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let parentId = '';
let forkId = '';
const made: string[] = [];

beforeAll(async () => {
  await db.$connect();
  const u = await db.user.create({
    data: { email: `carriage-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
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
      title: 'Carriage parent',
      sowText: 'x',
      status: 'REVIEW',
      configVersion: 1,
      agentState: {},
      ownerId: userId,
      menuItems: {
        create: [
          {
            taxonomyKey: 'carriage.a',
            title: 'Card A',
            lineItems: {
              create: [
                { role: 'DEV', title: 'A dev', baseHours: 10, taxedHours: 10 },
                { role: 'QA', title: 'A qa', baseHours: 4, taxedHours: 4.8 },
              ],
            },
          },
          {
            taxonomyKey: 'carriage.b',
            title: 'Card B',
            lineItems: { create: [{ role: 'DEV', title: 'B dev', baseHours: 6, taxedHours: 6 }] },
          },
        ],
      },
      statements: {
        create: [{ kind: 'ASSUMPTION', text: 'An assumption that carried.', order: 0 }],
      },
    },
    select: { id: true },
  });
  parentId = parent.id;
  made.push(parentId);

  const out = await forkEstimate(db, {
    parentId,
    title: 'Carriage fork',
    kind: 'SUCCESSOR',
    steer: null,
    ownerId: userId,
  });
  if (out.kind !== 'ok') throw new Error('fork refused in setup');
  forkId = out.estimateId;
  made.push(forkId);
});

afterEach(async () => {
  for (const id of [...made].reverse()) {
    await db.estimate.delete({ where: { id } }).catch(() => {});
  }
});

/** One carried row on the fork, with the card that holds it. */
async function aCarriedRow(): Promise<{ lineItemId: string; cardId: string }> {
  const row = await db.roleLineItem.findFirstOrThrow({
    where: { menuItem: { estimateId: forkId }, role: 'DEV', carriedIntact: true },
    select: { id: true, menuItemId: true },
  });
  return { lineItemId: row.id, cardId: row.menuItemId };
}

async function marks(lineItemId: string, cardId: string) {
  const [row, card] = await Promise.all([
    db.roleLineItem.findUnique({
      where: { id: lineItemId },
      select: { carriedIntact: true, carriedFromId: true },
    }),
    db.menuItem.findUniqueOrThrow({
      where: { id: cardId },
      select: { carriedIntact: true, carriedFromId: true },
    }),
  ]);
  return { row, card };
}

describe('a fresh fork is entirely intact', () => {
  it('every row and card carries, and says where from', async () => {
    const rows = await db.roleLineItem.findMany({
      where: { menuItem: { estimateId: forkId } },
      select: { carriedIntact: true, carriedFromId: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.carriedIntact && r.carriedFromId !== null)).toBe(true);

    const cards = await db.menuItem.findMany({
      where: { estimateId: forkId },
      select: { carriedIntact: true, carriedFromId: true },
    });
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.carriedIntact && c.carriedFromId !== null)).toBe(true);
  });
});

describe('markAmended — the mark drops, the origin does not', () => {
  it('clears the row and the card that holds it', async () => {
    const { lineItemId, cardId } = await aCarriedRow();
    await markAmended(db, { lineItemIds: [lineItemId] });

    const { row, card } = await marks(lineItemId, cardId);
    expect(row!.carriedIntact).toBe(false);
    expect(card.carriedIntact).toBe(false);
    // Where it came from is a fact about the past and survives every edit.
    expect(row!.carriedFromId).not.toBeNull();
    expect(card.carriedFromId).not.toBeNull();
  });

  it('marks a card whose CONTENTS changed while every surviving row still matches', async () => {
    const { cardId } = await aCarriedRow();
    await markAmended(db, { cardIds: [cardId] });

    const card = await db.menuItem.findUniqueOrThrow({
      where: { id: cardId },
      select: { carriedIntact: true },
    });
    expect(card.carriedIntact).toBe(false);
    // The rows themselves are untouched — they do still match.
    const rows = await db.roleLineItem.findMany({
      where: { menuItemId: cardId },
      select: { carriedIntact: true },
    });
    expect(rows.every((r) => r.carriedIntact)).toBe(true);
  });

  it('leaves the OTHER card alone', async () => {
    const { cardId } = await aCarriedRow();
    await markAmended(db, { cardIds: [cardId] });
    const others = await db.menuItem.findMany({
      where: { estimateId: forkId, id: { not: cardId } },
      select: { carriedIntact: true },
    });
    expect(others.every((c) => c.carriedIntact)).toBe(true);
  });

  it('does not bump updatedAt on a row whose mark is already clear', async () => {
    // Half the region fingerprint the steered edit engine compares is
    // `max(updatedAt)`. Re-clearing a flag that is already clear would report
    // the ledger as having moved underneath a job that was only looking at
    // itself — a spurious conflict on every second edit.
    const { lineItemId } = await aCarriedRow();
    await markAmended(db, { lineItemIds: [lineItemId] });
    const first = await db.roleLineItem.findUniqueOrThrow({
      where: { id: lineItemId },
      select: { updatedAt: true },
    });

    await new Promise((r) => setTimeout(r, 15));
    await markAmended(db, { lineItemIds: [lineItemId] });

    const second = await db.roleLineItem.findUniqueOrThrow({
      where: { id: lineItemId },
      select: { updatedAt: true },
    });
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it('is a no-op on an empty target', async () => {
    await expect(markAmended(db, {})).resolves.toBeUndefined();
    await expect(markAmended(db, { lineItemIds: [], cardIds: [] })).resolves.toBeUndefined();
  });
});

describe('write path: a re-price replaces the rows', () => {
  it('leaves the CARD holding the claim its rows can no longer make', async () => {
    const { cardId } = await aCarriedRow();
    const rows = await db.roleLineItem.findMany({
      where: { menuItemId: cardId },
      select: { id: true, role: true },
    });
    const edit = await db.ledgerEdit.create({
      data: {
        estimateId: forkId,
        actorId: userId,
        prompt: 'Re-price this card.',
        declaredScope: 'CARD',
        declaredTargetId: cardId,
        roles: ['DEV', 'QA'],
        pinnedLineItemIds: rows.map((r) => r.id),
        pinnedCardIds: [cardId],
        pinnedStatementIds: [],
      },
      select: { id: true },
    });

    const outcome = await applyRegionReplace(db, {
      editId: edit.id,
      pinnedLineItemIds: rows.map((r) => r.id),
      pinnedCardIds: [cardId],
      proposed: rows.map((r) => ({
        menuItemId: cardId,
        role: r.role,
        title: 'Re-priced',
        baseHours: 3,
        notes: null,
        touchesFrontend: false,
        touchesBackend: false,
        provenance: 'STEERED' as const,
      })),
      effective: { DEV: 0, QA: 0, PM: 0, BA: 0 },
      expectFingerprint: null,
      overwriteConflict: true,
    });
    expect(outcome.kind).toBe('APPLIED');

    // Every original row is gone, so no row-level carriage survives — which is
    // exactly why the card has to hold it.
    const after = await db.roleLineItem.findMany({
      where: { menuItemId: cardId },
      select: { carriedFromId: true, carriedIntact: true },
    });
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((r) => r.carriedFromId === null)).toBe(true);

    const card = await db.menuItem.findUniqueOrThrow({
      where: { id: cardId },
      select: { carriedFromId: true, carriedIntact: true },
    });
    // Still traces to the parent...
    expect(card.carriedFromId).not.toBeNull();
    // ...and no longer claims to match it. Derived from the rows, this card
    // would now read as brand-new work.
    expect(card.carriedIntact).toBe(false);
  });
});

describe('write path: prose', () => {
  it('drops the mark on a rewritten statement', async () => {
    const st = await db.estimateStatement.findFirstOrThrow({
      where: { estimateId: forkId },
      select: { id: true, carriedIntact: true, carriedFromId: true },
    });
    expect(st.carriedIntact).toBe(true);

    await markStatementsAmended(db, [st.id]);

    const after = await db.estimateStatement.findUniqueOrThrow({
      where: { id: st.id },
      select: { carriedIntact: true, carriedFromId: true },
    });
    expect(after.carriedIntact).toBe(false);
    expect(after.carriedFromId).toBe(st.carriedFromId);
  });
});
