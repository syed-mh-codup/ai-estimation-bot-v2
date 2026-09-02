'use client';

import { useMemo, useState, useTransition } from 'react';
import { Eyebrow } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  candidatePrerequisitesFor,
  dependentsOf,
  prerequisitesOf,
  previewAdds as sharedPreviewAdds,
  redundantEdgesOf,
  type PresetGraph,
} from '@repo/shared';
import { addPresetDependency, removePresetDependency } from './dependency-actions';

export type GraphNodeView = { presetId: string; code: string | null; name: string; devHours: number };

export type DependencyEditorProps = {
  presetId: string;
  /** presetId -> its direct prerequisites, for the whole library. */
  adjacency: Record<string, string[]>;
  nodes: GraphNodeView[];
  /** `${dependent}->${prerequisite}` -> why. */
  notes: Record<string, string>;
};

/**
 * Rebuild the shared `PresetGraph` from the serialised props.
 *
 * The traversals themselves are imported, not reimplemented. That is the point:
 * the picker decides what to offer and the server decides what to accept, and if
 * those two walks ever disagreed the UI would cheerfully offer an edge the
 * action then rejects — the exact "validate after the fact" behaviour this
 * design exists to avoid. One implementation, proven by one set of tests.
 */
function toGraph(adjacency: Record<string, string[]>, nodes: GraphNodeView[]): PresetGraph {
  return {
    edges: new Map(Object.entries(adjacency)),
    nodes: new Map(
      nodes.map((n) => [n.presetId, { ...n, versionId: '' }]),
    ),
  };
}

/**
 * The dependency editor — AEH-242.
 *
 * The hard part of editing a graph is that a graph is not local: to add one edge
 * safely you have to know the whole thing. Four rules move that work off the
 * person and onto the screen.
 *
 *  1. You only ever answer one question, about one preset: what must exist
 *     before this? That is a question someone can answer from domain knowledge
 *     without holding the graph in their head.
 *  2. An invalid option is never offered. Everything downstream of this preset
 *     is absent from the list, so a cycle cannot be created — it is not
 *     rejected after the fact, it is unrepresentable.
 *  3. The consequence is shown at the moment of the decision. Each candidate
 *     carries what it drags in transitively, so nobody has to trace a chain
 *     mentally to find out that one click added eleven modules.
 *  4. The reverse direction is visible but read-only. What breaks if this goes
 *     is always on screen; it is edited from the other end, so there is exactly
 *     one place any given edge is owned.
 */
export function DependencyEditor({ presetId, adjacency, nodes, notes }: DependencyEditorProps) {
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.presetId, n])), [nodes]);
  const label = (id: string) => {
    const n = byId.get(id);
    return n ? `${n.code ? `${n.code} · ` : ''}${n.name}` : id;
  };

  const graph = useMemo(() => toGraph(adjacency, nodes), [adjacency, nodes]);
  const direct = adjacency[presetId] ?? [];
  const downstream = useMemo(() => dependentsOf(graph, presetId), [graph, presetId]);
  const allPrereqs = useMemo(() => prerequisitesOf(graph, presetId), [graph, presetId]);
  const indirect = [...allPrereqs].filter((id) => !direct.includes(id));

  // Rule 2: itself, what it already needs, and everything downstream are all
  // excluded, so every remaining option is a legal edge.
  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidatePrerequisitesFor(graph, presetId)
      .filter((n) => !q || n.name.toLowerCase().includes(q) || (n.code ?? '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [graph, query, presetId]);

  // Rule 3: what would this one click actually pull in? The walk is shared with
  // the estimate-scope configurator so the two cannot answer it differently.
  const previewAdds = useMemo(
    () => (preview ? sharedPreviewAdds(graph, preview, allPrereqs) : []),
    [preview, graph, allPrereqs],
  );

  const run = (fn: () => Promise<{ error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const res = await fn();
      if (res.error) setError(res.error);
      else {
        setQuery('');
        setNote('');
        setPreview(null);
      }
    });
  };

  // Rule 4's other half: an edge already implied by a longer path. Shown, never
  // removed automatically — dropping it because a path covers it today means
  // losing it silently when someone edits that path tomorrow.
  const redundant = redundantEdgesOf(graph, presetId);

  return (
    <div className="space-y-5" data-testid="dependency-editor">
      <div>
        <Eyebrow>Needs first</Eyebrow>
        <p className="mt-1 text-[11.5px] text-ink-4">
          What must be delivered before this preset. Edits apply to the active version straight away;
          superseded versions keep the edges they had.
        </p>

        {direct.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-4">Nothing yet — this preset stands on its own.</p>
        ) : (
          <ul className="mt-2 space-y-1.5" data-testid="dependency-list">
            {direct.map((id) => {
              const implied = redundant.get(id) ?? [];
              return (
                <li
                  key={id}
                  className="flex items-start justify-between gap-3 rounded border border-line-soft px-2.5 py-1.5"
                >
                  <div className="min-w-0">
                    <span className="text-[13px] text-ink-2">{label(id)}</span>
                    {notes[`${presetId}->${id}`] ? (
                      <span className="block text-[11.5px] text-ink-4">{notes[`${presetId}->${id}`]}</span>
                    ) : null}
                    {implied.length > 0 ? (
                      <span className="block text-[11.5px] text-ink-4">
                        also reached via {implied.map(label).join(', ')} — keep it if it is a real direct need
                      </span>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => run(() => removePresetDependency(presetId, id))}
                    data-testid={`dependency-remove-${id}`}
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {indirect.length > 0 ? (
          <p className="mt-2 text-[11.5px] text-ink-4">
            Also required further up the chain: {indirect.map(label).join(', ')}.
          </p>
        ) : null}
      </div>

      <div className="border-t border-line-soft pt-4">
        <Eyebrow>Add a prerequisite</Eyebrow>
        <p className="mt-1 text-[11.5px] text-ink-4">
          Only presets that can legally come first are listed — anything that depends on this one is left
          out, so a circular dependency cannot be created here.
        </p>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search presets…"
          className="mt-2"
          data-testid="dependency-search"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why, in a sentence (optional)"
          className="mt-2"
          data-testid="dependency-note"
        />

        <ul className="mt-2 space-y-1">
          {candidates.length === 0 ? (
            <li className="text-[13px] text-ink-4">No preset matches that can also come first.</li>
          ) : (
            candidates.map((n) => (
              <li key={n.presetId}>
                <button
                  type="button"
                  disabled={pending}
                  onMouseEnter={() => setPreview(n.presetId)}
                  onFocus={() => setPreview(n.presetId)}
                  onMouseLeave={() => setPreview(null)}
                  onBlur={() => setPreview(null)}
                  onClick={() => run(() => addPresetDependency(presetId, n.presetId, note))}
                  className="w-full rounded px-2.5 py-1.5 text-left text-[13px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
                  data-testid={`dependency-add-${n.presetId}`}
                >
                  {n.code ? `${n.code} · ` : ''}
                  {n.name}
                  {preview === n.presetId && previewAdds.length > 0 ? (
                    <span className="block text-[11.5px] text-ink-4">
                      brings {previewAdds.length} more with it: {previewAdds.map(label).join(', ')}
                    </span>
                  ) : null}
                </button>
              </li>
            ))
          )}
        </ul>
        {error ? (
          <p className="mt-2 text-[12px] text-[var(--color-red)]" data-testid="dependency-error">
            {error}
          </p>
        ) : null}
      </div>

      <div className="border-t border-line-soft pt-4">
        <Eyebrow>Needed by</Eyebrow>
        <p className="mt-1 text-[11.5px] text-ink-4">
          What would break if this preset were dropped. Read-only — edit these from the preset that
          declares the need, so every edge has one owner.
        </p>
        {downstream.size === 0 ? (
          <p className="mt-2 text-[13px] text-ink-4">Nothing depends on this preset.</p>
        ) : (
          <p className="mt-2 text-[13px] text-ink-2" data-testid="dependency-dependents">
            {[...downstream].map(label).join(', ')}
          </p>
        )}
      </div>
    </div>
  );
}
