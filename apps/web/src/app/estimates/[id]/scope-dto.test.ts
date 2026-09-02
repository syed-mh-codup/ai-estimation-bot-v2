import { describe, expect, it } from 'vitest';

import type { EstimateGraph, EstimateGraphNode } from '@repo/db';
import type { EdgeNotes } from '@repo/shared';

import {
  asRunPicks,
  graphFromDTO,
  resolveCards,
  totalsOf,
  toScopeGraphDTO,
  type ScopeGraphDTO,
} from './scope-dto';

/**
 * AEH-235. Serialising an estimate's graph for the client, and resolving it back.
 *
 * In-memory: `toScopeGraphDTO` takes an already-loaded graph, so none of this
 * needs a database. That is deliberate — `estimate-graph.test.ts` covers the
 * loading against real Postgres, and these cover the mapping and the totals in
 * milliseconds. Before this the only thing exercising them was Playwright.
 */

function node(over: Partial<EstimateGraphNode> & { menuItemId: string }): EstimateGraphNode {
  return {
    title: over.menuItemId,
    taxonomyKey: `t.${over.menuItemId.toLowerCase()}`,
    phase: 'Core',
    category: null,
    sectionId: null,
    foundation: false,
    enabled: true,
    injected: false,
    taxedHours: 10,
    order: 0,
    ...over,
  };
}

function graphOf(
  nodes: EstimateGraphNode[],
  adjacency: Record<string, string[]>,
  notes: Record<string, string> = {},
): EstimateGraph & { notes: EdgeNotes } {
  return {
    nodes: new Map(nodes.map((n) => [n.menuItemId, n])),
    edges: new Map(nodes.map((n) => [n.menuItemId, adjacency[n.menuItemId] ?? []])),
    notes: new Map(Object.entries(notes)),
  };
}

const AUTH = node({ menuItemId: 'AUTH', foundation: true, taxedHours: 5, order: 1 });
const API = node({ menuItemId: 'API', taxedHours: 20, order: 2 });
const SYNC = node({ menuItemId: 'SYNC', taxedHours: 30, order: 3, enabled: false });
const OVERHEAD = node({ menuItemId: 'OVERHEAD', injected: true, taxedHours: 7, order: 9 });

const GRAPH = graphOf([AUTH, API, SYNC, OVERHEAD], { API: ['AUTH'], SYNC: ['API'] }, {
  'API->AUTH': 'no API without identity',
});

/** What the page hands the client: the selectable cards only. */
const DTO: ScopeGraphDTO = toScopeGraphDTO(GRAPH, [AUTH, API, SYNC]);

describe('toScopeGraphDTO', () => {
  it('carries each card with its direct prerequisites', () => {
    expect(DTO.cards.map((c) => [c.id, c.needs])).toEqual([
      ['AUTH', []],
      ['API', ['AUTH']],
      ['SYNC', ['API']],
    ]);
  });

  it('reports the as-run state separately from the selection', () => {
    // `enabledAtRun` is the estimate's own view. It is the reset baseline, and
    // it is NOT what the configurator currently shows.
    expect(DTO.cards.find((c) => c.id === 'SYNC')?.enabledAtRun).toBe(false);
    expect(DTO.cards.find((c) => c.id === 'API')?.enabledAtRun).toBe(true);
  });

  it('keeps the note, which is what a cascade notice shows', () => {
    expect(DTO.notes['API->AUTH']).toBe('no API without identity');
  });

  it('drops edges pointing at a card that is not on the menu', () => {
    // An injected card is excluded from the list, so an edge to it would name a
    // node the client cannot render — and a cascade would claim to have removed
    // a module nobody can see.
    const withHiddenEdge = graphOf([AUTH, API, OVERHEAD], { API: ['OVERHEAD'] });
    const dto = toScopeGraphDTO(withHiddenEdge, [AUTH, API]);
    expect(dto.adjacency['API']).toEqual([]);
    expect(dto.cards.map((c) => c.id)).not.toContain('OVERHEAD');
  });
});

describe('graphFromDTO', () => {
  it('rebuilds a walkable graph, since a Map cannot cross the RSC boundary', () => {
    const rebuilt = graphFromDTO(DTO);
    expect([...rebuilt.nodes.keys()].sort()).toEqual(['API', 'AUTH', 'SYNC']);
    expect(rebuilt.edges.get('SYNC')).toEqual(['API']);
    // Every node needs an entry, possibly empty — the walks rely on it.
    for (const id of rebuilt.nodes.keys()) expect(rebuilt.edges.has(id)).toBe(true);
  });
});

describe('resolveCards', () => {
  it('marks a card pulled in by the cascade as IMPLIED, not PICKED', () => {
    // The distinction the reference artifact could not make: its selection was
    // a flat Set, so work dragged in looked identical to work asked for.
    const cards = resolveCards(DTO, ['SYNC']);
    const origin = Object.fromEntries(cards.map((c) => [c.id, c.origin]));
    expect(origin).toEqual({ SYNC: 'PICKED', API: 'IMPLIED', AUTH: 'FOUNDATION' });
  });

  it('switches on a foundation card with nothing picked at all', () => {
    const cards = resolveCards(DTO, []);
    expect(cards.find((c) => c.id === 'AUTH')?.selected).toBe(true);
    expect(cards.find((c) => c.id === 'API')?.selected).toBe(false);
  });

  it('ignores a pick for a card that no longer exists', () => {
    const cards = resolveCards(DTO, ['SYNC', 'DELETED']);
    expect(cards.map((c) => c.id)).not.toContain('DELETED');
    expect(cards.find((c) => c.id === 'SYNC')?.selected).toBe(true);
  });
});

describe('totalsOf', () => {
  it('counts and sums only what is switched on', () => {
    // SYNC picked pulls API (20) and foundation AUTH (5) → 3 modules, 55h.
    const totals = totalsOf(resolveCards(DTO, ['SYNC']));
    expect(totals).toEqual({ moduleCount: 3, hours: 55, excludedHours: 0, cardsOff: 0 });
  });

  it('prices what is off without counting it', () => {
    // Nothing picked: only foundation AUTH is on. API and SYNC are excluded but
    // still priced — "switched off work is still priced" is the house rule.
    const totals = totalsOf(resolveCards(DTO, []));
    expect(totals.moduleCount).toBe(1);
    expect(totals.hours).toBe(5);
    expect(totals.cardsOff).toBe(2);
    expect(totals.excludedHours).toBe(50);
  });

  it('rounds rather than showing floating-point noise', () => {
    const odd = node({ menuItemId: 'ODD', taxedHours: 0.1 });
    const dto = toScopeGraphDTO(graphOf([odd, node({ menuItemId: 'ODD2', taxedHours: 0.2 })], {}), [
      odd,
      node({ menuItemId: 'ODD2', taxedHours: 0.2 }),
    ]);
    expect(totalsOf(resolveCards(dto, ['ODD', 'ODD2'])).hours).toBe(0.3);
  });
});

describe('asRunPicks', () => {
  it('is the estimate as the pipeline left it, foundation excluded', () => {
    // Foundation is on regardless, so listing it as a pick would be redundant
    // state that could then disagree with the flag.
    expect(asRunPicks(DTO.cards)).toEqual(['API']);
  });
});
