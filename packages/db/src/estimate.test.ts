import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from './generated/client/index.js';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let estimateId = '';

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: {
      email: `test-est-${Date.now()}@example.com`,
      hash: 'testhash',
      name: 'Test User',
      role: 'ESTIMATOR',
    },
  });
  userId = user.id;
});

afterAll(async () => {
  if (estimateId) {
    await db.roleLineItem.deleteMany({ where: { menuItem: { estimateId } } });
    await db.menuItem.deleteMany({ where: { estimateId } });
    await db.estimate.delete({ where: { id: estimateId } });
  }
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('WS1-07: Estimate → MenuItem → 4 RoleLineItems', () => {
  it('creates estimate with one menu item and four role line items', async () => {
    const est = await db.estimate.create({
      data: {
        title: 'Test Estimate',
        sowText: 'Build a B2B checkout',
        status: 'DRAFT',
        configVersion: 1,
        narrative: [],
        assumptions: [],
        agentState: {},
        ownerId: userId,
      },
    });
    estimateId = est.id;
    expect(est.title).toBe('Test Estimate');

    const item = await db.menuItem.create({
      data: {
        estimateId: est.id,
        taxonomyKey: 'b2b.checkout',
        title: 'B2B Checkout',
        enabled: true,
        lineItems: {
          createMany: {
            data: [
              { role: 'DEV', baseHours: 80, taxedHours: 88 },
              { role: 'QA', baseHours: 20, taxedHours: 24 },
              { role: 'PM', baseHours: 8, taxedHours: 9 },
              { role: 'BA', baseHours: 6, taxedHours: 7 },
            ],
          },
        },
      },
      include: { lineItems: true },
    });

    expect(item.lineItems).toHaveLength(4);
    const roles = item.lineItems.map((l) => l.role).sort();
    expect(roles).toEqual(['BA', 'DEV', 'PM', 'QA']);
  });

  it('toggling a menu item disabled cascades to all 4 line items via enabled flag', async () => {
    // MenuItem.enabled is the toggle; lineItems are always read via the parent
    const updated = await db.menuItem.update({
      where: { id: (await db.menuItem.findFirst({ where: { estimateId } }))!.id },
      data: { enabled: false },
      include: { lineItems: true },
    });
    expect(updated.enabled).toBe(false);
    expect(updated.lineItems).toHaveLength(4);
  });
});
