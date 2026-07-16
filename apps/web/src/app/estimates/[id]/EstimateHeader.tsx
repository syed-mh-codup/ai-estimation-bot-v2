'use client';

import { useState, useTransition } from 'react';
import { renameEstimate, setComplexityScore } from './actions';

/**
 * Inline-editable estimate title + complexity score in the detail header.
 * Optimistic: edits apply immediately and persist on blur/change; a failed save
 * reverts and surfaces a small error.
 */
export function EstimateHeader({
  estimateId,
  initialTitle,
  status,
  initialComplexity,
  isFinalised,
}: {
  estimateId: string;
  initialTitle: string;
  status: string;
  initialComplexity: number | null;
  isFinalised: boolean;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [draft, setDraft] = useState(initialTitle);
  const [complexity, setComplexity] = useState<number | null>(initialComplexity);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const commitTitle = () => {
    const next = draft.trim();
    if (!next || next === title) {
      setDraft(title);
      return;
    }
    const prev = title;
    setTitle(next);
    startTransition(async () => {
      try {
        await renameEstimate(estimateId, next);
      } catch (e) {
        setTitle(prev);
        setDraft(prev);
        setError(e instanceof Error ? e.message : 'Could not rename');
      }
    });
  };

  const commitComplexity = (value: number | null) => {
    const prev = complexity;
    setComplexity(value);
    startTransition(async () => {
      try {
        await setComplexityScore(estimateId, value);
      } catch (e) {
        setComplexity(prev);
        setError(e instanceof Error ? e.message : 'Could not update complexity');
      }
    });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        {isFinalised ? (
          <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setDraft(title);
                (e.target as HTMLInputElement).blur();
              }
            }}
            aria-label="Estimate title"
            className="-ml-1 rounded-md border border-transparent px-1 text-2xl font-semibold text-gray-900 hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none"
            data-testid="estimate-title-input"
          />
        )}
        <span
          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"
          data-testid="estimate-status"
        >
          {status}
        </span>

        {/* Complexity */}
        {isFinalised ? (
          complexity != null && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              complexity {complexity}/5
            </span>
          )
        ) : (
          <label className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-800">
            complexity
            <select
              value={complexity ?? ''}
              onChange={(e) => commitComplexity(e.target.value === '' ? null : Number(e.target.value))}
              className="rounded border border-amber-200 bg-white px-1 py-0.5 text-xs text-amber-900 focus:outline-none"
              data-testid="complexity-select"
            >
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}/5
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {error && (
        <p className="mt-1 text-xs font-medium text-red-600" data-testid="estimate-header-error">
          {error}
        </p>
      )}
    </div>
  );
}
