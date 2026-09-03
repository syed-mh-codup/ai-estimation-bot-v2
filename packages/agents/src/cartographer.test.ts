import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadEstimateGraph, PrismaClient, replaceEstimateGraph } from '@repo/db';
import type { ChatResult, IModelProvider } from '@repo/providers';
import { prerequisitesOf } from '@repo/shared';

import { buildScopeCorpus, renderScopeCorpus, runCartographer } from './cartographer';

/**
 * AEH-235. The Cartographer derives an estimate's dependency graph.
 *
 * The model is faked, so what these guard is everything AROUND the call: what
 * the corpus shows, how card numbers map back to ids, and — mostly — that the
 * model's output is treated as a proposal rather than a result. An agent that
 * wrote whatever it was handed would pass a test that only checked the happy
 * path, so most of the cases below feed it something wrong on purpose.
 *
 * Every fixture card has `sourcePresetId: null`. The graph belongs to the
 * estimate; a regression that reintroduced a preset dependency would fail here
 * rather than pass on a helpful fixture.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let estimateId = '';
const card: Record<string, string> = {};

const PROMPT = { body: 'You are the Cartographer.', modelString: 'stub/model' };

/**
 * A provider that returns exactly the JSON a test wants to test the handling of.
 *
 * Streams it in three chunks rather than one. The agent streams so it can
 * report progress, and a single-chunk fake would leave the accumulation path —
 * the part that counts edges as they arrive — untested.
 */
function providerReturning(payload: unknown): IModelProvider {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    chat: vi.fn().mockResolvedValue({ text, model: 'stub/model', usage: null } satisfies ChatResult),
    // eslint-disable-next-line @typescript-eslint/require-await
    chatStream: async function* () {
      const size = Math.max(1, Math.ceil(text.length / 3));
      for (let at = 0; at < text.length; at += size) {
        yield { type: 'delta' as const, text: text.slice(at, at + size) };
      }
      yield { type: 'done' as const, usage: null, model: 'stub/model' };
    },
    embed: vi.fn(),
  } as unknown as IModelProvider;
}

async function makeCard(
  key: string,
  opts: { injected?: boolean; hours?: number; order?: number } = {},
): Promise<string> {
  const row = await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: `carto.${key.toLowerCase()}`,
      title: key,
      category: 'Test',
      phase: 'Core',
      injected: opts.injected ?? false,
      order: opts.order ?? 0,
      sourcePresetId: null,
      lineItems: { create: [{ role: 'DEV', baseHours: 1, taxedHours: opts.hours ?? 10 }] },
    },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `carto-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
  const est = await db.estimate.create({
    data: {
      title: 'Cartographer test',
      sowText: 'x',
      status: 'REVIEW',
      configVersion: 1,
      narrative: [],
      assumptions: [],
      // The Librarian's output is where requirement text comes from.
      agentState: {
        librarianOutput: {
          requirements: [
            { id: 'REQ-001', text: 'Let buyers sign in with SSO' },
            { id: 'REQ-002', text: 'Expose a public read API' },
          ],
        },
      },
      ownerId: userId,
    },
  });
  estimateId = est.id;

  card['AUTH'] = await makeCard('AUTH', { hours: 10, order: 1 });
  card['API'] = await makeCard('API', { hours: 20, order: 2 });
  card['SYNC'] = await makeCard('SYNC', { hours: 30, order: 3 });
  card['OVERHEAD'] = await makeCard('OVERHEAD', { injected: true, order: 9 });

  await db.menuItem.update({
    where: { id: card['AUTH']! },
    data: { meta: { requirementIds: ['REQ-001'] } },
  });
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  await db.menuItemDependency.deleteMany({ where: { estimateId } });
  await db.menuItem.updateMany({ where: { estimateId }, data: { foundation: false } });
});

describe('buildScopeCorpus', () => {
  it('numbers cards from 1 in the order they are shown', async () => {
    const corpus = await buildScopeCorpus(db, estimateId);
    expect(corpus?.cards.map((c) => [c.number, c.title])).toEqual([
      [1, 'AUTH'],
      [2, 'API'],
      [3, 'SYNC'],
    ]);
  });

  it('leaves injected overhead out entirely', async () => {
    // Not scope anybody chooses, not on the configurator's menu, and an edge
    // pointing at one would be a dependency on untoggleable work.
    const corpus = await buildScopeCorpus(db, estimateId);
    expect(corpus?.cards.map((c) => c.title)).not.toContain('OVERHEAD');
  });

  it('carries the requirement text a card was costed against', async () => {
    const corpus = await buildScopeCorpus(db, estimateId);
    expect(corpus?.cards[0]?.requirementTexts).toEqual(['Let buyers sign in with SSO']);
    // And tolerates its absence — cards from runs predating this still map.
    expect(corpus?.cards[1]?.requirementTexts).toEqual([]);
  });

  it('renders the numbered list the prompt contract refers to', async () => {
    const corpus = await buildScopeCorpus(db, estimateId);
    const rendered = renderScopeCorpus(corpus!);
    expect(rendered).toContain('1. AUTH');
    expect(rendered).toContain('asked for: Let buyers sign in with SSO');
    expect(rendered).toContain('3 cards.');
  });

  it('is null for an estimate with no cards', async () => {
    const empty = await db.estimate.create({
      data: {
        title: 'Empty',
        sowText: 'x',
        status: 'DRAFT',
        configVersion: 1,
        narrative: [],
        assumptions: [],
        agentState: {},
        ownerId: userId,
      },
      select: { id: true },
    });
    expect(await buildScopeCorpus(db, empty.id)).toBeNull();
  });
});

describe('runCartographer', () => {
  it('maps card numbers back to ids and stores the graph', async () => {
    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({
        edges: [
          { dependent: 2, prerequisite: 1, why: 'no API without identity' },
          { dependent: 3, prerequisite: 2, why: 'sync calls the API' },
        ],
        foundation: [1],
        notes: 'read as a chain',
      }),
    });

    expect(result.written).toBe(2);
    expect(result.foundation).toEqual([card['AUTH']]);
    expect(result.notes).toBe('read as a chain');

    const graph = await loadEstimateGraph(db, estimateId);
    expect([...prerequisitesOf(graph, card['SYNC']!)].sort()).toEqual(
      [card['API']!, card['AUTH']!].sort(),
    );
    // The reason travels — it is what the cascade notice shows.
    expect(graph.notes.get(`${card['API']}->${card['AUTH']}`)).toBe('no API without identity');
  });

  it('records the edges as INFERRED, distinguishable from a typed one', async () => {
    await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [{ dependent: 2, prerequisite: 1 }] }),
    });
    const rows = await db.menuItemDependency.findMany({ where: { estimateId } });
    expect(rows.map((r) => r.source)).toEqual(['INFERRED']);
  });

  it('drops an edge naming a card number that does not exist', async () => {
    // The model inventing a card. Reported by NUMBER, because that is the only
    // form in which a human can see what it got wrong.
    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({
        edges: [
          { dependent: 2, prerequisite: 1 },
          { dependent: 99, prerequisite: 1 },
        ],
      }),
    });
    expect(result.written).toBe(1);
    expect(result.rejected).toEqual([
      { reason: 'UNKNOWN_CARD', detail: 'no card 99 in this estimate' },
    ]);
  });

  it('refuses to persist a cycle, and says which edge it dropped', async () => {
    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({
        edges: [
          { dependent: 2, prerequisite: 1 },
          { dependent: 3, prerequisite: 2 },
          { dependent: 1, prerequisite: 3 }, // closes the loop
        ],
      }),
    });
    expect(result.written).toBe(2);
    expect(result.rejected.map((r) => r.reason)).toEqual(['CYCLE']);

    // Named by title, not by cuid — the rejection has to be readable. WHICH of
    // the three edges is dropped is deliberately not asserted: edges are
    // considered in sorted id order precisely so that emission order cannot
    // decide it, which means the survivor depends on cuids and pinning it here
    // would be pinning the fixture's ids rather than the behaviour.
    const detail = result.rejected[0]?.detail ?? '';
    const [from, to] = detail.split(' → ');
    expect(['AUTH', 'API', 'SYNC']).toContain(from);
    expect(['AUTH', 'API', 'SYNC']).toContain(to);

    // What does matter: what got stored is genuinely acyclic.
    const graph = await loadEstimateGraph(db, estimateId);
    for (const id of graph.nodes.keys()) {
      expect(prerequisitesOf(graph, id).has(id), `${id} reaches itself`).toBe(false);
    }
  });

  it('drops a self-edge', async () => {
    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [{ dependent: 1, prerequisite: 1 }] }),
    });
    expect(result.written).toBe(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(['SELF_EDGE']);
  });

  it('clears a stale foundation flag rather than leaving it set', async () => {
    await db.menuItem.update({ where: { id: card['SYNC']! }, data: { foundation: true } });
    await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [], foundation: [1] }),
    });
    const rows = await db.menuItem.findMany({
      where: { estimateId, foundation: true },
      select: { id: true },
    });
    // Only what this run named. A leftover flag would make a card unremovable
    // for a reason no longer recorded anywhere.
    expect(rows.map((r) => r.id)).toEqual([card['AUTH']]);
  });

  it('accepts an empty graph as a real answer', async () => {
    // Most cards in most estimates depend on nothing, and the prompt argues for
    // restraint. "No edges" must not look like a failure.
    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [], foundation: [] }),
    });
    expect(result.written).toBe(0);
    expect(result.rejected).toEqual([]);
  });

  it('fills in the optional fields when the model omits them', async () => {
    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [{ dependent: 2, prerequisite: 1 }] }),
    });
    expect(result.notes).toBe('');
    expect(result.foundation).toEqual([]);
    const rows = await db.menuItemDependency.findMany({ where: { estimateId } });
    // `why` defaulted to empty, so the note is null rather than the string "".
    expect(rows[0]?.note).toBeNull();
  });

  it('throws rather than writing anything when the response is not the contract', async () => {
    await expect(
      runCartographer({
        db,
        estimateId,
        prompt: PROMPT,
        modelProvider: providerReturning({ edges: [{ dependent: 'two', prerequisite: 1 }] }),
      }),
    ).rejects.toThrow();
    expect(await db.menuItemDependency.count({ where: { estimateId } })).toBe(0);
  });

  it('records the spend against the estimate', async () => {
    const before = await db.modelUsage.count({ where: { estimateId, kind: 'CARTOGRAPHER' } });
    await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [] }),
    });
    expect(await db.modelUsage.count({ where: { estimateId, kind: 'CARTOGRAPHER' } })).toBe(
      before + 1,
    );
  });
});

describe('runCartographer — what a re-derive keeps', () => {
  it('preserves hand-authored edges and says how many', async () => {
    // Re-deriving supersedes the machine's previous reading, not somebody's
    // typed-in knowledge.
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: card['SYNC']!, prerequisiteId: card['AUTH']!, note: 'typed by a human' }],
      'MANUAL',
    );

    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [{ dependent: 2, prerequisite: 1 }] }),
    });

    expect(result.preserved).toBe(1);
    expect(result.written).toBe(1);

    const rows = await db.menuItemDependency.findMany({
      where: { estimateId },
      select: { source: true, note: true },
      orderBy: { source: 'asc' },
    });
    expect(rows.map((r) => r.source).sort()).toEqual(['INFERRED', 'MANUAL']);
    expect(rows.find((r) => r.source === 'MANUAL')?.note).toBe('typed by a human');
  });

  it('refuses a derived edge that would contradict a typed one', async () => {
    // Preserved edges are seeded first, so the human's direction wins.
    await replaceEstimateGraph(
      db,
      estimateId,
      [{ dependentId: card['AUTH']!, prerequisiteId: card['API']! }],
      'MANUAL',
    );

    const result = await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      // The opposite direction: API needs AUTH.
      modelProvider: providerReturning({ edges: [{ dependent: 2, prerequisite: 1 }] }),
    });

    expect(result.written).toBe(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(['CYCLE']);
    expect(result.preserved).toBe(1);
  });

  it('leaves saved configurations alone', async () => {
    const scenario = await db.scopeScenario.create({
      data: {
        estimateId,
        name: 'Leanest viable',
        createdById: userId,
        picks: { create: [{ menuItemId: card['API']! }] },
      },
      select: { id: true },
    });

    await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({ edges: [{ dependent: 3, prerequisite: 2 }] }),
    });

    const after = await db.scopeScenario.findUnique({
      where: { id: scenario.id },
      include: { picks: { select: { menuItemId: true } } },
    });
    // Picks reference cards, not edges, so they survive. What a pick DRAGS IN
    // changes with the graph, which is a different thing and is what the
    // confirmation warns about.
    expect(after?.name).toBe('Leanest viable');
    expect(after?.picks.map((p) => p.menuItemId)).toEqual([card['API']]);
  });

  it('reports the progress stages in order, with a counted edge total', async () => {
    const seen: Array<{ stage: string; edgesFound?: number }> = [];
    await runCartographer({
      db,
      estimateId,
      prompt: PROMPT,
      modelProvider: providerReturning({
        edges: [
          { dependent: 2, prerequisite: 1 },
          { dependent: 3, prerequisite: 2 },
        ],
      }),
      onProgress: (p) => seen.push({ stage: p.stage, edgesFound: p.edgesFound }),
    });

    // Every stage, in order, with no going backwards.
    const stages = seen.map((s) => s.stage);
    expect(stages[0]).toBe('reading');
    expect(stages).toContain('asking');
    expect(stages).toContain('checking');
    expect(stages[stages.length - 1]).toBe('saving');

    // And the count is real: it ends at the number of edges actually emitted.
    const counts = seen.map((s) => s.edgesFound ?? 0);
    expect(Math.max(...counts)).toBe(2);
    // Monotonic — a count that went down would mean it was being guessed.
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });
});
