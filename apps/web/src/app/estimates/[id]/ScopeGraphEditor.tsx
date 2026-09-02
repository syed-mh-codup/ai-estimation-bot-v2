'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import { candidatePrerequisiteIds, prerequisitesOf } from '@repo/shared';

import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/card';

import { saveEstimateGraph, setCardFoundation } from './scope-actions';
import { ScopeDerive } from './ScopeDerive';
import { graphFromDTO, type ScopeGraphDTO } from './scope-dto';

/**
 * Author an estimate's dependency graph by hand. AEH-235.
 *
 * The graph belongs to the estimate, so something has to be able to put one
 * there. This is that something, and it is deliberately the boring version: one
 * question per card — what must exist before this — which is answerable from
 * domain knowledge without holding the whole graph in your head.
 *
 * Two rules carried over from the preset dependency editor, because they are
 * what make editing a graph tractable at all:
 *
 *   - An invalid option is never offered. Everything downstream of a card is
 *     absent from its candidate list, so a cycle is unrepresentable rather than
 *     rejected after the fact. `candidatePrerequisiteIds` is the shared rule, so
 *     this picker and the server guard cannot disagree.
 *   - The consequence is shown at the moment of the decision: each candidate
 *     carries what it would transitively drag in.
 *
 * Edges are saved as a whole graph rather than one at a time. `saveEstimateGraph`
 * revalidates and re-guards the entire set, which is the only way to be sure the
 * result is acyclic — a per-edge endpoint would have to trust the accumulated
 * state it was given.
 */
export function ScopeGraphEditor({
  estimateId,
  graph,
}: {
  estimateId: string;
  graph: ScopeGraphDTO;
}) {
  const router = useRouter();
  const [edges, setEdges] = useState<Record<string, string[]>>(() => ({ ...graph.adjacency }));
  const [foundation, setFoundation] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(graph.cards.map((c) => [c.id, c.foundation])),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const titleOf = useMemo(
    () => new Map(graph.cards.map((c) => [c.id, c.title])),
    [graph],
  );

  /** The working graph, rebuilt on every change so candidates stay honest. */
  const working = useMemo(() => {
    const base = graphFromDTO(graph);
    const nodes = base.nodes;
    const e = new Map<string, string[]>();
    for (const id of nodes.keys()) e.set(id, edges[id] ?? []);
    return { nodes, edges: e };
  }, [graph, edges]);

  const addEdge = (dependentId: string, prerequisiteId: string) => {
    setEdges((prev) => ({
      ...prev,
      [dependentId]: [...(prev[dependentId] ?? []), prerequisiteId],
    }));
    setMessage(null);
  };

  const removeEdge = (dependentId: string, prerequisiteId: string) => {
    setEdges((prev) => ({
      ...prev,
      [dependentId]: (prev[dependentId] ?? []).filter((d) => d !== prerequisiteId),
    }));
    setMessage(null);
  };

  const save = () => {
    startTransition(async () => {
      try {
        const flat = Object.entries(edges).flatMap(([dependentId, prereqs]) =>
          prereqs.map((prerequisiteId) => ({ dependentId, prerequisiteId })),
        );
        const result = await saveEstimateGraph(estimateId, flat);
        for (const [cardId, isFoundation] of Object.entries(foundation)) {
          if (isFoundation !== (initialFoundation(graph, cardId) ?? false)) {
            await setCardFoundation(cardId, isFoundation);
          }
        }
        setMessage(
          result.rejected.length > 0
            ? `Saved ${result.written} dependencies. ${result.rejected.length} refused: ${result.rejected
                .map((r) => r.reason.toLowerCase().replace('_', ' '))
                .join(', ')}.`
            : `Saved ${result.written} ${result.written === 1 ? 'dependency' : 'dependencies'}.`,
        );
        // The page is a server component and the graph it handed down is now
        // stale — the configurator must re-resolve against the new edges.
        router.refresh();
      } catch (e) {
        setMessage(e instanceof Error ? e.message : 'Could not save the graph');
      }
    });
  };

  return (
    <div data-testid="scope-graph-editor" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="max-w-[62ch] text-[12.5px] leading-snug text-ink-3">
          For each module, say what must exist before it. Anything that already depends on a module
          is not offered as one of its prerequisites, so a circular dependency cannot be created.
        </p>
        <Button onClick={save} disabled={pending} data-testid="scope-graph-save">
          {pending ? 'Saving…' : 'Save dependencies'}
        </Button>
      </div>

      {message && (
        <p
          data-testid="scope-graph-message"
          className="rounded-[8px] border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2"
        >
          {message}
        </p>
      )}

      <ul className="rounded-[10px] border border-line bg-surface">
        {graph.cards.map((card) => {
          const prereqs = edges[card.id] ?? [];
          const candidates = candidatePrerequisiteIds(working, card.id);
          return (
            <li
              key={card.id}
              data-testid={`scope-edit-row-${card.id}`}
              className="border-b border-line-soft px-4 py-2.5 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate text-[13px] text-ink-1">{card.title}</p>
                <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-ink-4">
                  <input
                    type="checkbox"
                    checked={foundation[card.id] ?? false}
                    onChange={(e) =>
                      setFoundation((prev) => ({ ...prev, [card.id]: e.target.checked }))
                    }
                    data-testid={`scope-edit-foundation-${card.id}`}
                  />
                  Always included
                </label>
              </div>

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {prereqs.length === 0 && (
                  <span className="text-[11px] text-ink-4">No prerequisites</span>
                )}
                {prereqs.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => removeEdge(card.id, p)}
                    data-testid={`scope-edit-remove-${card.id}-${p}`}
                    className="rounded-[3px] border border-line px-1.5 py-0.5 text-[11px] text-ink-3 hover:border-red hover:text-red"
                    title="Remove this prerequisite"
                  >
                    {titleOf.get(p) ?? p} ×
                  </button>
                ))}

                {candidates.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => e.target.value && addEdge(card.id, e.target.value)}
                    data-testid={`scope-edit-add-${card.id}`}
                    className="rounded-[3px] border border-line bg-surface px-1.5 py-0.5 text-[11px] text-ink-3"
                  >
                    <option value="">+ needs…</option>
                    {candidates.map((c) => {
                      // What this one click would drag in, transitively.
                      const brings = prerequisitesOf(working, c).size;
                      return (
                        <option key={c} value={c}>
                          {titleOf.get(c) ?? c}
                          {brings > 0 ? ` (+${brings})` : ''}
                        </option>
                      );
                    })}
                  </select>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The card's foundation flag as it was loaded, to avoid a needless write. */
function initialFoundation(graph: ScopeGraphDTO, cardId: string): boolean | undefined {
  return graph.cards.find((c) => c.id === cardId)?.foundation;
}

/** Wraps the editor in a disclosure so the configurator stays the default view. */
export function ScopeGraphEditorPanel({
  estimateId,
  graph,
  scenarioCount,
}: {
  estimateId: string;
  graph: ScopeGraphDTO;
  scenarioCount: number;
}) {
  const [open, setOpen] = useState(false);
  const edgeCount = Object.values(graph.adjacency).reduce((n, deps) => n + deps.length, 0);

  return (
    <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow>Dependencies</Eyebrow>
        <Button variant="ghost" onClick={() => setOpen((o) => !o)} data-testid="scope-graph-toggle">
          {open ? 'Done' : 'Edit by hand'}
        </Button>
      </div>

      <div className="mt-1.5">
        <ScopeDerive
          estimateId={estimateId}
          edgeCount={edgeCount}
          manualCount={graph.manualEdgeCount}
          scenarioCount={scenarioCount}
        />
      </div>

      {open && (
        <div className="mt-3 border-t border-line-soft pt-3">
          <ScopeGraphEditor estimateId={estimateId} graph={graph} />
        </div>
      )}
    </div>
  );
}
