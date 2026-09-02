import type { EstimateGraph, EstimateGraphNode } from '@repo/db';
import { resolveSelection, type EdgeNotes, type SelectionOrigin } from '@repo/shared';

/**
 * Shapes and pure mappers for the scope configurator. AEH-235.
 *
 * NOT a `'use server'` module, and that is load-bearing rather than tidy: every
 * export of a server-action module must be async, and a single synchronous
 * export there breaks `next build` while typecheck, lint and the whole unit
 * suite stay green (AEH-253). The sync mappers below therefore live here, and
 * `scope-actions.ts` next door holds only async functions.
 *
 * A `Map` never crosses the RSC boundary in this codebase — the admin preset
 * page serialises its graph as a plain adjacency record and rebuilds it on the
 * client. This follows that, so the configurator can run the identical walks in
 * the browser without a round trip per click.
 */

export type ScopeCardDTO = {
  id: string;
  title: string;
  taxonomyKey: string;
  phase: string | null;
  category: string | null;
  foundation: boolean;
  /** Whether the estimate itself counts this card — shown as the as-run baseline. */
  enabledAtRun: boolean;
  taxedHours: number;
  /** Direct prerequisites, for the "needs X, Y" line under a row. */
  needs: string[];
};

export type ScopeGraphDTO = {
  cards: ScopeCardDTO[];
  /** Of the edges below, how many a person typed. Survives a re-derive. */
  manualEdgeCount: number;
  /** cardId -> the cardIds it needs. Rebuilt into a graph on the client. */
  adjacency: Record<string, string[]>;
  /** `${dependentId}->${prerequisiteId}` -> why, for the cascade notice. */
  notes: Record<string, string>;
};

/** One saved configuration, as the picker lists it. */
export type ScenarioSummary = {
  id: string;
  name: string;
  updatedAt: string;
  /** Who cut it — attribution, so a colleague knows whose thinking this was. */
  author: string;
  pickCount: number;
};

export type ScenarioDTO = {
  id: string;
  name: string;
  picks: string[];
  updatedAt: string;
};

/** What the row renderer needs per card, once picks are resolved. */
export type ResolvedCard = ScopeCardDTO & {
  selected: boolean;
  origin: SelectionOrigin | null;
};

export type ScopeTotals = {
  /** Modules switched on. The reference artifact's headline figure. */
  moduleCount: number;
  /** Taxed hours of what is on. */
  hours: number;
  /** Taxed hours of selectable work that is off — priced, not counted. */
  excludedHours: number;
  cardsOff: number;
};

/**
 * Serialise an estimate's graph for the client.
 *
 * Injected cards are already excluded by `selectableOf`; edges naming one are
 * dropped here too, so the client's graph never contains a node it cannot
 * render. Leaving them in would let a cascade claim to have removed a module
 * that is not on the menu.
 */
export function toScopeGraphDTO(
  graph: EstimateGraph & { notes: EdgeNotes },
  selectable: EstimateGraphNode[],
): ScopeGraphDTO {
  const visible = new Set(selectable.map((n) => n.menuItemId));
  const adjacency: Record<string, string[]> = {};
  const notes: Record<string, string> = {};

  for (const node of selectable) {
    const needs = (graph.edges.get(node.menuItemId) ?? []).filter((d) => visible.has(d));
    adjacency[node.menuItemId] = needs;
    for (const need of needs) {
      const key = `${node.menuItemId}->${need}`;
      const note = graph.notes.get(key);
      if (note) notes[key] = note;
    }
  }

  const cards: ScopeCardDTO[] = selectable.map((n) => ({
    id: n.menuItemId,
    title: n.title,
    taxonomyKey: n.taxonomyKey,
    phase: n.phase,
    category: n.category,
    foundation: n.foundation,
    enabledAtRun: n.enabled,
    taxedHours: n.taxedHours,
    needs: adjacency[n.menuItemId] ?? [],
  }));

  return { cards, adjacency, notes, manualEdgeCount: graph.manualEdgeCount };
}

/** Rebuild a walkable graph from the serialised form, on either side. */
export function graphFromDTO(dto: ScopeGraphDTO): {
  edges: Map<string, string[]>;
  nodes: Map<string, ScopeCardDTO>;
} {
  const nodes = new Map<string, ScopeCardDTO>();
  const edges = new Map<string, string[]>();
  for (const card of dto.cards) {
    nodes.set(card.id, card);
    edges.set(card.id, dto.adjacency[card.id] ?? []);
  }
  return { edges, nodes };
}

/** Resolve picks against the graph and decorate every card for rendering. */
export function resolveCards(dto: ScopeGraphDTO, picks: Iterable<string>): ResolvedCard[] {
  const graph = graphFromDTO(dto);
  const foundation = new Set([...graph.nodes.values()].filter((c) => c.foundation).map((c) => c.id));
  const { selected, origin } = resolveSelection({ graph, picks, foundation });
  return dto.cards.map((card) => ({
    ...card,
    selected: selected.has(card.id),
    origin: origin.get(card.id) ?? null,
  }));
}

/**
 * Count and hours over a resolved selection.
 *
 * Hours only — no monetary value. The reference artifact carries an editable
 * rate and a derived money figure; that is deliberately out of scope, because
 * a number that looks like a price invites being read as one.
 */
export function totalsOf(cards: ResolvedCard[]): ScopeTotals {
  let hours = 0;
  let excludedHours = 0;
  let moduleCount = 0;
  let cardsOff = 0;
  for (const card of cards) {
    if (card.selected) {
      moduleCount += 1;
      hours += card.taxedHours;
    } else {
      cardsOff += 1;
      excludedHours += card.taxedHours;
    }
  }
  return {
    moduleCount,
    hours: Math.round(hours * 100) / 100,
    excludedHours: Math.round(excludedHours * 100) / 100,
    cardsOff,
  };
}

/** The picks that reproduce the estimate as the pipeline left it. */
export function asRunPicks(cards: ScopeCardDTO[]): string[] {
  return cards.filter((c) => c.enabledAtRun && !c.foundation).map((c) => c.id);
}
