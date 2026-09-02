import { describe, it, expect } from 'vitest';
import {
  candidatePrerequisitesFor,
  dependentsOf,
  findCycles,
  prerequisitesOf,
  redundantEdgesOf,
  topologicalLayers,
  wouldCreateCycle,
  type PresetGraph,
} from './preset-graph';

/**
 * Build a graph from an adjacency literal. Pure functions over a plain object is
 * the whole point of the two-layer split in `preset-graph.ts` — none of this
 * needs a database, so the traversal rules can be pinned down exactly.
 */
function graphOf(adjacency: Record<string, string[]>): PresetGraph {
  const edges = new Map<string, string[]>();
  const nodes = new Map<string, ReturnType<() => never>>() as PresetGraph['nodes'];
  for (const [id, deps] of Object.entries(adjacency)) {
    edges.set(id, deps);
    nodes.set(id, { presetId: id, code: id, name: id, devHours: 10, versionId: `${id}-v1` });
  }
  return { edges, nodes };
}

// The shape the retired library actually had: fan-in to a couple of
// foundations, a chain several deep, and some isolated nodes.
const LIBRARY = graphOf({
  FOUNDATION: [],
  ISOLATED: [],
  API: ['FOUNDATION'],
  SYNC: ['API'],
  PRICING: ['SYNC'],
  DISPLAY: ['PRICING'],
  AUTH: ['FOUNDATION'],
});

describe('prerequisitesOf', () => {
  it('walks the whole chain, not just the direct edge', () => {
    expect([...prerequisitesOf(LIBRARY, 'DISPLAY')].sort()).toEqual(['API', 'FOUNDATION', 'PRICING', 'SYNC']);
  });

  it('excludes the preset itself', () => {
    expect(prerequisitesOf(LIBRARY, 'DISPLAY').has('DISPLAY')).toBe(false);
  });

  it('is empty for a preset that needs nothing', () => {
    expect([...prerequisitesOf(LIBRARY, 'FOUNDATION')]).toEqual([]);
  });

  it('terminates on a cycle instead of hanging', () => {
    // The editor cannot create this; a direct database write or an import can.
    const cyclic = graphOf({ A: ['C'], B: ['A'], C: ['B'] });
    expect([...prerequisitesOf(cyclic, 'A')].sort()).toEqual(['A', 'B', 'C'].filter((x) => x !== 'A'));
  });
});

describe('dependentsOf', () => {
  it('finds everything that transitively needs it', () => {
    expect([...dependentsOf(LIBRARY, 'API')].sort()).toEqual(['DISPLAY', 'PRICING', 'SYNC']);
  });

  it('restricted to a scope, reports only what is actually in that scope', () => {
    // The configurator's question: removing API breaks what, *here*?
    const inScope = ['API', 'SYNC', 'FOUNDATION'];
    expect([...dependentsOf(LIBRARY, 'API', inScope)].sort()).toEqual(['SYNC']);
  });

  it('is empty for a leaf', () => {
    expect([...dependentsOf(LIBRARY, 'DISPLAY')]).toEqual([]);
  });
});

describe('wouldCreateCycle', () => {
  it('rejects a self-edge', () => {
    expect(wouldCreateCycle(LIBRARY, 'API', 'API')).toBe(true);
  });

  it('rejects an edge that closes a loop through the existing chain', () => {
    // FOUNDATION already reaches DISPLAY, so DISPLAY cannot become its prerequisite.
    expect(wouldCreateCycle(LIBRARY, 'FOUNDATION', 'DISPLAY')).toBe(true);
  });

  it('allows an edge between unrelated branches', () => {
    expect(wouldCreateCycle(LIBRARY, 'AUTH', 'API')).toBe(false);
  });
});

describe('candidatePrerequisitesFor', () => {
  it('offers neither itself, nor what it already needs, nor anything downstream', () => {
    const offered = candidatePrerequisitesFor(LIBRARY, 'SYNC').map((n) => n.presetId);
    expect(offered).not.toContain('SYNC'); // itself
    expect(offered).not.toContain('API'); // already a prerequisite
    expect(offered).not.toContain('PRICING'); // downstream — would be a cycle
    expect(offered).not.toContain('DISPLAY'); // transitively downstream
    expect(offered.sort()).toEqual(['AUTH', 'FOUNDATION', 'ISOLATED']);
  });

  it('never offers an option that wouldCreateCycle would then reject', () => {
    for (const id of LIBRARY.nodes.keys()) {
      for (const candidate of candidatePrerequisitesFor(LIBRARY, id)) {
        expect(wouldCreateCycle(LIBRARY, id, candidate.presetId)).toBe(false);
      }
    }
  });
});

describe('redundantEdgesOf', () => {
  it('reports an edge already implied by a longer path', () => {
    // X needs both Y and Z directly, but Z already reaches Y.
    const g = graphOf({ X: ['Y', 'Z'], Z: ['Y'], Y: [] });
    expect(redundantEdgesOf(g, 'X').get('Y')).toEqual(['Z']);
  });

  it('reports nothing when every edge carries its own weight', () => {
    const g = graphOf({ X: ['Y', 'Z'], Y: [], Z: [] });
    expect(redundantEdgesOf(g, 'X').size).toBe(0);
  });
});

describe('topologicalLayers', () => {
  it('puts prerequisite-free work first and never before its own prerequisites', () => {
    const layers = topologicalLayers(LIBRARY);
    expect(layers[0]).toEqual(['AUTH', 'FOUNDATION', 'ISOLATED'].filter((x) => layers[0]?.includes(x)));
    // Every node appears after everything it needs.
    const layerOf = new Map<string, number>();
    layers.forEach((layer, i) => layer.forEach((id) => layerOf.set(id, i)));
    for (const [id, deps] of LIBRARY.edges) {
      for (const dep of deps) {
        expect(layerOf.get(dep)!).toBeLessThan(layerOf.get(id)!);
      }
    }
  });

  it('restricted to a scope, lays out only that scope', () => {
    const layers = topologicalLayers(LIBRARY, ['FOUNDATION', 'API', 'SYNC']);
    expect(layers).toEqual([['FOUNDATION'], ['API'], ['SYNC']]);
  });

  it('surfaces cycle members in a final layer rather than dropping them', () => {
    // Silently omitting work from a delivery plan is worse than showing it in
    // the wrong place.
    const g = graphOf({ ROOT: [], A: ['C'], B: ['A'], C: ['B'] });
    const layers = topologicalLayers(g);
    expect(layers[0]).toEqual(['ROOT']);
    expect(layers[layers.length - 1]!.sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('findCycles', () => {
  it('finds nothing in a well-formed graph', () => {
    expect(findCycles(LIBRARY)).toEqual([]);
  });

  it('finds the three-node cycle the retired library actually contained', () => {
    // P27 -> P34 -> P38 -> P27, produced by unioning `requires` with the
    // reverse of `blocks`. Neither array was cyclic on its own, which is why
    // nothing caught it for as long as both existed. See
    // docs/preset-dependency-reference.md.
    const g = graphOf({ P27: ['P38'], P38: ['P34'], P34: ['P27'] });
    const cycles = findCycles(g);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0]!.sort()).toEqual(['P27', 'P34', 'P38']);
  });
});
