'use client';

import { Eyebrow } from '@/components/ui/card';
import { ROLES, round, useLedger } from './ledger-context';

/**
 * The roll-up: a hero number plus stat rows, deliberately not a chart.
 *
 * The four roles are *categorical*, so shading them across one hue would
 * misencode them as ordered magnitudes, and a genuine four-hue categorical
 * palette would fight the single-accent language everywhere else. Proportion is
 * carried as text instead — a percentage reads exactly, a wedge only roughly.
 *
 * It lives in the sticky rail so the number you are accountable for never
 * scrolls away from the rows you are editing.
 */
export function RollupCard() {
  const { rollup, taxPercents, sections } = useLedger();
  const { totals, grand, excluded, itemsOn, itemsOff, lineItemCount, inferred, inferredOn } =
    rollup;

  const share = (v: number) => (grand > 0 ? Math.round((v / grand) * 100) : 0);

  const buffers: Record<string, string> = {
    DEV: taxPercents.DEV > 0 ? `+${taxPercents.DEV}% buffer` : 'no buffer',
    QA: taxPercents.QA > 0 ? `+${taxPercents.QA}% regression` : 'no buffer',
    PM: taxPercents.PM > 0 ? `+${taxPercents.PM}% comms` : 'no buffer',
    BA: taxPercents.BA > 0 ? `+${taxPercents.BA}% comms` : 'no buffer',
  };

  return (
    <div className="rounded-[10px] border border-line bg-surface px-4 py-4" data-testid="rollup-totals">
      <Eyebrow>Total estimate</Eyebrow>

      <div className="mt-1.5 font-serif text-[42px] leading-none tracking-[-0.02em] text-green tabular-nums">
        <span data-testid="total-all">{round(grand)}</span>
        <span className="text-[21px] text-green-line">h</span>
      </div>

      <div className="mt-1.5 text-[11.5px] text-ink-3">
        <span className="num">{itemsOn}</span> item{itemsOn === 1 ? '' : 's'} on ·{' '}
        <span className="num">{sections.length}</span> section{sections.length === 1 ? '' : 's'} ·{' '}
        <span className="num">{lineItemCount}</span> line item{lineItemCount === 1 ? '' : 's'}
      </div>

      <div className="mt-3 h-px bg-line" />

      {ROLES.map((r) => (
        <div
          key={r}
          className="grid grid-cols-[34px_1fr_auto] items-baseline gap-2 border-b border-line-soft py-1.5 last:border-b-0"
        >
          <span className="num text-[11.5px] font-semibold text-ink-2">{r}</span>
          <span className="text-[10.5px] text-ink-4">{buffers[r]}</span>
          <span>
            <span className="num text-[13px] font-medium text-ink" data-testid={`total-${r}`}>
              {round(totals[r])}
            </span>
            <span className="num ml-1.5 text-[10.5px] text-ink-4">{share(totals[r])}%</span>
          </span>
        </div>
      ))}

      {/* The split the whole hidden-work feature exists to make visible. Both
          figures are in the headline above — these hours are as real and as
          taxed as any other. But a client reading one number deserves to know
          how much of it they never wrote down, and an estimator about to defend
          the total needs that figure by itself. Same disclosure pattern as
          switched-off work below, because it answers the same kind of question
          about the same headline number. AEH-263. */}
      {inferredOn > 0 && (
        <div
          className="mt-2.5 border-t border-dashed border-line pt-2.5 text-[11.5px]"
          data-testid="rollup-inferred"
        >
          <div className="flex justify-between gap-2 text-ink-3">
            <span>asked for</span>
            <span className="num">{round(grand - inferred)}h</span>
          </div>
          <div className="mt-1 flex justify-between gap-2 text-bronze-ink">
            <span>
              inferred ·{' '}
              <span className="num">{inferredOn}</span> item{inferredOn === 1 ? '' : 's'}
            </span>
            <span className="num" data-testid="total-inferred">
              {round(inferred)}h
            </span>
          </div>
        </div>
      )}

      {/* Switched-off work is still priced. Saying so stops the total reading
          like the whole scope. */}
      {itemsOff > 0 && (
        <div className="mt-2.5 flex justify-between gap-2 border-t border-dashed border-line pt-2.5 text-[11.5px] text-ink-3">
          <span>
            <span className="num">{itemsOff}</span> item{itemsOff === 1 ? '' : 's'} switched off
          </span>
          <span className="num">{round(excluded)}h</span>
        </div>
      )}
    </div>
  );
}
