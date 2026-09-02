import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient, replaceEstimateGraph } from '@repo/db';

import { promoteEstimate } from './writeback';

/**
 * AEH-235. Promotion preserves an estimate's dependency graph into the preset
 * library.
 *
 * This is the direction dependency knowledge travels. The estimate's graph is
 * the real one — computed for that project, because that is where dependencies
 * are a fact. Promotion is what keeps it, and on the preset side it becomes
 * secondary metadata: a hint that reaches some future estimate only if matching
 * happens to pull both presets in again.
 *
 * These go through `promoteEstimate` rather than `promoteMenuItemsToPresets`
 * because the edges are ROWS. A synthetic card whose `id` is a semantic string
 * like `MC-TEST` has no MenuItem row and therefore no dependency rows, so a
 * test built that way would pass against a carry that does nothing at all.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let estimateId = '';
const cardId: Record<string, string> = {};

async function makeCard(key: string, hours = 12): Promise<string> {
  const row = await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: `carry.${key.toLowerCase()}`,
      title: `Carry ${key}`,
      // No preset match: the graph must not need one.
      sourcePresetId: null,
      lineItems: { create: [{ role: 'DEV', baseHours: hours, taxedHours: hours }] },
    },
    select: { id: true },
  });
  return row.id;
}

/** Every preset minted by a promotion in this file, for teardown. */
async function mintedPresetIds(): Promise<string[]> {
  const rows = await db.presetVersion.findMany({
    where: { sourceEstimateId: estimateId },
    select: { presetId: true },
  });
  return [...new Set(rows.map((r) => r.presetId))];
}

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `carry-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  const est = await db.estimate.create({
    data: {
      title: 'Graph carry',
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
  cardId['AUTH'] = await makeCard('AUTH');
  cardId['API'] = await makeCard('API');
  cardId['SYNC'] = await makeCard('SYNC');
});

afterEach(async () => {
  const presets = await mintedPresetIds();
  await db.estimate.delete({ where: { id: estimateId } }).catch(() => {});
  // Versions cascade from the preset; the preset itself is ours to remove.
  for (const id of presets) await db.preset.delete({ where: { id } }).catch(() => {});
});

/** The preset a given card became, via the version that records its provenance. */
async function presetFor(menuItemId: string): Promise<string | undefined> {
  const v = await db.presetVersion.findFirst({
    where: { sourceEstimateId: estimateId, sourceMenuItemId: menuItemId },
    select: { presetId: true },
  });
  return v?.presetId;
}

async function edgesOf(presetId: string) {
  const v = await db.presetVersion.findFirst({
    where: { presetId, active: true },
    include: { dependencies: true },
  });
  return v?.dependencies ?? [];
}

describe('promotion carries the estimate graph into the library', () => {
  it('writes a preset edge for a card edge, with no preset match on either card', async () => {
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: cardId['API']!, prerequisiteId: cardId['AUTH']!, note: 'needs identity' }],
      'INFERRED',
    );

    const result = await promoteEstimate(db, estimateId);
    expect(result.edgesCarried).toBe(1);

    const apiPreset = await presetFor(cardId['API']!);
    const authPreset = await presetFor(cardId['AUTH']!);
    expect(apiPreset).toBeDefined();
    expect(authPreset).toBeDefined();

    const edges = await edgesOf(apiPreset!);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.prerequisitePresetId).toBe(authPreset);
    // The reason travels, or the library gains a graph nobody can audit.
    expect(edges[0]?.note).toBe('needs identity');
  });

  it('carries a multi-hop chain as separate edges, one hop each', async () => {
    await replaceEstimateGraph(
      db,
      estimateId,
      [
        { dependentId: cardId['API']!, prerequisiteId: cardId['AUTH']! },
        { dependentId: cardId['SYNC']!, prerequisiteId: cardId['API']! },
      ],
      'INFERRED',
    );

    const result = await promoteEstimate(db, estimateId);
    expect(result.edgesCarried).toBe(2);

    const syncPreset = await presetFor(cardId['SYNC']!);
    const apiPreset = await presetFor(cardId['API']!);
    // SYNC records only its direct prerequisite. The transitive reach is the
    // graph's job, not a denormalised list.
    const syncEdges = await edgesOf(syncPreset!);
    expect(syncEdges.map((e) => e.prerequisitePresetId)).toEqual([apiPreset]);
  });

  it('gives an edge a fallback note naming the estimate it came from', async () => {
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: cardId['API']!, prerequisiteId: cardId['AUTH']! }],
      'INFERRED',
    );
    await promoteEstimate(db, estimateId);
    const edges = await edgesOf((await presetFor(cardId['API']!))!);
    expect(edges[0]?.note).toContain(estimateId);
  });

  it('skips an edge whose other end never promoted', async () => {
    // A disabled card is not promoted, so its half of the edge has nowhere to
    // land. Lossy by nature, and not a failure.
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: cardId['API']!, prerequisiteId: cardId['AUTH']! }],
      'INFERRED',
    );
    await db.menuItem.update({ where: { id: cardId['AUTH']! }, data: { enabled: false } });

    const result = await promoteEstimate(db, estimateId);
    expect(result.edgesCarried).toBe(0);
    expect(result.edgesSkipped).toBe(1);
    expect(await presetFor(cardId['AUTH']!)).toBeUndefined();
  });

  it('carries nothing when the estimate has no graph, and does not fail', async () => {
    const result = await promoteEstimate(db, estimateId);
    expect(result.edgesCarried).toBe(0);
    expect(result.edgesSkipped).toBe(0);
    expect(result.promoted.length).toBeGreaterThan(0);
  });

  it('does not become the back door that puts a cycle in the library', async () => {
    // The estimate's graph is acyclic, and `replaceEstimateGraph` guarantees it.
    // The LIBRARY's graph is a different graph: an edge carried from a previous
    // version plus an edge derived here can close a loop that neither contained.
    // AEH-242 made cycles unrepresentable in the editor; promotion must not
    // reintroduce one behind its back.
    await replaceEstimateGraph(
      db,
      estimateId,
      [
        { dependentId: cardId['API']!, prerequisiteId: cardId['AUTH']! },
        { dependentId: cardId['SYNC']!, prerequisiteId: cardId['API']! },
      ],
      'INFERRED',
    );
    await promoteEstimate(db, estimateId);

    const authPreset = (await presetFor(cardId['AUTH']!))!;
    const syncPreset = (await presetFor(cardId['SYNC']!))!;

    // Hand-write the closing edge the way an admin could: AUTH now needs SYNC,
    // and SYNC already transitively needs AUTH.
    const authVersion = await db.presetVersion.findFirst({
      where: { presetId: authPreset, active: true },
      select: { id: true },
    });
    await db.presetDependency.create({
      data: { dependentVersionId: authVersion!.id, prerequisitePresetId: syncPreset },
    });

    // Re-finalising must not add anything on top of a graph that is now cyclic.
    const again = await promoteEstimate(db, estimateId);
    expect(again.edgesCarried).toBe(0);
  });
});
