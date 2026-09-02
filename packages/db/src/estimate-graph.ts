import { edgeKey, findCycles, type EdgeNotes, type Walkable, wouldCreateCycle } from '@repo/shared';

import type { PrismaClient } from './generated/client/index.js';

/**
 * Database access for an ESTIMATE's own dependency graph — AEH-235.
 *
 * The estimate owns this graph. Dependencies are a property of the project being
 * built, so they are computed for that project and stored against it; the preset
 * library's graph is the secondary copy, and it is not required here. That
 * matters concretely rather than philosophically: only 12 of 140 cards in the
 * system carry a `sourcePresetId` at all, so a configurator that needed presets
 * would be unavailable on essentially every real estimate.
 *
 * The traversals live in `@repo/shared` so the configurator can run the
 * identical walk in the browser; see the note there. This file is the half that
 * needs Prisma, and like `preset-graph.ts` it deliberately does not re-export
 * them — a caller reaching for a walk should reach for `@repo/shared`, which is
 * the import that also works in a client component.
 */

/** One card, carrying what the configurator renders without a second query. */
export type EstimateGraphNode = {
  menuItemId: string;
  title: string;
  taxonomyKey: string;
  /** Foundation | Core | Enhancement, or null where the run never set one. */
  phase: string | null;
  category: string | null;
  sectionId: string | null;
  /** Always included: the toggle renders but does nothing. */
  foundation: boolean;
  /** Whether the estimate itself counts this card today. */
  enabled: boolean;
  /** Injected placeholder (overhead, hidden work) rather than client-facing scope. */
  injected: boolean;
  /** Sum of every line item's taxed hours — the same figure the ledger shows. */
  taxedHours: number;
  order: number;
};

export type EstimateGraph = {
  /** menuItemId -> the menuItemIds it needs. Every node has an entry. */
  edges: Map<string, string[]>;
  nodes: Map<string, EstimateGraphNode>;
};

/**
 * Load one estimate's cards and the graph over them, in one round trip.
 *
 * Unfiltered by `enabled` on purpose. A switched-off card is still part of the
 * graph — the configurator's entire job is to switch things back on, and a
 * prerequisite missing from the graph because it happens to be off today would
 * make the cascade quietly wrong rather than visibly incomplete.
 */
export async function loadEstimateGraph(
  db: PrismaClient,
  estimateId: string,
): Promise<EstimateGraph & { notes: EdgeNotes }> {
  const [cards, deps] = await Promise.all([
    db.menuItem.findMany({
      where: { estimateId },
      select: {
        id: true,
        title: true,
        taxonomyKey: true,
        phase: true,
        category: true,
        sectionId: true,
        foundation: true,
        enabled: true,
        injected: true,
        order: true,
        lineItems: { select: { taxedHours: true } },
      },
      orderBy: { order: 'asc' },
    }),
    db.menuItemDependency.findMany({
      where: { estimateId },
      select: { dependentId: true, prerequisiteId: true, note: true },
    }),
  ]);

  const nodes = new Map<string, EstimateGraphNode>();
  const edges = new Map<string, string[]>();
  const notes: EdgeNotes = new Map();

  for (const c of cards) {
    nodes.set(c.id, {
      menuItemId: c.id,
      title: c.title,
      taxonomyKey: c.taxonomyKey,
      phase: c.phase,
      category: c.category,
      sectionId: c.sectionId,
      foundation: c.foundation,
      enabled: c.enabled,
      injected: c.injected,
      taxedHours: c.lineItems.reduce((sum, li) => sum + li.taxedHours, 0),
      order: c.order,
    });
    // Every node needs an entry, possibly empty — the walks rely on it.
    edges.set(c.id, []);
  }

  for (const d of deps) {
    // An edge whose ends are not both cards of this estimate cannot be walked.
    // The foreign keys guarantee the cards exist; they cannot guarantee both
    // belong to THIS estimate, and no CHECK can. Drop rather than trust, the
    // same way loadPresetGraph drops edges into dead presets.
    if (!nodes.has(d.dependentId) || !nodes.has(d.prerequisiteId)) continue;
    edges.get(d.dependentId)!.push(d.prerequisiteId);
    if (d.note) notes.set(edgeKey(d.dependentId, d.prerequisiteId), d.note);
  }

  return { nodes, edges, notes };
}

/**
 * The cards a configurator should offer.
 *
 * Injected cards are excluded: overhead and hidden-work placeholders are real
 * cost but they are not scope a client chooses. Offering "Process overhead" as
 * a togglable module would be wrong, and letting a client switch it off would be
 * worse. They stay in the estimate and in the delivery total; they are simply
 * not on the menu.
 */
export function selectableOf(graph: EstimateGraph): EstimateGraphNode[] {
  return [...graph.nodes.values()]
    .filter((n) => !n.injected)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

export type EdgeInput = {
  dependentId: string;
  prerequisiteId: string;
  note?: string | null;
};

export type EdgeWriteResult = {
  written: EdgeInput[];
  /** Edges refused, each with the reason, so a caller can report rather than guess. */
  rejected: Array<EdgeInput & { reason: 'UNKNOWN_CARD' | 'SELF_EDGE' | 'CYCLE' | 'DUPLICATE' }>;
};

/**
 * Replace an estimate's dependency graph with a validated, acyclic one.
 *
 * Three guards, applied before anything is written. They are not defensive
 * padding: a derived graph is only as good as whatever derived it, and the
 * reference artifact this feature was specified against has no guards at all —
 * it would add a dependency on a module that does not exist and then throw in
 * its own totals function.
 *
 *   - Unknown card: dropped. `loadPresetGraph` does the same for dead presets.
 *   - Self-edge: dropped. The database also refuses these, so this exists to
 *     report the reason rather than surface a constraint violation.
 *   - Cycle: dropped, one edge at a time, in a **sorted** order. Sorted because
 *     the caller's emission order must not silently decide which edge of a loop
 *     survives — with a stable order, the same input always yields the same
 *     graph.
 *
 * A cycle means there is no order the work can be done in, so the delivery waves
 * would be undefined and a naive cascade would not terminate. The walks in
 * `@repo/shared` all survive one, but surviving is not the same as being right.
 */
export async function replaceEstimateGraph(
  db: PrismaClient,
  estimateId: string,
  proposed: EdgeInput[],
  source: 'INFERRED' | 'PRESET' | 'MANUAL',
): Promise<EdgeWriteResult> {
  const cards = await db.menuItem.findMany({ where: { estimateId }, select: { id: true } });
  const known = new Set(cards.map((c) => c.id));

  const written: EdgeInput[] = [];
  const rejected: EdgeWriteResult['rejected'] = [];

  // Build up the graph as we accept edges, so each cycle check sees exactly what
  // has been accepted so far rather than the whole proposal.
  const edges = new Map<string, string[]>();
  const nodes = new Map<string, unknown>();
  for (const id of known) {
    edges.set(id, []);
    nodes.set(id, true);
  }
  const accumulating: Walkable = { edges, nodes };

  const seen = new Set<string>();
  const ordered = [...proposed].sort(
    (a, b) =>
      a.dependentId.localeCompare(b.dependentId) || a.prerequisiteId.localeCompare(b.prerequisiteId),
  );

  for (const edge of ordered) {
    if (!known.has(edge.dependentId) || !known.has(edge.prerequisiteId)) {
      rejected.push({ ...edge, reason: 'UNKNOWN_CARD' });
      continue;
    }
    if (edge.dependentId === edge.prerequisiteId) {
      rejected.push({ ...edge, reason: 'SELF_EDGE' });
      continue;
    }
    const key = edgeKey(edge.dependentId, edge.prerequisiteId);
    if (seen.has(key)) {
      rejected.push({ ...edge, reason: 'DUPLICATE' });
      continue;
    }
    if (wouldCreateCycle(accumulating, edge.dependentId, edge.prerequisiteId)) {
      rejected.push({ ...edge, reason: 'CYCLE' });
      continue;
    }
    seen.add(key);
    edges.get(edge.dependentId)!.push(edge.prerequisiteId);
    written.push(edge);
  }

  // The post-condition, not a second opinion. `wouldCreateCycle` is checked per
  // edge against a graph built in the same loop, so this can only fail if that
  // reasoning is wrong — which is exactly when an assertion earns its keep. The
  // previous model shipped with one undetectable cycle in it for months.
  const cycles = findCycles(accumulating);
  if (cycles.length > 0) {
    throw new Error(
      `Refusing to write a cyclic dependency graph for estimate ${estimateId}: ${cycles
        .map((c) => c.join(' -> '))
        .join('; ')}`,
    );
  }

  await db.$transaction([
    db.menuItemDependency.deleteMany({ where: { estimateId } }),
    db.menuItemDependency.createMany({
      data: written.map((e) => ({
        estimateId,
        dependentId: e.dependentId,
        prerequisiteId: e.prerequisiteId,
        note: e.note ?? null,
        source,
      })),
    }),
  ]);

  return { written, rejected };
}
