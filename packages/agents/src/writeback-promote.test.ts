import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@repo/db';
import { promoteEstimate, promoteMenuItemsToPresets, PROMOTION_MATCH_THRESHOLD } from './writeback';
import { MenuItemSchema, RoleLineItemSchema, type MenuItem, type RoleLineItem } from '@repo/shared';

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

// Parsed, not cast. `as MenuItem` on an input-shaped literal is the
// z.input/z.infer trap that hid 47 errors while CI was down (4271478): every
// `.default()` field is required on the OUTPUT type but optional on the input,
// so a cast silently leaves it absent at runtime. Parsing applies the defaults,
// which is also why adding `injected` did not have to be hand-written here.
const li = (role: RoleLineItem['role'], hours: number, side?: 'fe' | 'be' | 'both'): RoleLineItem =>
  RoleLineItemSchema.parse({
    role,
    baseHours: hours,
    taxedHours: hours,
    edited: false,
    touchesFrontend: side === 'fe' || side === 'both',
    touchesBackend: side === 'be' || side === 'both',
  });

const card = (over: Partial<MenuItem>): MenuItem =>
  MenuItemSchema.parse({
    id: 'MC-TEST',
    taxonomyKey: 'storefront.checkout',
    title: 'Checkout extension',
    enabled: true,
    lineItems: [li('DEV', 20, 'be'), li('DEV', 10, 'fe'), li('QA', 8)],
    ...over,
  });

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
      status: 'REVIEW',
      configVersion: 1,
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
      devHours: 58,
      touchesBackend: true,
      touchesFrontend: false,
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
    // Hours come from THIS estimate, as one figure: 20 + 10 = 30.
    expect(v?.devHours).toBe(30);
    // Flags reflect what this estimate tagged, and the legacy split is not rewritten.
    expect(v?.touchesBackend).toBe(true);
    expect(v?.touchesFrontend).toBe(true);
    expect(v?.beHours).toBeNull();
    expect(v?.feHours).toBeNull();
    // Metadata the estimate has no opinion about is carried forward, not reset.
    expect(v?.keywords).toEqual(['checkout', 'b2b']);
    expect(v?.risk).toBe('HIGH');
    expect(v?.spikeNeeded).toBe(true);
    expect(v?.changeMotivation).toBe('POST_DELIVERY_VALIDATION');
    expect(v?.changeReason).toMatch(/frontend and backend/);
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

    // The new preset gets an opaque cuid id and a readable, allocated code —
    // nothing synthesises an id from the estimate any more, and no human picks
    // a number. Provenance lives in `origin`, not in the code's shape.
    const minted = await db.preset.findUniqueOrThrow({ where: { id: result.created[0]! } });
    expect(minted.origin).toBe('FINALISED');
    expect(minted.code).toMatch(/^P\d+$/);
    expect(minted.id).not.toMatch(/^P\d+$/); // id is a cuid, not the code

    // The established preset is untouched — still v1, still its own hours.
    const v = await activeVersion(MATCHED);
    expect(v?.version).toBe(1);
    expect(v?.devHours).toBe(58);
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
    // Card DEV total is 30. The old code stored be=30 + fe=12 = 42.
    expect(v!.devHours).toBe(30);
  });

  it('carries prior flags forward when the estimate tagged nothing', async () => {
    // Otherwise promoting an untagged card onto a matched preset would erase
    // the flag information that preset already held.
    const untagged = card({
      sourcePresetId: MATCHED,
      matchScore: 0.9,
      lineItems: [li('DEV', 40)],
    });

    await promoteMenuItemsToPresets(db, estimateId, [untagged]);

    const v = await activeVersion(MATCHED);
    expect(v?.devHours).toBe(40);
    expect(v?.touchesBackend).toBe(true); // preserved from v1, not overwritten
    expect(v?.touchesFrontend).toBe(false);
    expect(v?.changeReason).toMatch(/no side tags/);
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

  it('promotes an inferred card — reviewed work is delivered work', async () => {
    const result = await promoteMenuItemsToPresets(db, estimateId, [card({ injected: true })]);
    result.promoted.forEach((p) => createdPresetIds.add(p));
    expect(result.promoted).toHaveLength(1);
  });

  /**
   * AEH-227 excluded every injected row here, and was right to: those cards
   * carried invented flat hours (DEV 8 / QA 4 / PM 2 / BA 2 regardless of
   * anything), and letting that into the library would have poisoned the anchor
   * every future estimate reads.
   *
   * The hours are the Specialist council's now, so the exclusion inverted. What
   * carries the safety instead is `enabled`: promotion only ever runs on a
   * FINALISED estimate, and an estimator who finalises with an inferred card
   * switched on has reviewed it and stood behind it. Switching it off is how
   * they say no, and the case below proves that still holds.
   *
   * Goes through `promoteEstimate` — reading real rows — because that is the
   * only path that exercises the query filter. Asserting the ordinary card
   * promotes too matters as much: a filter that excluded everything would pass
   * a bare length check.
   */
  it('promotes an inferred card read back from the database, alongside an ordinary one', async () => {
    await db.menuItem.create({
      data: {
        estimateId,
        taxonomyKey: 'infra.data-migration',
        title: 'Data Remediation & Migration',
        enabled: true,
        injected: true,
        lineItems: { create: [{ role: 'DEV', baseHours: 8, taxedHours: 8 }] },
      },
    });
    await db.menuItem.create({
      data: {
        estimateId,
        taxonomyKey: 'storefront.checkout',
        title: 'Real delivered feature',
        enabled: true,
        injected: false,
        lineItems: { create: [{ role: 'DEV', baseHours: 12, taxedHours: 12, touchesBackend: true }] },
      },
    });

    const result = await promoteEstimate(db, estimateId);
    result.promoted.forEach((p) => createdPresetIds.add(p));

    expect(result.promoted).toHaveLength(2);
    const names = await Promise.all(result.promoted.map(async (id) => (await activeVersion(id))!.name));
    expect(names.sort()).toEqual(['Data Remediation & Migration', 'Real delivered feature']);
  });

  it('still excludes an inferred card the estimator switched off', async () => {
    await db.menuItem.create({
      data: {
        estimateId,
        taxonomyKey: 'infra.rate-limit',
        title: 'Rate Limit Management & Throttling',
        enabled: false,
        injected: true,
        lineItems: { create: [{ role: 'DEV', baseHours: 6, taxedHours: 6 }] },
      },
    });

    const result = await promoteEstimate(db, estimateId);
    result.promoted.forEach((p) => createdPresetIds.add(p));
    expect(result.promoted).toEqual([]);
  });

  it('skips disabled cards — work switched off is not delivered work', async () => {
    const result = await promoteMenuItemsToPresets(db, estimateId, [card({ enabled: false })]);
    expect(result.promoted).toEqual([]);
  });

  it('records untagged dev work honestly rather than guessing a split', async () => {
    const result = await promoteMenuItemsToPresets(db, estimateId, [
      card({ lineItems: [li('DEV', 50)] }),
    ]);
    result.promoted.forEach((p) => createdPresetIds.add(p));

    const v = await activeVersion(result.created[0]!);
    expect(v!.devHours).toBe(50);
    expect(v!.touchesBackend).toBe(false);
    expect(v!.touchesFrontend).toBe(false);
    expect(v!.changeReason).toMatch(/no side tags/);
  });
});
