import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prerequisitesOf, resolveSelection, turnOff } from '@repo/shared';

import { loadEstimateGraph, replaceEstimateGraph, selectableOf } from './estimate-graph.js';
import { PrismaClient } from './generated/client/index.js';

/**
 * AEH-235. An estimate's own dependency graph.
 *
 * What these guard: the graph belongs to the ESTIMATE, so none of it may depend
 * on a card having matched a preset. Every card below has `sourcePresetId` null
 * — the state 128 of the 140 cards in the live database are actually in — and
 * the cascade still has to work. A regression that reintroduced a preset
 * requirement would pass a fixture that helpfully set one.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let estimateId = '';
let otherEstimateId = '';
const card: Record<string, string> = {};
let foreignCardId = '';

async function makeEstimate(title: string): Promise<string> {
  const est = await db.estimate.create({
    data: {
      title,
      sowText: 'x',
      status: 'REVIEW',
      configVersion: 1,
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
  });
  return est.id;
}

/** Hours land on line items, never on the card — so the graph has to sum them. */
async function makeCard(
  estId: string,
  key: string,
  opts: { foundation?: boolean; injected?: boolean; hours?: number; order?: number } = {},
): Promise<string> {
  const row = await db.menuItem.create({
    data: {
      estimateId: estId,
      taxonomyKey: `test.${key.toLowerCase()}`,
      title: key,
      phase: opts.foundation ? 'Foundation' : 'Core',
      foundation: opts.foundation ?? false,
      injected: opts.injected ?? false,
      order: opts.order ?? 0,
      // Deliberately null: the whole point is that presets are not required.
      sourcePresetId: null,
      lineItems: {
        create: [
          { role: 'DEV', baseHours: opts.hours ?? 10, taxedHours: opts.hours ?? 10 },
          { role: 'QA', baseHours: 1, taxedHours: 2 },
        ],
      },
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `estgraph-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
  estimateId = await makeEstimate('Estimate graph');
  otherEstimateId = await makeEstimate('Someone else');

  // AUTH <- API <- SYNC, plus an overhead placeholder and a foundation card.
  card['AUTH'] = await makeCard(estimateId, 'AUTH', { hours: 10, order: 1 });
  card['API'] = await makeCard(estimateId, 'API', { hours: 20, order: 2 });
  card['SYNC'] = await makeCard(estimateId, 'SYNC', { hours: 30, order: 3 });
  card['BASE'] = await makeCard(estimateId, 'BASE', { foundation: true, hours: 5, order: 0 });
  card['OVERHEAD'] = await makeCard(estimateId, 'OVERHEAD', { injected: true, hours: 7, order: 9 });
  foreignCardId = await makeCard(otherEstimateId, 'FOREIGN');
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  await db.menuItemDependency.deleteMany({ where: { estimateId } });
});

describe('loadEstimateGraph', () => {
  it('gives every card an edge entry, which the walks require', async () => {
    const graph = await loadEstimateGraph(db, estimateId);
    expect(graph.nodes.size).toBe(5);
    for (const id of graph.nodes.keys()) expect(graph.edges.has(id)).toBe(true);
  });

  it('sums taxed hours off the line items', async () => {
    const graph = await loadEstimateGraph(db, estimateId);
    // 20 DEV + 2 QA. Base hours are deliberately different from taxed so a
    // mapper reading the wrong column fails here.
    expect(graph.nodes.get(card['API']!)?.taxedHours).toBe(22);
  });

  it('walks a chain with no preset behind any card', async () => {
    await replaceEstimateGraph(
      db,
      estimateId,
      [
        { dependentId: card['API']!, prerequisiteId: card['AUTH']! },
        { dependentId: card['SYNC']!, prerequisiteId: card['API']! },
      ],
      'INFERRED',
    );
    const graph = await loadEstimateGraph(db, estimateId);
    const cards = await db.menuItem.findMany({
      where: { estimateId },
      select: { sourcePresetId: true },
    });
    expect(cards.every((c) => c.sourcePresetId === null)).toBe(true);

    expect([...prerequisitesOf(graph, card['SYNC']!)].sort()).toEqual(
      [card['API']!, card['AUTH']!].sort(),
    );
  });

  it('carries the note, which is what a cascade notice shows', async () => {
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: card['API']!, prerequisiteId: card['AUTH']!, note: 'no API without identity' }],
      'INFERRED',
    );
    const graph = await loadEstimateGraph(db, estimateId);
    expect(graph.notes.get(`${card['API']}->${card['AUTH']}`)).toBe('no API without identity');
  });

  it('keeps switched-off cards in the graph', async () => {
    // The configurator exists to switch things back on. A prerequisite absent
    // from the graph because it is off today would make the cascade quietly
    // wrong rather than visibly incomplete.
    await db.menuItem.update({ where: { id: card['AUTH']! }, data: { enabled: false } });
    const graph = await loadEstimateGraph(db, estimateId);
    expect(graph.nodes.has(card['AUTH']!)).toBe(true);
    expect(graph.nodes.get(card['AUTH']!)?.enabled).toBe(false);
    await db.menuItem.update({ where: { id: card['AUTH']! }, data: { enabled: true } });
  });

  it('does not leak another estimate’s cards', async () => {
    const graph = await loadEstimateGraph(db, estimateId);
    expect(graph.nodes.has(foreignCardId)).toBe(false);
  });
});

/** How every real caller derives it: straight off the per-card column. */
function foundationSetOf(graph: Awaited<ReturnType<typeof loadEstimateGraph>>): Set<string> {
  return new Set([...graph.nodes.values()].filter((n) => n.foundation).map((n) => n.menuItemId));
}

describe('foundation / selectableOf', () => {
  it('reads foundation off the column, not off meta.notSafelyRemovable', async () => {
    // notSafelyRemovable is false for every card in existence, because the
    // Archivist derives it from an empty PresetDependency table. Seeding
    // foundation from it would make foundation always empty.
    const graph = await loadEstimateGraph(db, estimateId);
    expect([...foundationSetOf(graph)]).toEqual([card['BASE']!]);
  });

  it('keeps injected overhead off the menu', async () => {
    const graph = await loadEstimateGraph(db, estimateId);
    const titles = selectableOf(graph).map((n) => n.title);
    expect(titles).not.toContain('OVERHEAD');
    expect(titles).toContain('API');
  });

  it('orders the menu by the card order', async () => {
    const graph = await loadEstimateGraph(db, estimateId);
    expect(selectableOf(graph).map((n) => n.title)).toEqual(['BASE', 'AUTH', 'API', 'SYNC']);
  });
});

describe('replaceEstimateGraph guards', () => {
  it('drops an edge naming a card from another estimate', async () => {
    const result = await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: card['API']!, prerequisiteId: foreignCardId }],
      'INFERRED',
    );
    expect(result.written).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('UNKNOWN_CARD');
  });

  it('drops a self-edge before the database has to refuse it', async () => {
    const result = await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: card['API']!, prerequisiteId: card['API']! }],
      'INFERRED',
    );
    expect(result.written).toEqual([]);
    expect(result.rejected[0]?.reason).toBe('SELF_EDGE');
  });

  it('breaks a cycle instead of persisting one', async () => {
    const result = await replaceEstimateGraph(
      db,
      estimateId,
      [
        { dependentId: card['API']!, prerequisiteId: card['AUTH']! },
        { dependentId: card['SYNC']!, prerequisiteId: card['API']! },
        { dependentId: card['AUTH']!, prerequisiteId: card['SYNC']! }, // closes the loop
      ],
      'INFERRED',
    );
    expect(result.written).toHaveLength(2);
    expect(result.rejected.map((r) => r.reason)).toEqual(['CYCLE']);

    const graph = await loadEstimateGraph(db, estimateId);
    // Finite, and genuinely acyclic rather than merely not hanging.
    expect(prerequisitesOf(graph, card['SYNC']!).has(card['SYNC']!)).toBe(false);
  });

  it('rejects the same edge twice rather than violating the unique index', async () => {
    const edge = { dependentId: card['API']!, prerequisiteId: card['AUTH']! };
    const result = await replaceEstimateGraph(db, estimateId, [edge, { ...edge }], 'INFERRED');
    expect(result.written).toHaveLength(1);
    expect(result.rejected.map((r) => r.reason)).toEqual(['DUPLICATE']);
  });

  it('is deterministic regardless of the order edges arrive in', async () => {
    // A derived graph arrives in whatever order something emitted it. If
    // emission order decided which edge of a cycle survived, the same input
    // would produce different graphs on different runs.
    const edges = [
      { dependentId: card['API']!, prerequisiteId: card['AUTH']! },
      { dependentId: card['SYNC']!, prerequisiteId: card['API']! },
      { dependentId: card['AUTH']!, prerequisiteId: card['SYNC']! },
    ];
    const forward = await replaceEstimateGraph(db, estimateId, edges, 'INFERRED');
    const reversed = await replaceEstimateGraph(db, estimateId, [...edges].reverse(), 'INFERRED');
    expect(reversed.written).toEqual(forward.written);
    expect(reversed.rejected).toEqual(forward.rejected);
  });

  it('replaces rather than accumulates, and records the source', async () => {
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: card['API']!, prerequisiteId: card['AUTH']! }],
      'INFERRED',
    );
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: card['SYNC']!, prerequisiteId: card['API']! }],
      'MANUAL',
    );
    const rows = await db.menuItemDependency.findMany({ where: { estimateId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('MANUAL');
  });
});

describe('the graph drives a real cascade', () => {
  it('switches off a prerequisite and takes its dependents with it', async () => {
    await replaceEstimateGraph(
      db,
      estimateId,
      [
        { dependentId: card['API']!, prerequisiteId: card['AUTH']! },
        { dependentId: card['SYNC']!, prerequisiteId: card['API']! },
      ],
      'INFERRED',
    );
    const graph = await loadEstimateGraph(db, estimateId);
    const state = {
      graph,
      picks: new Set([card['SYNC']!]),
      foundation: foundationSetOf(graph),
    };

    // BASE is foundation, so it is on without being picked.
    const before = resolveSelection(state);
    expect(before.origin.get(card['BASE']!)).toBe('FOUNDATION');
    expect(before.selected.has(card['AUTH']!)).toBe(true);

    const change = turnOff(state, card['API']!);
    expect(change.removed.sort()).toEqual([card['AUTH']!, card['SYNC']!].sort());
    expect(change.selection.selected.has(card['BASE']!)).toBe(true);
  });

  it('counts hours over the selection, excluding what is switched off', async () => {
    const graph = await loadEstimateGraph(db, estimateId);
    const state = { graph, picks: new Set([card['API']!]), foundation: foundationSetOf(graph) };
    const { selected } = resolveSelection(state);
    const hours = [...selected].reduce((sum, id) => sum + (graph.nodes.get(id)?.taxedHours ?? 0), 0);
    // API (22) + BASE (7), with no edges written in this case.
    expect(hours).toBe(29);
    expect(selected.size).toBe(2);
  });
});
