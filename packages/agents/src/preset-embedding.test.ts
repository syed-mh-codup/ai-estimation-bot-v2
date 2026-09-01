import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@repo/db';
import type { IEmbeddingProvider } from '@repo/providers';
import { backfillPresetEmbeddings, presetEmbeddingText } from './writeback';

/**
 * The preset library is only reachable by the Archivist through
 * `queryPresetsByVector`, which filters on `embedding IS NOT NULL`. A preset
 * without a vector doesn't error — it just never matches, forever. These tests
 * pin the routine that guarantees the library stays indexed, including the
 * case that used to break it silently: an admin edit changing a preset's text.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const PRESET_A = 'TEST-EMBED-A';
const PRESET_B = 'TEST-EMBED-B';
const ALL = [PRESET_A, PRESET_B];

function unitVec(dim: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[dim] = 1;
  return v;
}

const embedding: IEmbeddingProvider = { embed: vi.fn(), dimension: 1536 };

async function makePreset(presetId: string, name: string, keywords: string[]) {
  await db.preset.upsert({ where: { id: presetId }, update: {}, create: { id: presetId } });
  const version = await db.presetVersion.create({
    data: {
      presetId,
      version: 1,
      active: true,
      anchor: {
        create: {
          category: 'test',
          reqType: 'FEATURE',
          devHours: 15,
          touchesBackend: true,
          touchesFrontend: true,
          platforms: [],
          projectSizeFit: [],
          integrationCount: 0,
          dataVolume: 'LOW',
          phase: 'CORE',
          aiAssist: 'LOW',
          risk: 'LOW',
          spikeNeeded: false,
        },
      },
      retrieval: {
        create: {
          name,
          description: 'A preset used by the embedding-backfill tests.',
          keywords,
          userStoryTags: [],
          notes: '',
        },
      },
      composition: {
        create: { requires: [], blocks: [], canParallel: true },
      },
    },
    include: { retrieval: true },
  });
  return { version, retrieval: version.retrieval! };
}

async function vectorState(retrievalId: string) {
  const rows = await db.$queryRawUnsafe<Array<{ has: boolean; txt: string | null }>>(
    `SELECT embedding IS NOT NULL AS has, "embeddingText" AS txt FROM "PresetRetrieval" WHERE id = $1`,
    retrievalId,
  );
  return rows[0]!;
}

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.presetRetrieval.deleteMany({ where: { presetVersion: { presetId: { in: ALL } } } });
  await db.presetComposition.deleteMany({ where: { presetVersion: { presetId: { in: ALL } } } });
  await db.$executeRaw`DELETE FROM "PresetAnchor" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = ANY(${ALL}))`;
  await db.presetVersion.deleteMany({ where: { presetId: { in: ALL } } });
  await db.preset.deleteMany({ where: { id: { in: ALL } } });
  await db.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(embedding.embed).mockResolvedValue({ vectors: [unitVec(7)], model: 'stub/model', usage: null });
  await db.presetRetrieval.deleteMany({ where: { presetVersion: { presetId: { in: ALL } } } });
  await db.presetComposition.deleteMany({ where: { presetVersion: { presetId: { in: ALL } } } });
  await db.$executeRaw`DELETE FROM "PresetAnchor" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = ANY(${ALL}))`;
  await db.presetVersion.deleteMany({ where: { presetId: { in: ALL } } });
});

describe('backfillPresetEmbeddings', () => {
  it('embeds a preset that has no vector, and records the text it used', async () => {
    const { retrieval } = await makePreset(PRESET_A, 'Checkout extension', ['checkout', 'shopify']);
    expect((await vectorState(retrieval.id)).has).toBe(false); // invisible to the Archivist

    const result = await backfillPresetEmbeddings(db, embedding, { presetIds: [PRESET_A] });

    expect(result).toMatchObject({ missing: 1, stale: 0, embedded: 1, failed: [] });
    const after = await vectorState(retrieval.id);
    expect(after.has).toBe(true);
    expect(after.txt).toBe(
      presetEmbeddingText({
        name: 'Checkout extension',
        description: 'A preset used by the embedding-backfill tests.',
        keywords: ['checkout', 'shopify'],
        notes: '',
        userStoryTags: [],
      }),
    );
  });

  it('is idempotent — a second run embeds nothing', async () => {
    await makePreset(PRESET_A, 'Checkout extension', ['checkout']);
    await backfillPresetEmbeddings(db, embedding, { presetIds: [PRESET_A] });
    vi.mocked(embedding.embed).mockClear();

    const result = await backfillPresetEmbeddings(db, embedding, { presetIds: [PRESET_A] });

    expect(result).toMatchObject({ missing: 0, stale: 0, embedded: 0 });
    expect(embedding.embed).not.toHaveBeenCalled();
  });

  it('re-embeds a preset whose text changed since it was embedded', async () => {
    const { retrieval } = await makePreset(PRESET_A, 'Checkout extension', ['checkout']);
    await backfillPresetEmbeddings(db, embedding, { presetIds: [PRESET_A] });

    // What an admin edit does: the vector stays (so the preset is never
    // de-indexed) but no longer describes the row.
    await db.presetRetrieval.update({
      where: { id: retrieval.id },
      data: { name: 'Subscription billing', keywords: ['billing', 'recurring'] },
    });

    const result = await backfillPresetEmbeddings(db, embedding, { presetIds: [PRESET_A] });

    expect(result).toMatchObject({ missing: 0, stale: 1, embedded: 1 });
    const after = await vectorState(retrieval.id);
    expect(after.txt).toContain('Subscription billing');
    expect(after.txt).toContain('recurring');
  });

  it('force re-embeds even when nothing is stale', async () => {
    await makePreset(PRESET_A, 'Checkout extension', ['checkout']);
    await backfillPresetEmbeddings(db, embedding, { presetIds: [PRESET_A] });

    const result = await backfillPresetEmbeddings(db, embedding, {
      presetIds: [PRESET_A],
      force: true,
    });

    expect(result).toMatchObject({ stale: 1, embedded: 1 });
  });

  it('keeps going when one preset fails, so a partial outage still indexes the rest', async () => {
    await makePreset(PRESET_A, 'Alpha', ['a']);
    await makePreset(PRESET_B, 'Beta', ['b']);
    vi.mocked(embedding.embed)
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockResolvedValue({ vectors: [unitVec(11)], model: 'stub/model', usage: null });

    const result = await backfillPresetEmbeddings(db, embedding, { presetIds: ALL });

    expect(result.embedded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/rate limited/);
  });

  it('ignores inactive versions — only the active one is retrievable', async () => {
    const { version } = await makePreset(PRESET_A, 'Alpha', ['a']);
    await db.presetVersion.update({ where: { id: version.id }, data: { active: false } });

    const result = await backfillPresetEmbeddings(db, embedding, { presetIds: [PRESET_A] });

    expect(result).toMatchObject({ missing: 0, stale: 0, embedded: 0 });
  });
});
