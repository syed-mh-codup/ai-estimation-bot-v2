import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@repo/db';
import { promoteMenuItemsToPresets, PROMOTION_MATCH_THRESHOLD } from './writeback';
import type { MenuItem, RoleLineItem } from '@repo/shared';

/**
 * Hybrid promotion: a card that matched an existing preset *confidently* becomes
 * a new version of it (so the library learns from delivered work); a weak or
 * absent match mints a new preset instead (so a family resemblance can't
 * overwrite the anchor every future estimate reads).
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const MATCHED = 'TEST-PROMO-MATCHED';
let userId = '';
let estimateId = '';
const createdPresetIds = new Set<string>([MATCHED]);

const li = (role: RoleLineItem['role'], hours: number, side?: 'fe' | 'be' | 'both'): RoleLineItem =>
  ({
    role,
    baseHours: hours,
    taxedHours: hours,
    edited: false,
    aiAssistApplied: false,
    dependsOn: [],
    anchorPresetIds: [],
    touchesFrontend: side === 'fe' || side === 'both',
    touchesBackend: side === 'be' || side === 'both',
  }) as RoleLineItem;

const card = (over: Partial<MenuItem>): MenuItem =>
  ({
    id: 'MC-TEST',
    taxonomyKey: 'storefront.checkout',
    title: 'Checkout extension',
    enabled: true,
    requirementIds: [],
    toggleable: true,
    notSafelyRemovable: false,
    thinSlice: false,
    lineItems: [li('DEV', 20, 'be'), li('DEV', 10, 'fe'), li('QA', 8)],
    ...over,
  }) as MenuItem;

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `promo-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.presetVersion.deleteMany({ where: { presetId: { in: [...createdPresetIds] } } });
  await db.preset.deleteMany({ where: { id: { in: [...createdPresetIds] } } });
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  // Fresh estimate per test so the sourceEstimateId idempotency key is clean.
  const est = await db.estimate.create({
    data: {
      title: 'Promotion test',
      sowText: 'x',
      sowHash: '',
      status: 'REVIEW',
      configVersion: 1,
      taxonomyVersionsPinned: {},
      promptVersionsPinned: {},
      modelConfig: {},
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
  });
  estimateId = est.id;

  // An established preset for the card to match against.
  await db.presetVersion.deleteMany({ where: { presetId: MATCHED } });
  await db.preset.upsert({ where: { id: MATCHED }, update: {}, create: { id: MATCHED } });
  await db.presetVersion.create({
    data: {
      presetId: MATCHED,
      version: 1,
      active: true,
      category: 'Storefront',
      name: 'Established checkout preset',
      description: 'Seeded by the promotion test.',
      beHours: 40,
      feHours: 18,
      platforms: ['shopify'],
      reqType: 'FEATURE',
      keywords: ['checkout', 'b2b'],
      userStoryTags: ['tag'],
      projectSizeFit: ['Mid-market'],
      integrationCount: 2,
      dataVolume: 'HIGH',
      phase: 'CORE',
      requires: [],
      blocks: [],
      canParallel: true,
      aiAssist: 'MEDIUM',
      risk: 'HIGH',
      spikeNeeded: true,
      notes: 'established notes',
      taxonomyKey: 'storefront.checkout',
    },
  });
});

async function activeVersion(presetId: string) {
  return db.presetVersion.findFirst({ where: { presetId, active: true } });
}

describe('promoteMenuItemsToPresets — hybrid target selection', () => {
  it('versions the matched preset on a confident match, keeping its metadata', async () => {
    const items = [
      card({ sourcePresetId: MATCHED, matchScore: PROMOTION_MATCH_THRESHOLD + 0.05 }),
    ];

    const result = await promoteMenuItemsToPresets(db, estimateId, items);

    expect(result.versioned).toEqual([MATCHED]);
    expect(result.created).toEqual([]);

    const v = await activeVersion(MATCHED);
    expect(v?.version).toBe(2);
    // Hours come from THIS estimate, exactly: 20 backend + 10 frontend.
    expect(v?.beHours).toBe(20);
    expect(v?.feHours).toBe(10);
    // Metadata the estimate has no opinion about is carried forward, not reset.
    expect(v?.keywords).toEqual(['checkout', 'b2b']);
    expect(v?.risk).toBe('HIGH');
    expect(v?.spikeNeeded).toBe(true);
    expect(v?.changeMotivation).toBe('POST_DELIVERY_VALIDATION');
    expect(v?.changeReason).toMatch(/exact/);
    // v1 is retained, deactivated.
    const all = await db.presetVersion.findMany({ where: { presetId: MATCHED } });
    expect(all).toHaveLength(2);
    expect(all.filter((x) => x.active)).toHaveLength(1);
  });

  it('mints a new preset when the match is too weak to trust', async () => {
    const weak = PROMOTION_MATCH_THRESHOLD - 0.2;
    const items = [card({ sourcePresetId: MATCHED, matchScore: weak })];

    const result = await promoteMenuItemsToPresets(db, estimateId, items);
    result.promoted.forEach((p) => createdPresetIds.add(p));

    expect(result.versioned).toEqual([]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]).toMatch(/^promoted-/);

    // The established preset is untouched — still v1, still its own hours.
    const v = await activeVersion(MATCHED);
    expect(v?.version).toBe(1);
    expect(v?.beHours).toBe(40);
    expect(v?.feHours).toBe(18);
  });

  it('mints a new preset when there was no match at all', async () => {
    const result = await promoteMenuItemsToPresets(db, estimateId, [card({})]);
    result.promoted.forEach((p) => createdPresetIds.add(p));
    expect(result.created).toHaveLength(1);
    expect(result.versioned).toEqual([]);
  });

  it('stores the DEV total, not 1.4x it — the old fabrication', async () => {
    const result = await promoteMenuItemsToPresets(db, estimateId, [card({})]);
    result.promoted.forEach((p) => createdPresetIds.add(p));

    const v = await activeVersion(result.created[0]!);
    // Card DEV total is 30 (20 be + 10 fe). The old code stored be=30, fe=12.
    expect(v!.beHours + v!.feHours).toBe(30);
    expect(v!.beHours).toBe(20);
    expect(v!.feHours).toBe(10);
  });

  it('is idempotent — re-finalising the same estimate adds no versions', async () => {
    const items = [card({ sourcePresetId: MATCHED, matchScore: 0.9 })];

    await promoteMenuItemsToPresets(db, estimateId, items);
    const second = await promoteMenuItemsToPresets(db, estimateId, items);

    expect(second.skipped).toEqual([MATCHED]);
    expect(second.promoted).toEqual([]);
    const all = await db.presetVersion.findMany({ where: { presetId: MATCHED } });
    expect(all).toHaveLength(2); // v1 + one promotion, not three
  });

  it('never promotes injected baseline or hidden-work placeholders', async () => {
    const result = await promoteMenuItemsToPresets(db, estimateId, [
      card({ id: 'baseline-env-setup' }),
      card({ id: 'hidden-data-migration' }),
    ]);
    expect(result.promoted).toEqual([]);
  });

  it('skips disabled cards — work switched off is not delivered work', async () => {
    const result = await promoteMenuItemsToPresets(db, estimateId, [card({ enabled: false })]);
    expect(result.promoted).toEqual([]);
  });

  it('marks the split as apportioned when the dev rows carry no tags', async () => {
    const untagged = card({ lineItems: [li('DEV', 50)] });
    const result = await promoteMenuItemsToPresets(db, estimateId, [untagged]);
    result.promoted.forEach((p) => createdPresetIds.add(p));

    const v = await activeVersion(result.created[0]!);
    expect(v!.beHours + v!.feHours).toBe(50);
    expect(v!.changeReason).toMatch(/apportioned/);
  });
});
