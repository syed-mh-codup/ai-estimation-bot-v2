'use client';

import { useState, useTransition } from 'react';
import { Pill, STATUS_TONE } from '@/components/ui/pill';
import { renameEstimate, setComplexityScore } from './actions';

/**
 * The estimate's masthead: an inline-editable title and its status. Optimistic —
 * the edit applies immediately and persists on blur; a failed save reverts and
 * surfaces the reason. Complexity lives in the rail with the rest of the
 * metadata, as <ComplexityField> below.
 */
export function EstimateHeader({
  estimateId,
  initialTitle,
  status,
  isFinalised,
}: {
  estimateId: string;
  initialTitle: string;
  status: string;
  isFinalised: boolean;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [draft, setDraft] = useState(initialTitle);
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

  return (
    <div>
      <div className="flex flex-wrap items-start gap-3.5">
        {isFinalised ? (
          <h1 className="min-w-0 flex-1 font-serif text-[33px] leading-[1.15] font-medium tracking-[-0.015em] text-ink">
            {title}
          </h1>
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
            className="-ml-2 min-w-[260px] flex-1 rounded-md border border-transparent bg-transparent px-2 font-serif text-[33px] leading-[1.15] font-medium tracking-[-0.015em] text-ink hover:border-line focus:border-green focus:bg-surface focus:outline-none"
            data-testid="estimate-title-input"
          />
        )}

        {/* `estimate-status` is asserted with toHaveText — the pill's dot is an
            empty element, so its textContent stays exactly the status word. */}
        <span className="mt-1.5 shrink-0">
          <Pill tone={STATUS_TONE[status] ?? 'neutral'} data-testid="estimate-status">
            {status}
          </Pill>
        </span>
      </div>

      {error && (
        <p className="mt-1 text-xs font-medium text-brick" data-testid="estimate-header-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** The complexity control, shown in the rail beside the rest of the metadata. */
export function ComplexityField({
  estimateId,
  initialComplexity,
  isFinalised,
}: {
  estimateId: string;
  initialComplexity: number | null;
  isFinalised: boolean;
}) {
  const [complexity, setComplexity] = useState<number | null>(initialComplexity);
  const [, startTransition] = useTransition();

  const commit = (value: number | null) => {
    const prev = complexity;
    setComplexity(value);
    startTransition(async () => {
      try {
        await setComplexityScore(estimateId, value);
      } catch {
        setComplexity(prev);
      }
    });
  };

  if (isFinalised) {
    return <span className="num">{complexity != null ? `${complexity}/5` : '—'}</span>;
  }

  return (
    <select
      value={complexity ?? ''}
      onChange={(e) => commit(e.target.value === '' ? null : Number(e.target.value))}
      aria-label="Complexity score"
      className="num rounded border border-line bg-surface px-1 py-0.5 text-[11.5px] text-ink focus:border-green focus:outline-none"
      data-testid="complexity-select"
    >
      <option value="">—</option>
      {[1, 2, 3, 4, 5].map((n) => (
        <option key={n} value={n}>
          {n}/5
        </option>
      ))}
    </select>
  );
}
