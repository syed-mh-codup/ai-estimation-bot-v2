import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import {
  backfillPresetEmbeddings,
  promoteMenuItemsToPresets,
  recordActuals,
} from './writeback';
import type { IEmbeddingProvider } from '@repo/providers';
import { MenuItemSchema, type MenuItem } from '@repo/shared';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

function makeVec(dim: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[dim] = 1.0;
  return v;
}

const mockEmbedding: IEmbeddingProvider = { embed: vi.fn(), dimension: 1536 };

let userId = '';
let estimateId = '';

// Track IDs for cleanup
const promotedPresetIds: string[] = [];

beforeAll(async () => {
  await db.$connect();

  const user = await db.user.create({
    data: { email: `ws20-test-${Date.now()}@example.com`, hash: 'hash', role: 'ESTIMATOR' },
  });
  userId = user.id;

  const est = await db.estimate.create({
    data: {
      title: 'WS20 Write-Back Test',
      sowText: 'Build checkout and auth',
      status: 'REVIEW',
      configVersion: 1,
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
  });
  estimateId = est.id;
});

afterAll(async () => {
  // Clean up promoted presets
  for (const id of promotedPresetIds) {
    await db.presetRetrieval.deleteMany({ where: { presetId: id } });
    await db.presetComposition.deleteMany({ where: { presetId: id } });
    await db.$executeRaw`DELETE FROM "PresetAnchor" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = ${id})`;
    await db.presetVersion.deleteMany({ where: { presetId: id } });
    await db.preset.deleteMany({ where: { id } });
  }
  await db.menuItem.deleteMany({ where: { estimateId } });
  await db.estimate.delete({ where: { id: estimateId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

function makeMenuItem(id: string, title: string): MenuItem {
  const lineItems = [
    { role: 'DEV', baseHours: 40, taxedHours: 40, edited: false },
    { role: 'QA', baseHours: 15, taxedHours: 18, edited: false },
    { role: 'PM', baseHours: 8, taxedHours: 9, edited: false },
    { role: 'BA', baseHours: 10, taxedHours: 11, edited: false },
  ];
  return MenuItemSchema.parse({ id, taxonomyKey: `b2b.${id}`, title, enabled: true, lineItems });
}

// ─── WS20-01: Promote enabled menu items to PresetVersions ────────────────────

describe('WS20-01: Finalise — promote menu items to PresetVersions', () => {
  it('creates versioned presets linked to the estimate', async () => {
    const items = [
      makeMenuItem('checkout', 'B2B Checkout Flow'),
      makeMenuItem('auth', 'SSO Authentication'),
    ];

    const { promoted, skipped } = await promoteMenuItemsToPresets(db, estimateId, items);

    expect(promoted.length).toBe(2);
    expect(skipped.length).toBe(0);

    // Track for cleanup
    promotedPresetIds.push(...promoted);

    // Verify preset versions exist in DB
    for (const presetId of promoted) {
      const pv = await db.presetVersion.findFirst({ where: { presetId, active: true } });
      expect(pv).toBeDefined();
      expect(pv?.sourceEstimateId).toBe(estimateId);
    }

    // Estimate status should be FINALISED
    const est = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(est.status).toBe('FINALISED');
  });

  it('no dupes on re-finalise — skips already promoted', async () => {
    const items = [makeMenuItem('checkout', 'B2B Checkout Flow')];

    const { promoted, skipped } = await promoteMenuItemsToPresets(db, estimateId, items);

    expect(promoted.length).toBe(0); // already promoted
    expect(skipped.length).toBe(1);
  });
});

// ─── WS20-02: Generate + store embeddings for promoted rows ───────────────────

describe('WS20-02: Embeddings stored for promoted presets', () => {
  /**
   * Through `backfillPresetEmbeddings`, which is the wired path: the inngest
   * promotion handler calls it with exactly these presetIds. `embedPromotedPresets`
   * did the same job without the staleness check or the per-row error tolerance,
   * had no production caller, and was deleted in AEH-253.
   */
  it('promoted presets get embeddings so the Archivist can match them', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(400)]);

    await backfillPresetEmbeddings(db, mockEmbedding, { presetIds: promotedPresetIds });

    // Verify embedding was stored
    for (const presetId of promotedPresetIds) {
      const pv = await db.presetVersion.findFirst({ where: { presetId, active: true } });
      expect(pv).toBeDefined();
      // embedding is stored via raw SQL, not accessible via Prisma model
      // Verify by running a raw query
      const rows = await db.$queryRawUnsafe<Array<{ has_embedding: boolean }>>(
        `SELECT r.embedding IS NOT NULL AS has_embedding FROM "PresetRetrieval" r WHERE r."presetId" = $1`,
        presetId,
      );
      expect(rows[0]?.has_embedding).toBe(true);
    }
  });
});

// ─── WS20-03: Post-delivery actuals ───────────────────────────────────────────

describe('WS20-03: Post-delivery actuals — new version with POST_DELIVERY_VALIDATION', () => {
  it('actuals stored as new preset version', async () => {
    const presetId = promotedPresetIds[0]!;

    const { version } = await recordActuals(db, {
      presetId,
      role: 'DEV',
      actualHours: 55,
      notes: 'Ran over due to scope creep',
    });

    expect(version).toBeGreaterThan(1);

    // Verify the new version
    const newPv = await db.presetVersion.findFirst({
      where: { presetId, version },
    });
    expect(newPv).toBeDefined();
    expect(newPv?.changeMotivation).toBe('POST_DELIVERY_VALIDATION');
    expect(newPv?.active).toBe(true);
    expect(newPv?.changeReason).toContain('55h');
  });

  it('old version is deactivated after actuals recorded', async () => {
    const presetId = promotedPresetIds[0]!;

    const allVersions = await db.presetVersion.findMany({ where: { presetId } });
    const activeVersions = allVersions.filter((v) => v.active);

    // Only one version should be active
    expect(activeVersions.length).toBe(1);
  });
});
