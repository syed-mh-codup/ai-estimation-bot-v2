'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLedger } from './ledger-context';
import { MARK_KEYS, MARK_LABEL, MARK_STORY } from './marks';
import { NotationSheet } from './NotationSheet';

/**
 * What is unusual about this estimate, above the ledger it describes. AEH-377.
 *
 * This replaces the legend that was never built, and it is deliberately not
 * one. A legend answers "what does this symbol mean" — a question you only ask
 * once, and which the marks themselves now answer where you meet them. The
 * question an estimator asks on every estimate is the other one: what is odd
 * about THIS one. Three inferred cards and seven with no historical match is
 * the shape of a number you are about to defend, and it is legible here before
 * anybody clicks anything.
 *
 * Only marks that something actually carries appear. A chip reading zero on
 * every estimate that has never moved a buffer is noise, and noise in a summary
 * row teaches people to stop reading the row.
 *
 * The reference sheet hangs off the end of the row, demoted to a link on
 * purpose — the marks now explain themselves where you meet them, so the whole
 * vocabulary at once is for reading up rather than looking up. It stays there
 * on an estimate carrying no marks at all, because the rest of the notation —
 * the buffers, the dash, the padlocks — applies to every estimate there is.
 */
export function MarkFilter() {
  const { markCounts, activeMark, setActiveMark } = useLedger();

  const present = MARK_KEYS.filter((key) => markCounts[key] !== undefined);

  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-dashed border-line pb-2.5"
      data-testid="mark-filter"
    >
      {present.length > 0 && (
        <span className="mr-0.5 shrink-0 text-[11.5px] text-ink-4">In this estimate</span>
      )}

      {present.map((key) => {
        const on = activeMark === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => setActiveMark(key)}
            aria-pressed={on}
            title={MARK_STORY[key]}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors',
              on
                ? 'border-green bg-green-tint font-semibold text-green'
                : 'border-line bg-surface text-ink-2 hover:border-ink-4 hover:text-ink',
            )}
            data-testid={`mark-chip-${key}`}
            data-on={on}
          >
            {MARK_LABEL[key]}
            <span className={cn('num text-[11px]', on ? 'text-green' : 'text-ink-4')}>
              {markCounts[key]}
            </span>
          </button>
        );
      })}

      {activeMark !== null && (
        <button
          type="button"
          onClick={() => setActiveMark(null)}
          className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ink-4 hover:text-ink-2"
          data-testid="mark-filter-clear"
        >
          <X className="h-3 w-3" aria-hidden /> Show all
        </button>
      )}

      {/* Pushed to the far end of the row: it is the least urgent thing here
          and has to stay out of the way of the chips, which are about this
          estimate rather than about the notation. */}
      <span className="ml-auto shrink-0">
        <NotationSheet />
      </span>
    </div>
  );
}
