import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from './generated/client/index.js';
import { forkEstimate } from './fork';
import { familiesOf, projectNameOf, rootOf } from './lineage';

/**
 * AEH-375. Deleting an estimate keeps everything.
 *
 * The unit tests next to `deleteEstimate` prove it writes a stamp rather than
 * calling `delete`. That is necessary and nowhere near sufficient: the claim
 * this ticket actually makes is that the whole subtree is still there
 * afterwards and comes back untouched, and nothing about a mocked Prisma
 * client can show that. Only a real cascade can fail to happen.
 *
 * So everything here runs against Postgres, and the assertions are about rows:
 * the cards, line items, statements and scenarios under a deleted estimate,
 * the ids they keep, and a fork's carried marks still pointing at rows that
 * exist. The id claim is the load-bearing one — it is the entire reason soft
 * delete was chosen over snapshotting the subtree to JSON, because a restored
 * row would get a new id and every carried mark, promoted preset and scope
 * pick would be left pointing at nothing.
 *
 * The lineage tests pin the other half of the design. `rootOf` already treats
 * a parent it cannot see as absent, so filtering deleted rows out of the node
 * set makes a deleted parent's children read as originals — and recovering the
 * parent puts the family back together with no repair step at all. That was
 * the cheapest thing about this feature and it is worth a test that would
 * notice if the helper's tolerance were ever tightened.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let adminId = '';
const made: string[] = [];

/** The node shape every lineage helper takes, as a live read would build it. */
async function visibleNodes() {
  return db.estimate.findMany({
    where: { deletedAt: null, ownerId: { in: [userId, adminId] } },
    select: { id: true, parentId: true, projectName: true, title: true },
  });
}

async function newEstimate(title: string, over: Record<string, unknown> = {}): Promise<string> {
  const est = await db.estimate.create({
    data: {
      title,
      sowText: 'The original brief, at length.',
      status: 'REVIEW',
      configVersion: 7,
      agentState: {},
      ownerId: userId,
      ...over,
    },
    select: { id: true },
  });
  made.push(est.id);
  return est.id;
}

/** A card with one DEV row and one assumption, so there is a subtree to lose. */
async function furnish(estimateId: string): Promise<{ cardId: string; lineId: string }> {
  const card = await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: `softdel.card.${Math.random().toString(36).slice(2, 10)}`,
      title: 'Work that must survive',
      lineItems: {
        create: [{ role: 'DEV', title: 'Build it', baseHours: 33, taxedHours: 40 }],
      },
    },
    select: { id: true, lineItems: { select: { id: true } } },
  });
  await db.estimateStatement.create({
    data: { estimateId, kind: 'ASSUMPTION', order: 0, text: 'The client supplies the copy.' },
  });
  return { cardId: card.id, lineId: card.lineItems[0]!.id };
}

beforeAll(async () => {
  await db.$connect();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [a, b] = await Promise.all([
    db.user.create({ data: { email: `softdel-${stamp}@example.com`, hash: 'x', role: 'ESTIMATOR' } }),
    db.user.create({ data: { email: `softdel-admin-${stamp}@example.com`, hash: 'x', role: 'ADMIN' } }),
  ]);
  userId = a.id;
  adminId = b.id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [userId, adminId] } } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(() => {
  made.length = 0;
});

afterEach(async () => {
  // Children first: parentId is SetNull, so deleting a parent orphans rather
  // than cascades and the child would outlive teardown.
  for (const id of [...made].reverse()) {
    await db.estimate.delete({ where: { id } }).catch(() => {});
  }
});

describe('deleting keeps the whole subtree', () => {
  it('leaves every card, line item and statement exactly where it was', async () => {
    const id = await newEstimate('Acme CRM');
    const { cardId, lineId } = await furnish(id);

    await db.estimate.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: adminId },
    });

    // The rows, by their ORIGINAL ids. Anything that re-created them would
    // fail here even if the counts matched.
    const card = await db.menuItem.findUnique({ where: { id: cardId } });
    const line = await db.roleLineItem.findUnique({ where: { id: lineId } });
    const statements = await db.estimateStatement.count({ where: { estimateId: id } });

    expect(card).not.toBeNull();
    expect(card!.title).toBe('Work that must survive');
    expect(line).not.toBeNull();
    expect(line!.baseHours).toBe(33);
    expect(line!.taxedHours).toBe(40);
    expect(statements).toBe(1);
  });

  it('records who deleted it and when', async () => {
    const id = await newEstimate('Acme CRM');
    const before = new Date();
    await db.estimate.update({
      where: { id },
      data: { deletedAt: new Date(), deletedById: adminId },
    });

    const row = await db.estimate.findUniqueOrThrow({
      where: { id },
      select: { deletedAt: true, deletedBy: { select: { role: true } } },
    });
    expect(row.deletedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(row.deletedBy!.role).toBe('ADMIN');
  });

  it('recovering restores the same rows, not copies of them', async () => {
    const id = await newEstimate('Acme CRM');
    const { cardId, lineId } = await furnish(id);

    await db.estimate.update({ where: { id }, data: { deletedAt: new Date(), deletedById: userId } });
    await db.estimate.update({ where: { id }, data: { deletedAt: null, deletedById: null } });

    const row = await db.estimate.findUniqueOrThrow({
      where: { id },
      select: {
        deletedAt: true,
        deletedById: true,
        menuItems: { select: { id: true, lineItems: { select: { id: true } } } },
      },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.deletedById).toBeNull();
    expect(row.menuItems.map((c) => c.id)).toEqual([cardId]);
    expect(row.menuItems[0]!.lineItems.map((l) => l.id)).toEqual([lineId]);
  });

  it('a fork of a deleted estimate still points at rows that exist', async () => {
    // The reason this is soft delete and not a JSON snapshot. A restored row
    // would carry a new id and every carried mark below would dangle.
    const parentId = await newEstimate('Acme CRM — round 1');
    await furnish(parentId);
    const out = await forkEstimate(db, {
      parentId,
      title: 'Acme CRM — round 2',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    if (out.kind !== 'ok') throw new Error(`fork refused: ${JSON.stringify(out)}`);
    made.push(out.estimateId);

    await db.estimate.update({
      where: { id: parentId },
      data: { deletedAt: new Date(), deletedById: userId },
    });

    const carried = await db.roleLineItem.findFirstOrThrow({
      where: { menuItem: { estimateId: out.estimateId } },
      select: { carriedFromId: true },
    });
    expect(carried.carriedFromId).not.toBeNull();
    // The row it names is still there — which under a hard delete it would not
    // have been, and under a snapshot-and-recreate it would be a different row.
    const source = await db.roleLineItem.findUnique({ where: { id: carried.carriedFromId! } });
    expect(source).not.toBeNull();

    // And the child keeps its real parent pointer. Nothing was re-pointed.
    const child = await db.estimate.findUniqueOrThrow({
      where: { id: out.estimateId },
      select: { parentId: true },
    });
    expect(child.parentId).toBe(parentId);
  });

  it('forking a deleted estimate is refused', async () => {
    const parentId = await newEstimate('Acme CRM');
    await furnish(parentId);
    await db.estimate.update({
      where: { id: parentId },
      data: { deletedAt: new Date(), deletedById: userId },
    });

    const out = await forkEstimate(db, {
      parentId,
      title: 'Round 2',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    // A live child of an invisible parent would read as an original on the
    // dashboard while carrying marks into a document nobody can open.
    expect(out.kind).toBe('refused');
  });
});

describe('a deleted parent takes itself out of the family, not its children', () => {
  it('the child reads as an original while the parent is deleted', async () => {
    const parentId = await newEstimate('Acme CRM — round 1', { projectName: 'Acme CRM' });
    const childId = await newEstimate('Acme CRM — round 2', {
      parentId,
      lineageKind: 'SUCCESSOR',
      projectName: 'Acme CRM',
    });

    // Live: one family of two, rooted at the parent.
    let nodes = await visibleNodes();
    expect(rootOf(nodes, childId)?.id).toBe(parentId);
    expect(familiesOf(nodes).size).toBe(1);

    await db.estimate.update({
      where: { id: parentId },
      data: { deletedAt: new Date(), deletedById: userId },
    });

    // Deleted: the child stands alone, and is its own root.
    nodes = await visibleNodes();
    expect(nodes.map((n) => n.id)).toEqual([childId]);
    expect(rootOf(nodes, childId)?.id).toBe(childId);
    expect(familiesOf(nodes).size).toBe(1);

    // Its parentId is untouched in the database — the family is hidden, not
    // dismantled, which is what makes recovery free.
    const row = await db.estimate.findUniqueOrThrow({
      where: { id: childId },
      select: { parentId: true },
    });
    expect(row.parentId).toBe(parentId);
  });

  it('the family keeps its name while the root is deleted', async () => {
    // `projectName` is denormalised onto every member for exactly this case.
    const parentId = await newEstimate('Acme CRM — round 1', { projectName: 'Acme CRM' });
    const childId = await newEstimate('Acme CRM — round 2', {
      parentId,
      lineageKind: 'SUCCESSOR',
      projectName: 'Acme CRM',
    });
    await db.estimate.update({
      where: { id: parentId },
      data: { deletedAt: new Date(), deletedById: userId },
    });

    const nodes = await visibleNodes();
    const members = [...familiesOf(nodes).values()][0]!;
    const root = rootOf(nodes, childId)!;
    expect(projectNameOf(members, root)).toBe('Acme CRM');
  });

  it('recovering the parent puts the family back with no repair step', async () => {
    const parentId = await newEstimate('Acme CRM — round 1', { projectName: 'Acme CRM' });
    const childId = await newEstimate('Acme CRM — round 2', {
      parentId,
      lineageKind: 'SUCCESSOR',
      projectName: 'Acme CRM',
    });

    await db.estimate.update({
      where: { id: parentId },
      data: { deletedAt: new Date(), deletedById: userId },
    });
    // Clearing the stamp is the entire recovery. Nothing rewrites parentId.
    await db.estimate.update({
      where: { id: parentId },
      data: { deletedAt: null, deletedById: null },
    });

    const nodes = await visibleNodes();
    expect(rootOf(nodes, childId)?.id).toBe(parentId);
    expect(familiesOf(nodes).size).toBe(1);
    expect([...familiesOf(nodes).values()][0]).toHaveLength(2);
  });

  it('a deleted child drops out of its parent’s family', async () => {
    const parentId = await newEstimate('Acme CRM — round 1', { projectName: 'Acme CRM' });
    const childId = await newEstimate('Acme CRM — round 2', {
      parentId,
      lineageKind: 'SUCCESSOR',
      projectName: 'Acme CRM',
    });

    await db.estimate.update({
      where: { id: childId },
      data: { deletedAt: new Date(), deletedById: userId },
    });

    const nodes = await visibleNodes();
    expect(nodes.map((n) => n.id)).toEqual([parentId]);
    expect([...familiesOf(nodes).values()][0]).toHaveLength(1);
  });
});
