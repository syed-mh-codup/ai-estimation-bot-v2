import { describe, expect, it } from 'vitest';

import type { SelectionState, Walkable } from '@repo/shared';

import {
  deriveSummary,
  pushUndo,
  resolveToggle,
  saveStateOf,
  splitSseFrames,
  UNDO_LIMIT,
  type ToggleTarget,
} from './scope-interaction';

/**
 * AEH-235. What one click on the configurator means.
 *
 * These exist because this logic used to live inside a React component, where
 * the only thing that could reach it was Playwright — minutes per run, for
 * assertions about pluralisation and undo bounds. Everything below runs in
 * milliseconds. The e2e specs keep the claims only a browser can make (a real
 * round trip through the server action, a reload, the estimate staying
 * untouched); the copy and the state machine are checked here.
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

/** API needs AUTH; SYNC needs API; REPORTS is independent. */
const GRAPH = graphOf({ AUTH: [], API: ['AUTH'], SYNC: ['API'], REPORTS: [] });

const TITLES: Record<string, string> = {
  AUTH: 'Identity & access',
  API: 'Public API',
  SYNC: 'Nightly sync',
  REPORTS: 'Reporting',
};
const titleOf = (id: string) => TITLES[id] ?? id;

const state = (picks: string[], foundation: string[] = []): SelectionState => ({
  graph: GRAPH,
  picks: new Set(picks),
  foundation: new Set(foundation),
});

const target = (id: string, over: Partial<ToggleTarget> = {}): ToggleTarget => ({
  id,
  title: titleOf(id),
  selected: false,
  foundation: false,
  ...over,
});

describe('resolveToggle — switching something on', () => {
  it('names how many came with it, and which', () => {
    const out = resolveToggle(state([]), target('SYNC'), titleOf);
    expect(out.kind).toBe('applied');
    expect(out.notice.kind).toBe('added');
    expect(out.notice.text).toBe(
      'Nightly sync switched on, and it needs 2 more: Public API, Identity & access.',
    );
  });

  it('says nothing about extras when there are none', () => {
    const out = resolveToggle(state(['API']), target('SYNC'), titleOf);
    expect(out.notice.text).toBe('Nightly sync switched on.');
  });

  it('carries the pick set to persist', () => {
    const out = resolveToggle(state([]), target('REPORTS'), titleOf);
    expect(out.kind === 'applied' && out.picks).toEqual(['REPORTS']);
  });
});

describe('resolveToggle — switching something off', () => {
  it('names what went with it, because silence would be a lie', () => {
    // The reference artifact removes dependents with no warning at all; against
    // its own data one click drops 32 of 45 modules. This text is the fix.
    const out = resolveToggle(state(['SYNC']), target('API', { selected: true }), titleOf);
    expect(out.notice.kind).toBe('removed');
    expect(out.notice.text).toBe(
      'Public API switched off. 2 other modules went with it: Identity & access, Nightly sync.',
    );
  });

  it('says "module", not "modules", when exactly one goes', () => {
    const out = resolveToggle(state(['API']), target('AUTH', { selected: true }), titleOf);
    expect(out.notice.text).toContain('1 other module went with it');
    expect(out.notice.text).not.toContain('modules');
  });

  it('reports a lone removal plainly', () => {
    const out = resolveToggle(state(['REPORTS']), target('REPORTS', { selected: true }), titleOf);
    expect(out.notice.text).toBe('Reporting switched off.');
  });
});

describe('resolveToggle — refusals', () => {
  it('explains a foundation card rather than doing nothing visible', () => {
    const out = resolveToggle(
      state(['API']),
      target('AUTH', { selected: true, foundation: true }),
      titleOf,
    );
    expect(out.kind).toBe('refused');
    expect(out.notice.text).toBe('Identity & access is always included — nothing runs without it.');
  });

  it('refuses before consulting the graph, so the card need not be in it', () => {
    // A foundation card the client is holding but the graph no longer has must
    // still produce the always-included message, not a "reload" one.
    const out = resolveToggle(state([]), target('GONE', { foundation: true }), titleOf);
    expect(out.kind).toBe('refused');
    expect(out.notice.text).toContain('always included');
  });

  it('tells the user to reload when the card is not in the graph at all', () => {
    // A stale client after a re-run replaced every card.
    const out = resolveToggle(state([]), target('GONE'), titleOf);
    expect(out.kind).toBe('refused');
    expect(out.notice.text).toBe('GONE is no longer part of this estimate. Reload the page.');
  });
});

describe('pushUndo', () => {
  it('puts the newest first', () => {
    const stack = pushUndo(pushUndo([], { picks: ['A'], label: 'first' }), {
      picks: ['B'],
      label: 'second',
    });
    expect(stack.map((s) => s.label)).toEqual(['second', 'first']);
  });

  it('is bounded, so it stays undo rather than becoming a log', () => {
    let stack = [] as ReturnType<typeof pushUndo>;
    for (let i = 0; i < UNDO_LIMIT + 5; i += 1) {
      stack = pushUndo(stack, { picks: [], label: `step ${i}` });
    }
    expect(stack).toHaveLength(UNDO_LIMIT);
    expect(stack[0]?.label).toBe(`step ${UNDO_LIMIT + 4}`);
  });
});

describe('saveStateOf', () => {
  it('says saving while a write is in flight', () => {
    expect(saveStateOf({ pending: true, savedAt: 0 })).toBe('saving');
  });

  it('confirms after one lands', () => {
    expect(saveStateOf({ pending: false, savedAt: 1_700_000_000_000 })).toBe('saved');
  });

  it('is silent once the confirmation has cleared', () => {
    expect(saveStateOf({ pending: false, savedAt: 0 })).toBe('idle');
  });

  it('prefers saving over a stale confirmation', () => {
    // Otherwise a second change would show "Saved" from the previous one while
    // the new write is still going — the exact reassurance you must not give.
    expect(saveStateOf({ pending: true, savedAt: 1_700_000_000_000 })).toBe('saving');
  });
});

describe('splitSseFrames', () => {
  it('reads complete frames and carries the remainder', () => {
    // A network read can end mid-frame. Getting this wrong is invisible on a
    // single-frame response and drops progress the moment it is chunked.
    const { events, rest } = splitSseFrames(
      'data: {"type":"progress","stage":"reading","label":"Reading","pct":0}\n\ndata: {"type":"pro',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'progress', stage: 'reading' });
    expect(rest).toBe('data: {"type":"pro');
  });

  it('reassembles across reads', () => {
    const first = splitSseFrames('data: {"type":"done","result":{"writ');
    expect(first.events).toEqual([]);
    const second = splitSseFrames(
      `${first.rest}ten":2,"preserved":0,"rejected":[],"foundation":[],"notes":""}}\n\n`,
    );
    expect(second.events[0]).toMatchObject({ type: 'done' });
  });

  it('skips a malformed frame rather than failing the operation', () => {
    const { events } = splitSseFrames('data: not-json\n\ndata: {"type":"error","error":"nope"}\n\n');
    expect(events).toEqual([{ type: 'error', error: 'nope' }]);
  });

  it('is empty for an empty buffer', () => {
    expect(splitSseFrames('').events).toEqual([]);
  });
});

describe('deriveSummary', () => {
  const base = { written: 0, preserved: 0, rejected: [], foundation: [], notes: '' };

  it('reads naturally for one dependency', () => {
    expect(deriveSummary({ ...base, written: 1 })).toBe('Found 1 dependency.');
  });

  it('says what it kept, so a re-derive does not look destructive', () => {
    expect(deriveSummary({ ...base, written: 4, preserved: 2 })).toBe(
      'Found 4 dependencies · kept 2 you typed.',
    );
  });

  it('names refusals rather than swallowing them', () => {
    // They are how anyone finds out the model proposed a loop or invented a
    // card. A summary of successes only would look like a complete graph.
    const summary = deriveSummary({
      ...base,
      written: 3,
      rejected: [{ reason: 'CYCLE', detail: 'A → B' }],
    });
    expect(summary).toContain('1 proposal refused');
  });

  it('carries the model’s own note when it left one', () => {
    expect(deriveSummary({ ...base, written: 2, notes: 'Read as two tracks.' })).toBe(
      'Found 2 dependencies. Read as two tracks.',
    );
  });

  it('reports an empty graph as a real answer', () => {
    // Most cards in most estimates depend on nothing, and the prompt argues for
    // restraint — "no edges" must not read as a failure.
    expect(deriveSummary(base)).toBe('Found 0 dependencies.');
  });
});
