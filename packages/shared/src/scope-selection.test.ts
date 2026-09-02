import { describe, expect, it } from 'vitest';

import { dependentsOf, findCycles, type Walkable } from './preset-graph.js';
import {
  consequencesOf,
  previewAdds,
  resolveSelection,
  turnOff,
  turnOn,
  type SelectionState,
} from './scope-selection.js';

/**
 * A graph in the shape the walks require: every node has an edge entry, even an
 * empty one. `adjacency` reads dependent -> what it needs.
 */
function graphOf(adjacency: Record<string, string[]>): Walkable {
  const nodes = new Map<string, unknown>();
  const edges = new Map<string, string[]>();
  for (const [id, deps] of Object.entries(adjacency)) {
    nodes.set(id, { id });
    edges.set(id, deps);
    for (const d of deps) {
      if (!nodes.has(d)) nodes.set(d, { id: d });
      if (!edges.has(d)) edges.set(d, []);
    }
  }
  return { nodes, edges };
}

/** AUTH <- API <- SYNC <- PRICING, a second branch on AUTH, and an island. */
const ESTIMATE = graphOf({
  AUTH: [],
  API: ['AUTH'],
  SYNC: ['API'],
  PRICING: ['SYNC'],
  REPORTS: ['AUTH'],
  ISLAND: [],
});

const state = (picks: string[], foundation: string[] = []): SelectionState => ({
  graph: ESTIMATE,
  picks: new Set(picks),
  foundation: new Set(foundation),
});

describe('resolveSelection', () => {
  it('pulls in the whole prerequisite chain, not just the direct edge', () => {
    const { selected } = resolveSelection(state(['PRICING']));
    expect([...selected].sort()).toEqual(['API', 'AUTH', 'PRICING', 'SYNC']);
  });

  it('records why each card is on, so a cascade is distinguishable from a choice', () => {
    const { origin } = resolveSelection(state(['PRICING']));
    expect(origin.get('PRICING')).toBe('PICKED');
    expect(origin.get('SYNC')).toBe('IMPLIED');
    expect(origin.get('AUTH')).toBe('IMPLIED');
  });

  it('keeps PICKED over IMPLIED, so an explicit choice survives losing what implied it', () => {
    const { origin } = resolveSelection(state(['PRICING', 'AUTH']));
    expect(origin.get('AUTH')).toBe('PICKED');
  });

  it('keeps FOUNDATION over PICKED, because unremovable is the louder fact', () => {
    const { origin } = resolveSelection(state(['AUTH'], ['AUTH']));
    expect(origin.get('AUTH')).toBe('FOUNDATION');
  });

  it('pulls in what a foundation card itself needs', () => {
    // The reference artifact got this wrong by giving foundation modules no
    // dependency entries, which silently made the rule "foundation has no
    // prerequisites" rather than "foundation is always on".
    const { selected, origin } = resolveSelection(state([], ['SYNC']));
    expect([...selected].sort()).toEqual(['API', 'AUTH', 'SYNC']);
    expect(origin.get('API')).toBe('IMPLIED');
  });

  it('drops picks for cards that are not in the graph', () => {
    // A pick outlives the card it named — a re-run replaces every card. A
    // phantom id would be counted in the totals and crash the row renderer.
    const { selected } = resolveSelection(state(['AUTH', 'DELETED-CARD']));
    expect([...selected]).toEqual(['AUTH']);
  });

  it('is empty when nothing is picked and there is no foundation', () => {
    expect(resolveSelection(state([])).selected.size).toBe(0);
  });
});

describe('turnOn', () => {
  it('reports what came with it, excluding the card that was clicked', () => {
    const change = turnOn(state([]), 'PRICING');
    expect(change.added).toEqual(['API', 'AUTH', 'SYNC']);
    expect(change.picks).toEqual(new Set(['PRICING']));
  });

  it('adds nothing when the prerequisites are already on', () => {
    const change = turnOn(state(['SYNC']), 'PRICING');
    expect(change.added).toEqual([]);
  });

  it('refuses an id the graph does not have', () => {
    expect(turnOn(state([]), 'NOPE').refused).toBe('UNKNOWN');
  });
});

describe('turnOff', () => {
  it('takes the dependents with it and names them', () => {
    // AUTH goes too, and that is right: it was on only because API needed it,
    // so once API's chain is gone nothing is asking for it any more. Removal
    // reaches upstream as well as downstream, because "on" is never an
    // independent fact — it is always a consequence of some pick.
    const change = turnOff(state(['PRICING']), 'API');
    expect(change.removed).toEqual(['AUTH', 'PRICING', 'SYNC']);
    expect(change.selection.selected.size).toBe(0);
  });

  it('leaves an upstream card that was picked in its own right', () => {
    const change = turnOff(state(['PRICING', 'AUTH']), 'API');
    expect(change.removed).toEqual(['PRICING', 'SYNC']);
    expect(change.selection.selected.has('AUTH')).toBe(true);
  });

  it('clears dependents that were only IMPLIED, which have no pick of their own', () => {
    // The subtle case: SYNC is on because PRICING needs it. Clearing the pick on
    // SYNC alone is a no-op, so a naive implementation re-resolves and pulls it
    // straight back. PRICING's pick has to go too.
    const before = resolveSelection(state(['PRICING']));
    expect(before.origin.get('SYNC')).toBe('IMPLIED');

    const change = turnOff(state(['PRICING']), 'SYNC');
    expect(change.selection.selected.has('SYNC')).toBe(false);
    expect(change.selection.selected.has('PRICING')).toBe(false);
    expect(change.picks.has('PRICING')).toBe(false);
  });

  it('leaves an unrelated branch alone', () => {
    const change = turnOff(state(['PRICING', 'REPORTS']), 'SYNC');
    expect(change.selection.selected.has('REPORTS')).toBe(true);
  });

  it('refuses a foundation card and changes nothing', () => {
    const change = turnOff(state(['PRICING'], ['API']), 'API');
    expect(change.refused).toBe('FOUNDATION');
    expect(change.removed).toEqual([]);
    expect(change.selection.selected.has('PRICING')).toBe(true);
  });

  it('never reports a foundation card as removed', () => {
    // AUTH is foundation and API depends on it; switching AUTH off is refused,
    // but switching off something upstream must not claim AUTH went either.
    const change = turnOff(state(['PRICING'], ['AUTH']), 'API');
    expect(change.removed).not.toContain('AUTH');
    expect(change.selection.selected.has('AUTH')).toBe(true);
  });

  it('does nothing to a card that is already off', () => {
    const change = turnOff(state(['REPORTS']), 'PRICING');
    expect(change.removed).toEqual([]);
  });
});

describe('previewAdds', () => {
  it('answers what one click drags in ALONGSIDE the card, before the click', () => {
    // The candidate itself is excluded — the answer is "and what else".
    expect(previewAdds(ESTIMATE, 'PRICING', ['AUTH'])).toEqual(['API', 'SYNC']);
  });

  it('is empty for a card already on with its chain', () => {
    expect(previewAdds(ESTIMATE, 'AUTH', ['AUTH'])).toEqual([]);
  });
});

describe('consequencesOf', () => {
  const removes = (picks: string[], foundation: string[], id: string) =>
    consequencesOf(state(picks, foundation)).get(id)?.removes ?? [];

  it('reaches the whole chain, downstream and upstream', () => {
    // Same answer as turnOff, because it IS turnOff. AUTH is included: it was
    // on only because API needed it.
    expect(removes(['PRICING'], [], 'API')).toEqual(['AUTH', 'PRICING', 'SYNC']);
  });

  it('is empty in both directions for a foundation card', () => {
    const c = consequencesOf(state(['PRICING'], ['API'])).get('API');
    expect(c).toEqual({ adds: [], removes: [] });
  });

  it('reports adds for a card that is off and removes for one that is on', () => {
    const all = consequencesOf(state(['REPORTS']));
    // PRICING is off: turning it on brings its chain, minus AUTH — REPORTS
    // already needs AUTH, so it is on and is not something this click "adds".
    expect(all.get('PRICING')?.adds).toEqual(['API', 'SYNC']);
    expect(all.get('PRICING')?.removes).toEqual([]);
    // REPORTS is on and nothing depends on it — but it does not go alone:
    // AUTH is on only because REPORTS needs it, so AUTH goes too. "Nothing
    // depends on this" is not the same as "nothing goes with this".
    expect(all.get('REPORTS')?.adds).toEqual([]);
    expect(all.get('REPORTS')?.removes).toEqual(['AUTH']);
  });

  it('agrees with what a click actually does, for every card', () => {
    // The screen promises a consequence before the click; this pins that the
    // promise matches the outcome. It is not tautological even though
    // consequencesOf delegates: it is the regression guard against someone
    // re-deriving the removal set from a dependents walk for speed, which is
    // precisely the bug this caught — that misses cards UPSTREAM of the one
    // switched off, which lose their only reason to be on.
    const picks = ['PRICING', 'REPORTS'];
    const all = consequencesOf(state(picks));
    const { selected } = resolveSelection(state(picks));
    for (const [id, { adds, removes }] of all) {
      const change = selected.has(id) ? turnOff(state(picks), id) : turnOn(state(picks), id);
      expect(change.removed, `removes for ${id}`).toEqual(removes);
      expect(change.added, `adds for ${id}`).toEqual(adds);
    }
  });

  it('reports the upstream casualties, not just the dependents', () => {
    // Switching SYNC off drops PRICING (it needs SYNC) and also API (it was on
    // only because SYNC needed it). A dependents-only walk would report one.
    expect(removes(['PRICING', 'REPORTS'], [], 'SYNC')).toEqual(['API', 'PRICING']);
  });

  it('covers every node in the graph', () => {
    expect(consequencesOf(state([])).size).toBe(ESTIMATE.nodes.size);
  });
});

describe('the within-scope hazard, and why this design is immune to it', () => {
  // AEH-242 added `within` to `dependentsOf` for this feature and left its
  // semantics untested. It restricts the PATHS walked, not merely the answer:
  // a dependent reachable only THROUGH an out-of-scope node is not returned.
  // Pinned here because a "filter the results" rewrite would pass every other
  // test in this file.
  it('dependentsOf severs chains through out-of-scope nodes', () => {
    // PRICING needs SYNC needs API. With SYNC excluded from scope, PRICING is
    // unreachable from API even though it transitively needs it.
    expect([...dependentsOf(ESTIMATE, 'API', ['API', 'PRICING'])]).toEqual([]);
    // Put the intermediate back and the chain is walked in full.
    expect([...dependentsOf(ESTIMATE, 'API', ['API', 'SYNC', 'PRICING'])].sort()).toEqual([
      'PRICING',
      'SYNC',
    ]);
  });

  it('but a resolved selection is always dependency-closed, so no chain can be severed', () => {
    // This is the load-bearing invariant. `removalClosure` passes the resolved
    // selection as `within`, and `resolveSelection` pulls in every prerequisite
    // transitively — so a selection containing PRICING without SYNC is not a
    // state this system can represent. The severed-chain case above therefore
    // cannot arise from the configurator, whatever a user clicks.
    for (const picks of [['PRICING'], ['API', 'PRICING'], ['REPORTS', 'PRICING'], ['ISLAND']]) {
      const { selected } = resolveSelection(state(picks));
      for (const id of selected) {
        for (const need of ESTIMATE.edges.get(id) ?? []) {
          expect(selected.has(need)).toBe(true);
        }
      }
    }
  });
});

describe('cycle tolerance', () => {
  // A model-derived graph can contain a cycle. Persisting one is rejected
  // upstream, but the walks must stay finite regardless: a hung request in
  // front of a client is worse than a wrong answer.
  const looped = graphOf({ A: ['C'], B: ['A'], C: ['B'] });

  it('is detectable', () => {
    expect(findCycles(looped).length).toBeGreaterThan(0);
  });

  it('does not hang resolveSelection', () => {
    const { selected } = resolveSelection({
      graph: looped,
      picks: new Set(['A']),
      foundation: new Set(),
    });
    expect([...selected].sort()).toEqual(['A', 'B', 'C']);
  });

  it('does not hang turnOff', () => {
    const change = turnOff({ graph: looped, picks: new Set(['A']), foundation: new Set() }, 'A');
    expect(change.selection.selected.size).toBe(0);
  });
});
