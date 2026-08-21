import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import {
  loadAgentState,
  persistAgentState,
  applyItemTweak,
  recordRevision,
  computeMenuItemDiffs,
} from './refinement';
import { MenuItemSchema, RequirementSchema, type MenuItem, type Requirement } from '@repo/shared';
import type { TaxationConfig } from './taxation';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const taxConfig: TaxationConfig = {
  pmCommunicationTaxPct: 0.15,
  baCommunicationTaxPct: 0.10,
  qaRegressionBufferPct: 0.20,
};

let userId = '';
let estimateId = '';

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `ws18-test-${Date.now()}@example.com`, hash: 'hash', role: 'ESTIMATOR' },
  });
  userId = user.id;

  const est = await db.estimate.create({
    data: {
      title: 'WS18 Refinement Test',
      sowText: 'Build a B2B checkout',
      sowHash: '',
      status: 'DRAFT',
      taxonomyVersionsPinned: {},
      configVersion: 1,
      promptVersionsPinned: {},
      modelConfig: {},
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
  });
  estimateId = est.id;
});

afterAll(async () => {
  await db.menuItem.deleteMany({ where: { estimateId } });
  await db.estimate.delete({ where: { id: estimateId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

function makeMenuItem(id: string, devH = 40, qaH = 15): MenuItem {
  const lineItems = [
    { role: 'DEV', baseHours: devH, taxedHours: devH, edited: false },
    { role: 'QA', baseHours: qaH, taxedHours: Math.round(qaH * 1.2), edited: false },
    { role: 'PM', baseHours: 8, taxedHours: 9, edited: false },
    { role: 'BA', baseHours: 10, taxedHours: 11, edited: false },
  ];
  return MenuItemSchema.parse({ id, taxonomyKey: `feature.${id}`, title: id, enabled: true, lineItems });
}


/** A schema-valid Requirement. Only the fields a test varies are worth naming. */
function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return RequirementSchema.parse({
    id: 'REQ-001',
    text: 'Build B2B checkout flow',
    category: 'B2B',
    reqType: 'Checkout',
    projectSize: 'Mid-market',
    dataVolume: 'Low',
    integrationCount: 1,
    candidateMenuCardId: 'MC-B2B-CHECKOUT',
    taxonomyKey: 'b2b.checkout',
    sourceRef: 'SOW',
    ...overrides,
  });
}

// ─── WS18-01: Persist + load agentState ──────────────────────────────────────

describe('WS18-01: Persist full agentState; load on refine', () => {
  it('persists and loads agentState without re-running agents', async () => {
    const state = {
      librarianOutput: {
        requirements: [makeRequirement({ text: 'Build checkout', taxonomyKey: 'b2b.checkout' })],
      },
    };

    await persistAgentState(db, estimateId, state);
    const loaded = await loadAgentState(db, estimateId);

    expect(loaded.librarianOutput).toBeDefined();
    expect(loaded.librarianOutput?.requirements[0]?.text).toBe('Build checkout');
  });

  it('refine mode preserves prior state keys', async () => {
    const prior = {
      librarianOutput: {
        requirements: [makeRequirement({ text: 'Prior req', taxonomyKey: 'prior' })],
      },
      archivistOutput: { matches: [] },
    };
    await persistAgentState(db, estimateId, prior);

    const loaded = await loadAgentState(db, estimateId);
    expect(loaded.librarianOutput).toBeDefined();
    expect(loaded.archivistOutput).toBeDefined();
  });
});

// ─── WS18-02: Module-level tweak API ─────────────────────────────────────────

describe('WS18-02: Tweak one item — others byte-identical; downstream updates', () => {
  it('editing one item leaves others unchanged', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b'), makeMenuItem('item-c')];

    const { menuItems: result } = applyItemTweak(
      items,
      { menuItemId: 'item-b', role: 'DEV', newBaseHours: 60 },
      taxConfig,
    );

    const itemA = result.find((m) => m.id === 'item-a')!;
    const itemC = result.find((m) => m.id === 'item-c')!;
    expect(itemA.lineItems[0]!.baseHours).toBe(40); // unchanged
    expect(itemC.lineItems[0]!.baseHours).toBe(40); // unchanged
  });

  it('downstream rollup updates after edit', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b')];

    const { rollup } = applyItemTweak(
      items,
      { menuItemId: 'item-a', role: 'DEV', newBaseHours: 100 },
      taxConfig,
    );

    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(140); // 100 + 40
  });

  it('taxedHours recomputed from new baseHours after edit', () => {
    const items = [makeMenuItem('item-a')];

    const { menuItems: result } = applyItemTweak(
      items,
      { menuItemId: 'item-a', role: 'QA', newBaseHours: 30 },
      taxConfig,
    );

    const qaLi = result[0]!.lineItems.find((li) => li.role === 'QA')!;
    expect(qaLi.baseHours).toBe(30);
    expect(qaLi.taxedHours).toBe(Math.round(30 * 1.20)); // 36
    expect(qaLi.edited).toBe(true);
  });
});

// ─── WS18-03: Estimate revision history ──────────────────────────────────────

describe('WS18-03: Revision history — each refinement recorded with diffs', () => {
  it('records a revision when items change', () => {
    const before = [makeMenuItem('item-a', 40)];
    const after = [{ ...makeMenuItem('item-a', 60) }];

    const revisions = recordRevision([], before, after, 'user@example.com');

    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.revisionNumber).toBe(1);
    expect(revisions[0]!.diffs.length).toBeGreaterThan(0);
  });

  it('revision includes diffs with field/before/after', () => {
    const before = [makeMenuItem('item-a', 40)];
    const after = [{ ...makeMenuItem('item-a', 80) }];

    const diffs = computeMenuItemDiffs(before, after);

    expect(diffs.length).toBeGreaterThan(0);
    const devDiff = diffs.find((d) => d.field === 'DEV.baseHours');
    expect(devDiff?.before).toBe(40);
    expect(devDiff?.after).toBe(80);
  });

  it('no revision recorded when nothing changes', () => {
    const items = [makeMenuItem('item-a', 40)];
    const revisions = recordRevision([], items, items, 'user@example.com');
    expect(revisions).toHaveLength(0);
  });

  it('revision numbers increment across multiple refinements', () => {
    const v1 = [makeMenuItem('item-a', 40)];
    const v2 = [{ ...makeMenuItem('item-a', 60) }];
    const v3 = [{ ...makeMenuItem('item-a', 80) }];

    const rev1 = recordRevision([], v1, v2, 'user@example.com');
    const rev2 = recordRevision(rev1, v2, v3, 'user@example.com');

    expect(rev2[0]!.revisionNumber).toBe(1);
    expect(rev2[1]!.revisionNumber).toBe(2);
  });
});
