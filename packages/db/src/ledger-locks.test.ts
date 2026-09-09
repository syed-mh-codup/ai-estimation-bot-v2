import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  lockEnvelope,
  lockHistoryFor,
  lockStateFor,
  lockedWithin,
  locksOn,
  resolveTarget,
  unlockEnvelope,
} from './ledger-locks.js';
import { PrismaClient } from './generated/client/index.js';

/**
 * AEH-238. Ledger locks, and the addressing they share with the edit envelope.
 *
 * What these guard, in order of how expensive the mistake would be:
 *
 * 1. A coarse lock survives the card moving. Locks are materialised to rows at
 *    lock time precisely so that dragging a card out of a locked section cannot
 *    release it — and dragging is deliberately allowed, because placement is
 *    presentational. If anyone ever "simplifies" this into a live membership
 *    test, the section case below is what fails.
 * 2. An empty role list resolves to NOTHING. The permissive reading of an
 *    unnarrowed selection is the one that does damage, and it is the natural
 *    thing to write by accident.
 * 3. A target from another estimate resolves to nothing, so a stale client
 *    cannot reach across estimates.
 * 4. History outlives the lock. `LockEvent.lineItemId` carries no foreign key
 *    for exactly this reason.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let alice = '';
let bob = '';
let estimateId = '';
let otherEstimateId = '';
let sectionId = '';
/** cardKey -> menuItemId */
const card: Record<string, string> = {};
/** `${cardKey}:${role}` -> lineItemId */
const line: Record<string, string> = {};
let foreignLineId = '';
let foreignCardId = '';
let emptyCardId = '';

async function makeEstimate(title: string, ownerId: string): Promise<string> {
  const est = await db.estimate.create({
    data: {
      title,
      sowText: 'x',
      status: 'REVIEW',
      configVersion: 1,
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId,
    },
  });
  return est.id;
}

/** One card with one row per role, so role filtering is actually exercised. */
async function makeCard(
  estId: string,
  key: string,
  opts: { sectionId?: string | null } = {},
): Promise<string> {
  const row = await db.menuItem.create({
    data: {
      estimateId: estId,
      taxonomyKey: `test.${key.toLowerCase()}`,
      title: key,
      sectionId: opts.sectionId ?? null,
      lineItems: {
        create: [
          { role: 'DEV', baseHours: 4, taxedHours: 4 },
          { role: 'QA', baseHours: 2, taxedHours: 2 },
          { role: 'PM', baseHours: 1, taxedHours: 1 },
          { role: 'BA', baseHours: 1, taxedHours: 1 },
        ],
      },
    },
    select: { id: true, lineItems: { select: { id: true, role: true } } },
  });
  for (const li of row.lineItems) line[`${key}:${li.role}`] = li.id;
  return row.id;
}

beforeAll(async () => {
  await db.$connect();
  const stamp = Date.now();
  const a = await db.user.create({
    data: { email: `locks-alice-${stamp}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  const b = await db.user.create({
    data: { email: `locks-bob-${stamp}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  alice = a.id;
  bob = b.id;

  estimateId = await makeEstimate('Locks', alice);
  otherEstimateId = await makeEstimate('Someone else', alice);

  const section = await db.estimateSection.create({
    data: { estimateId, title: 'Phase one', order: 0 },
    select: { id: true },
  });
  sectionId = section.id;

  card['CHECKOUT'] = await makeCard(estimateId, 'CHECKOUT', { sectionId });
  card['REPORTS'] = await makeCard(estimateId, 'REPORTS', { sectionId });
  card['LOOSE'] = await makeCard(estimateId, 'LOOSE');

  // A card with no rows at all: "every row is locked" is vacuously true of
  // nothing, and reading that as locked would freeze an untouched card.
  const empty = await db.menuItem.create({
    data: { estimateId, taxonomyKey: 'test.empty', title: 'EMPTY' },
    select: { id: true },
  });
  emptyCardId = empty.id;

  foreignCardId = await makeCard(otherEstimateId, 'FOREIGN');
  foreignLineId = line['FOREIGN:DEV']!;
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: alice } });
  await db.user.deleteMany({ where: { id: { in: [alice, bob] } } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  // Scoped to this file's own estimates, never a global deleteMany — vitest runs
  // test FILES in parallel against one database, and a global wipe breaks
  // unrelated suites in ways that move between runs.
  await db.ledgerLock.deleteMany({ where: { estimateId: { in: [estimateId, otherEstimateId] } } });
  await db.lockEvent.deleteMany({ where: { estimateId: { in: [estimateId, otherEstimateId] } } });
  // Put CHECKOUT back where the fixture built it; one test drags it out.
  await db.menuItem.update({ where: { id: card['CHECKOUT']! }, data: { sectionId } });
});

describe('resolveTarget — the one place the axes are interpreted', () => {
  it('takes only the named roles of a card', async () => {
    const ids = await resolveTarget(db, estimateId, {
      target: { scope: 'CARD', id: card['CHECKOUT']! },
      roles: ['DEV'],
    });
    expect(ids).toEqual([line['CHECKOUT:DEV']!]);
  });

  it('resolves an empty role list to nothing, not to everything', async () => {
    // The permissive reading is the one that does damage: a selection nobody
    // narrowed must not silently mean the whole card.
    for (const scope of ['ESTIMATE', 'SECTION', 'CARD'] as const) {
      const target =
        scope === 'ESTIMATE'
          ? ({ scope } as const)
          : scope === 'SECTION'
            ? ({ scope, id: sectionId } as const)
            : ({ scope, id: card['CHECKOUT']! } as const);
      expect(await resolveTarget(db, estimateId, { target, roles: [] })).toEqual([]);
    }
  });

  it('ignores roles for a line, which already is one role', async () => {
    const ids = await resolveTarget(db, estimateId, {
      target: { scope: 'LINE', id: line['CHECKOUT:QA']! },
      roles: [],
    });
    expect(ids).toEqual([line['CHECKOUT:QA']!]);
  });

  it('refuses to reach into another estimate', async () => {
    expect(
      await resolveTarget(db, estimateId, { target: { scope: 'LINE', id: foreignLineId }, roles: [] }),
    ).toEqual([]);
    // A real card id that really does carry DEV rows — just not on this
    // estimate. A placeholder id here would pass without testing anything.
    expect(
      await resolveTarget(db, estimateId, {
        target: { scope: 'CARD', id: foreignCardId },
        roles: ['DEV'],
      }),
    ).toEqual([]);
    // Proof the fixture is real: the same target resolves on its own estimate.
    expect(
      await resolveTarget(db, otherEstimateId, {
        target: { scope: 'CARD', id: foreignCardId },
        roles: ['DEV'],
      }),
    ).toEqual([foreignLineId]);
  });

  it('takes a section by current membership, and the estimate whole', async () => {
    const inSection = await resolveTarget(db, estimateId, {
      target: { scope: 'SECTION', id: sectionId },
      roles: ['DEV'],
    });
    expect(inSection.sort()).toEqual([line['CHECKOUT:DEV']!, line['REPORTS:DEV']!].sort());

    const whole = await resolveTarget(db, estimateId, {
      target: { scope: 'ESTIMATE' },
      roles: ['DEV'],
    });
    // Three cards carry rows; EMPTY carries none.
    expect(whole.length).toBe(3);
  });
});

describe('lockEnvelope', () => {
  it('materialises a card-scoped lock onto every row it covers', async () => {
    const res = await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'CARD', id: card['CHECKOUT']! }, roles: ['DEV', 'QA'] },
      actorId: alice,
    });
    expect(res.locked.length).toBe(2);
    const locks = await locksOn(db, [line['CHECKOUT:DEV']!, line['CHECKOUT:QA']!]);
    expect(locks.size).toBe(2);
    // Provenance: the declaration is kept, because sixteen locked rows look the
    // same whether one card was locked or sixteen rows were ticked.
    expect(locks.get(line['CHECKOUT:DEV']!)?.declaredScope).toBe('CARD');
    expect(locks.get(line['CHECKOUT:DEV']!)?.declaredTargetId).toBe(card['CHECKOUT']!);
  });

  it('is idempotent, and says whose locks it left alone', async () => {
    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'LINE', id: line['CHECKOUT:DEV']! }, roles: [] },
      actorId: bob,
    });

    const res = await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'CARD', id: card['CHECKOUT']! }, roles: ['DEV', 'QA'] },
      actorId: alice,
    });

    // DEV was Bob's already, so only QA is newly frozen — and the caller is told
    // rather than left to believe it locked both.
    expect(res.locked).toEqual([line['CHECKOUT:QA']!]);
    expect(res.alreadyLocked.map((l) => l.lockedById)).toEqual([bob]);
  });

  it('records a LOCKED event per row, in the same transaction', async () => {
    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'CARD', id: card['REPORTS']! }, roles: ['PM'] },
      actorId: alice,
    });
    const history = await lockHistoryFor(db, estimateId, line['REPORTS:PM']!);
    expect(history.map((e) => e.kind)).toEqual(['LOCKED']);
    expect(history[0]?.actorId).toBe(alice);
    expect(history[0]?.priorHolderId).toBeNull();
  });
});

describe('a coarse lock survives the card moving — the materialisation guarantee', () => {
  it('stays locked after the card leaves the locked section', async () => {
    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'SECTION', id: sectionId }, roles: ['DEV'] },
      actorId: alice,
    });

    // Placement is free, so this is an allowed move — and it is exactly the move
    // that would release the lock if membership were tested live instead of
    // pinned at lock time.
    await db.menuItem.update({ where: { id: card['CHECKOUT']! }, data: { sectionId: null } });

    const locks = await locksOn(db, [line['CHECKOUT:DEV']!]);
    expect(locks.has(line['CHECKOUT:DEV']!)).toBe(true);
    // And it is still refused as part of its card, not just findable by id.
    const hits = await lockedWithin(db, estimateId, {
      target: { scope: 'CARD', id: card['CHECKOUT']! },
      roles: ['DEV'],
    });
    expect(hits.length).toBe(1);
  });
});

describe('unlockEnvelope', () => {
  beforeEach(async () => {
    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'LINE', id: line['CHECKOUT:DEV']! }, roles: [] },
      actorId: alice,
    });
    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'LINE', id: line['CHECKOUT:QA']! }, roles: [] },
      actorId: bob,
    });
  });

  it('releases your own and leaves a colleague’s standing, saying so', async () => {
    const res = await unlockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'CARD', id: card['CHECKOUT']! }, roles: ['DEV', 'QA'] },
      actorId: alice,
    });
    // A partial release, not a refusal of the whole call: freeing your own row
    // must not fail because somebody holds another.
    expect(res.unlocked).toEqual([line['CHECKOUT:DEV']!]);
    expect(res.heldByOthers.map((l) => l.lockedById)).toEqual([bob]);
    expect((await locksOn(db, [line['CHECKOUT:QA']!])).size).toBe(1);
  });

  it('releases a colleague’s only with override, and records it as OVERRIDDEN', async () => {
    const res = await unlockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'CARD', id: card['CHECKOUT']! }, roles: ['DEV', 'QA'] },
      actorId: alice,
      override: true,
    });
    expect(res.unlocked.sort()).toEqual([line['CHECKOUT:DEV']!, line['CHECKOUT:QA']!].sort());
    expect(res.heldByOthers).toEqual([]);

    // Alice's own release is UNLOCKED; Bob's is OVERRIDDEN, and it names Bob.
    // The kind follows whose lock it was, not who clicked.
    const mine = await lockHistoryFor(db, estimateId, line['CHECKOUT:DEV']!);
    expect(mine.map((e) => e.kind)).toEqual(['LOCKED', 'UNLOCKED']);
    const theirs = await lockHistoryFor(db, estimateId, line['CHECKOUT:QA']!);
    expect(theirs.map((e) => e.kind)).toEqual(['LOCKED', 'OVERRIDDEN']);
    expect(theirs.at(-1)?.actorId).toBe(alice);
    expect(theirs.at(-1)?.priorHolderId).toBe(bob);
  });

  it('leaves the history behind once the lock is gone', async () => {
    await unlockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'LINE', id: line['CHECKOUT:DEV']! }, roles: [] },
      actorId: alice,
    });
    expect((await locksOn(db, [line['CHECKOUT:DEV']!])).size).toBe(0);
    // The point of the event table: a released lock is still answerable for.
    expect((await lockHistoryFor(db, estimateId, line['CHECKOUT:DEV']!)).length).toBe(2);
  });
});

describe('lockStateFor — the two derived card facts', () => {
  it('separates a partly frozen card from a fully frozen one', async () => {
    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'CARD', id: card['CHECKOUT']! }, roles: ['DEV'] },
      actorId: alice,
    });
    await lockEnvelope(db, {
      estimateId,
      envelope: { target: { scope: 'CARD', id: card['REPORTS']! }, roles: ['DEV', 'QA', 'PM', 'BA'] },
      actorId: alice,
    });

    const state = await lockStateFor(db, estimateId);
    expect(state.cardsWithAnyLock.has(card['CHECKOUT']!)).toBe(true);
    // One role frozen says nothing about the card's title.
    expect(state.cardsFullyLocked.has(card['CHECKOUT']!)).toBe(false);
    expect(state.cardsFullyLocked.has(card['REPORTS']!)).toBe(true);
  });

  it('reaches a fully frozen card the same way whichever route got there', async () => {
    // Four separate role-scoped locks must equal one card-scoped lock, because
    // the fact is derived rather than stored.
    for (const role of ['DEV', 'QA', 'PM', 'BA'] as const) {
      await lockEnvelope(db, {
        estimateId,
        envelope: { target: { scope: 'CARD', id: card['LOOSE']! }, roles: [role] },
        actorId: alice,
      });
    }
    const state = await lockStateFor(db, estimateId);
    expect(state.cardsFullyLocked.has(card['LOOSE']!)).toBe(true);
  });

  it('does not call an empty card locked', async () => {
    const state = await lockStateFor(db, estimateId);
    expect(state.cardsFullyLocked.has(emptyCardId)).toBe(false);
    expect(state.cardsWithAnyLock.has(emptyCardId)).toBe(false);
  });
});
