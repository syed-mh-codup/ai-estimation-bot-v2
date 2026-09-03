/**
 * Scope selection and its cascade — pure. AEH-235.
 *
 * The configurator's rules, kept apart from the graph traversals in
 * `preset-graph.ts` because they are a different kind of thing: those answer
 * "what does this graph say", these answer "what is switched on, and what
 * happens when somebody changes their mind". Generic over `Walkable`, so they
 * run against an estimate's own card graph (the real use) or the preset library
 * (the admin workbench) without knowing which.
 *
 * ## Only the picks are durable
 *
 * The one piece of stored state is the set of cards a human explicitly chose.
 * Everything else — what is on, and why — is derived by `resolveSelection` on
 * every read. That is deliberate: the alternative, storing the resolved
 * selection, means two representations of the same fact and a migration every
 * time an edge changes underneath it.
 *
 * It also makes provenance free rather than a field somebody has to remember to
 * maintain. A card that is on but was never picked is on because something else
 * needs it, which is exactly what the UI has to say. The reference artifact this
 * feature was specified against could not say it: its selection was a flat
 * `Set` with no provenance, so a module dragged in by a cascade was
 * indistinguishable from one the client had asked for.
 *
 * ## The two cascades are not symmetric, and that is not an oversight
 *
 * Turning something ON adds what it needs, unscoped — a prerequisite that is
 * currently off is the entire point.
 *
 * Turning something OFF removes what needs it, scoped to what is currently on.
 * Work that is already excluded cannot be broken by excluding more.
 */

import { dependentsOf, prerequisitesOf, type Walkable } from './preset-graph.js';

/**
 * Why a card is switched on.
 *
 * Ordered by precedence, which matters when a card qualifies for more than one:
 * `FOUNDATION` outranks `PICKED` because unremovable is the more important fact
 * to show, and `PICKED` outranks `IMPLIED` because an explicit choice must
 * survive the removal of whatever else happened to need it.
 */
export type SelectionOrigin = 'FOUNDATION' | 'PICKED' | 'IMPLIED';

export type Selection = {
  /** Every card that is switched on. */
  selected: Set<string>;
  /** For each selected card, why. */
  origin: Map<string, SelectionOrigin>;
};

export type SelectionState = {
  graph: Walkable;
  /**
   * The durable state: cards a human explicitly switched on.
   *
   * An iterable rather than a set, because it is only ever iterated or copied —
   * callers get their picks from a database row or a serialised array, and
   * making every one of them build a `Set` first buys nothing.
   */
  picks: Iterable<string>;
  /**
   * Cards that are always on. Per-estimate, never a library-wide flag — a
   * library spanning storefronts and e-learning has no universal foundation.
   *
   * A set, unlike `picks`, because this one is membership-tested per card.
   */
  foundation: ReadonlySet<string>;
};

/** The outcome of one toggle, with enough detail to render and to undo it. */
export type SelectionChange = {
  /** The new durable pick set — persist this. */
  picks: Set<string>;
  /** The resolved result of those picks. */
  selection: Selection;
  /** Switched on by this change, excluding the card that was clicked. */
  added: string[];
  /** Switched off by this change, excluding the card that was clicked. */
  removed: string[];
  /**
   * Set when the toggle did nothing. `FOUNDATION` means the card is always on;
   * `UNKNOWN` means it is not in the graph at all, which a stale client can
   * still ask for.
   */
  refused?: 'FOUNDATION' | 'UNKNOWN';
};

/**
 * Resolve picks into what is actually on.
 *
 * Foundation is added unconditionally and its prerequisites are pulled in with
 * it — a foundation card that needs something is still a card that needs
 * something, and the reference artifact got this wrong by giving its
 * always-included modules no dependency entries at all, which quietly made the
 * rule "foundation has no prerequisites" instead of "foundation is always on".
 *
 * Ids absent from the graph are dropped rather than trusted. A pick can outlive
 * the card it named (a re-run replaces every card), and a phantom id in the
 * selected set would be counted in the totals and crash the row renderer. The
 * reference artifact has this bug latent: it adds dependency targets without an
 * existence check and would throw in its own totals function.
 */
export function resolveSelection(state: SelectionState): Selection {
  const { graph, picks, foundation } = state;
  const selected = new Set<string>();
  const origin = new Map<string, SelectionOrigin>();

  const admit = (id: string, why: SelectionOrigin): void => {
    if (!graph.nodes.has(id)) return;
    const held = origin.get(id);
    if (held !== undefined && rank(held) <= rank(why)) return;
    selected.add(id);
    origin.set(id, why);
  };

  // Seeds first, strongest origin first, so precedence needs no second pass.
  for (const id of foundation) admit(id, 'FOUNDATION');
  for (const id of picks) admit(id, 'PICKED');

  // Then the closure. Every seed drags in everything it transitively needs.
  for (const id of [...selected]) {
    for (const need of prerequisitesOf(graph, id)) admit(need, 'IMPLIED');
  }

  return { selected, origin };
}

const RANK: Record<SelectionOrigin, number> = { FOUNDATION: 0, PICKED: 1, IMPLIED: 2 };
const rank = (o: SelectionOrigin): number => RANK[o];

/**
 * What turning `candidate` on would drag in ALONGSIDE it that is not already on.
 *
 * The question a picker has to answer before the click, not after — showing the
 * consequence at the moment of the decision is what stops a cascade being a
 * surprise. Promoted out of the admin dependency editor, where it was inlined,
 * so that editor and this one cannot drift apart on it.
 *
 * Excludes the candidate itself, matching `SelectionChange.added`: the answer is
 * "and what else", because the thing you clicked is not news.
 */
export function previewAdds(graph: Walkable, candidate: string, alreadyOn: Iterable<string>): string[] {
  if (!graph.nodes.has(candidate)) return [];
  const have = new Set(alreadyOn);
  return [...prerequisitesOf(graph, candidate)].filter((need) => !have.has(need)).sort();
}

/**
 * What clicking each card would actually do.
 *
 * Delegates to `turnOn` / `turnOff` rather than reimplementing their reasoning,
 * and that is the whole point. An earlier version of this walked dependents
 * directly, which looked equivalent and was not: switching a card off also
 * drops cards UPSTREAM of it that lose their only reason to be on, and a
 * downstream-only walk misses them. The screen would have promised "would also
 * drop 1" and then dropped two. There is now exactly one definition of what a
 * click does, so the preview and the outcome cannot disagree.
 *
 * Cost is one resolve per card, so callers should memoise on (graph, picks) —
 * the configurator does. Asking per row inside a render loop instead would pay
 * it on every row of every render.
 */
export function consequencesOf(
  state: SelectionState,
): Map<string, { adds: string[]; removes: string[] }> {
  const { graph, foundation } = state;
  const { selected } = resolveSelection(state);
  const out = new Map<string, { adds: string[]; removes: string[] }>();

  for (const id of graph.nodes.keys()) {
    // Foundation cannot move in either direction, so nothing may be reported as
    // moving because of it.
    if (foundation.has(id)) {
      out.set(id, { adds: [], removes: [] });
      continue;
    }
    const change = selected.has(id) ? turnOff(state, id) : turnOn(state, id);
    out.set(id, { adds: change.added, removes: change.removed });
  }
  return out;
}

/** Switch a card on, pulling in everything it needs. */
export function turnOn(state: SelectionState, id: string): SelectionChange {
  const before = resolveSelection(state);
  if (!state.graph.nodes.has(id)) return unchanged(state, before, 'UNKNOWN');
  if (state.foundation.has(id)) return unchanged(state, before, 'FOUNDATION');

  const picks = new Set(state.picks);
  picks.add(id);
  const selection = resolveSelection({ ...state, picks });
  return {
    picks,
    selection,
    added: diff(selection.selected, before.selected, id),
    removed: [],
  };
}

/**
 * Switch a card off, dropping everything that depends on it.
 *
 * Clearing the pick on `id` alone is not enough, and this is the subtle part:
 * a card that is on because something else needs it has no pick to clear, so
 * re-resolving would immediately pull it back. The dependents' picks have to go
 * too, which is also the honest description of what happened — the client did
 * not just lose this module, they lost the things that cannot exist without it.
 */
export function turnOff(state: SelectionState, id: string): SelectionChange {
  const before = resolveSelection(state);
  if (!state.graph.nodes.has(id)) return unchanged(state, before, 'UNKNOWN');
  if (state.foundation.has(id)) return unchanged(state, before, 'FOUNDATION');
  if (!before.selected.has(id)) return unchanged(state, before);

  const picks = new Set(state.picks);
  picks.delete(id);
  for (const dependent of dependentsOf(state.graph, id, before.selected)) picks.delete(dependent);

  const selection = resolveSelection({ ...state, picks });
  return {
    picks,
    selection,
    added: [],
    removed: diff(before.selected, selection.selected, id),
  };
}

function unchanged(
  state: SelectionState,
  selection: Selection,
  refused?: SelectionChange['refused'],
): SelectionChange {
  return { picks: new Set(state.picks), selection, added: [], removed: [], ...(refused ? { refused } : {}) };
}

/** Members of `a` missing from `b`, minus the card that was clicked. */
function diff(a: ReadonlySet<string>, b: ReadonlySet<string>, exclude: string): string[] {
  return [...a].filter((id) => id !== exclude && !b.has(id)).sort();
}
