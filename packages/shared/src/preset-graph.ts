/**
 * The preset dependency graph — pure traversals. AEH-242.
 *
 * These live in `shared`, not `db`, for a reason the type checker cannot state:
 * the admin picker runs them in the browser on a serialised graph, and anything
 * imported from `@repo/db` drags the Prisma client into the client bundle, which
 * fails at webpack rather than at `tsc`. Loading the graph is a database
 * concern and stays there; walking it is not.
 *
 * Sharing them is also what keeps the picker and the server guard honest. The UI
 * decides what to offer and the action decides what to accept — two
 * implementations of that walk would eventually disagree, and the UI would offer
 * an edge the server then rejects.
 */

/** One node, carrying just enough to render it without a second query. */
export type PresetGraphNode = {
  presetId: string;
  code: string | null;
  name: string;
  devHours: number;
  /** The active version's id — the row an edge would be written against. */
  versionId: string;
};

export type PresetGraph = {
  /** presetId -> the presetIds it needs. Every node has an entry, possibly empty. */
  edges: Map<string, string[]>;
  nodes: Map<string, PresetGraphNode>;
};

/** presetId -> the note explaining why, keyed by `${dependentId}->${prerequisiteId}`. */
export type EdgeNotes = Map<string, string>;

export function edgeKey(dependentPresetId: string, prerequisitePresetId: string): string {
  return `${dependentPresetId}->${prerequisitePresetId}`;
}

/**
 * Everything `presetId` transitively needs, excluding itself.
 *
 * Not scoped: prerequisites are what must come WITH a selection, so restricting
 * them to an existing set would defeat the purpose. Contrast `dependentsOf`.
 *
 * Cycle-safe by construction — the visited set is the termination condition, so
 * a cycle in the data yields a finite (if meaningless) answer instead of
 * hanging. The editor prevents cycles; this survives one written another way.
 */
export function prerequisitesOf(graph: PresetGraph, presetId: string): Set<string> {
  const out = new Set<string>();
  const stack = [...(graph.edges.get(presetId) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (next === presetId || out.has(next)) continue;
    out.add(next);
    for (const dep of graph.edges.get(next) ?? []) stack.push(dep);
  }
  return out;
}

/**
 * Everything that transitively needs `presetId`, excluding itself.
 *
 * `within` restricts the answer to a candidate set — pass the currently selected
 * cards and you get "what would removing this break, here", which is the only
 * form the configurator can act on. Omit it for the library-wide answer.
 */
export function dependentsOf(graph: PresetGraph, presetId: string, within?: Iterable<string>): Set<string> {
  const scope = within ? new Set(within) : null;
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [candidate, deps] of graph.edges) {
      if (candidate === presetId || out.has(candidate)) continue;
      if (scope && !scope.has(candidate)) continue;
      if (deps.some((d) => d === presetId || out.has(d))) {
        out.add(candidate);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Would adding `dependent -> prerequisite` close a loop?
 *
 * This is the editor's guard, and the reason the picker can present only valid
 * options instead of validating after the fact. A cycle means there is no order
 * the work can be done in, so the configurator's cascade would never terminate
 * and the delivery waves would be undefined.
 */
export function wouldCreateCycle(graph: PresetGraph, dependentPresetId: string, prerequisitePresetId: string): boolean {
  if (dependentPresetId === prerequisitePresetId) return true;
  return prerequisitesOf(graph, prerequisitePresetId).has(dependentPresetId);
}

/**
 * Presets that may legally become prerequisites of `presetId`.
 *
 * Everything except itself, its existing prerequisites, and anything downstream
 * of it. Feeding this to the picker is what removes the need to hold the graph
 * in your head: an invalid edge is not rejected, it is never offered.
 */
export function candidatePrerequisitesFor(graph: PresetGraph, presetId: string): PresetGraphNode[] {
  const existing = new Set(graph.edges.get(presetId) ?? []);
  const downstream = dependentsOf(graph, presetId);
  const out: PresetGraphNode[] = [];
  for (const [id, node] of graph.nodes) {
    if (id === presetId || existing.has(id) || downstream.has(id)) continue;
    out.push(node);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Edges that are already implied by a longer path — X needs Y directly while
 * also reaching Y through Z.
 *
 * Reported, never removed. Transitive reduction is unsafe under editing: drop
 * the direct edge because a path covers it, then let someone delete a link in
 * that path, and the dependency is gone with no trace it ever existed. The
 * editor labels these ("also required via Z") and leaves the call to a human.
 */
export function redundantEdgesOf(graph: PresetGraph, presetId: string): Map<string, string[]> {
  const direct = graph.edges.get(presetId) ?? [];
  const out = new Map<string, string[]>();
  for (const target of direct) {
    const viaOthers = direct
      .filter((other) => other !== target)
      .filter((other) => prerequisitesOf(graph, other).has(target));
    if (viaOthers.length > 0) out.set(target, viaOthers);
  }
  return out;
}

/**
 * The graph in delivery order: layer 0 needs nothing, layer N needs only layers
 * before it. Everything within a layer can be worked in parallel.
 *
 * This is the resource-planning view, and it is the same walk the configurator
 * uses — one relation, two payoffs. `within` restricts it to a selection so an
 * estimate can be laid out on its own cards.
 *
 * Any node left over after no layer can be formed is in a cycle; it is returned
 * as a final layer rather than dropped, because silently omitting work from a
 * plan is worse than showing it in the wrong place. `findCycles` names the
 * culprits.
 */
export function topologicalLayers(graph: PresetGraph, within?: Iterable<string>): string[][] {
  const scope = within ? new Set(within) : new Set(graph.nodes.keys());
  const remaining = new Set([...scope].filter((id) => graph.nodes.has(id)));
  const placed = new Set<string>();
  const layers: string[][] = [];

  while (remaining.size > 0) {
    const layer: string[] = [];
    for (const id of remaining) {
      const deps = (graph.edges.get(id) ?? []).filter((d) => remaining.has(d) || placed.has(d));
      if (deps.every((d) => placed.has(d))) layer.push(id);
    }
    if (layer.length === 0) {
      layers.push([...remaining].sort());
      break;
    }
    layer.sort();
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      placed.add(id);
    }
  }
  return layers;
}

/**
 * Every cycle reachable in the graph, each as the list of presets involved.
 *
 * Should always be empty — the editor cannot create one. It exists because the
 * previous model's arrays held exactly one cycle that nothing could detect, and
 * an invariant with no test is a hope. Used by the DAG invariant test and worth
 * running after any bulk import.
 */
export function findCycles(graph: PresetGraph): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];

  const walk = (id: string): void => {
    if (onPath.has(id)) {
      cycles.push(path.slice(path.indexOf(id)));
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    onPath.add(id);
    path.push(id);
    for (const dep of graph.edges.get(id) ?? []) walk(dep);
    path.pop();
    onPath.delete(id);
  };

  for (const id of graph.nodes.keys()) walk(id);
  return cycles;
}
