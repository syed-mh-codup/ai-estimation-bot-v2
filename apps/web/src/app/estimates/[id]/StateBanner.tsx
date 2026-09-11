'use client';

import { Check } from 'lucide-react';
import { round, useLedger } from './ledger-context';
import { JumpLink } from './JumpLink';

/**
 * What just happened to this estimate, and what follows from it. AEH-377.
 *
 * The screen means something different after a run than after a reconcile than
 * on a fork, and until now it said so only by rearranging itself. This is the
 * sentence: what the crew produced, the figure worth arguing about, and the one
 * or two things to do next.
 *
 * It is NOT a product tour, and that distinction is the whole design. A tour
 * teaches the layout, which changes — six tickets touched this screen in a
 * fortnight — so it becomes a parallel description of the UI that rots quietly.
 * This renders from the same state the ledger renders from, so it cannot drift;
 * it is about THIS estimate rather than the general case; and it is still worth
 * reading on somebody's four-hundredth estimate, which is the test a tour
 * fails. What a walkthrough is genuinely for is the notation, which is stable —
 * that is slice 9, and it is a different thing.
 *
 * Only the settled case lives here. A run in flight or a failed one is the
 * event, and `RunControls` gives it the full crew track it deserves; this
 * replaces only the quiet one-line "the crew drafted this" that panel collapses
 * to once there is a menu card, because that line said what happened and
 * nothing about what it means.
 */
export function StateBanner({
  openRisk,
  elapsed,
  onRerun,
}: {
  /** Findings still needing a decision — the gate on finalising. */
  openRisk: number;
  /** How long the run took, already formatted, or null if it was not recorded. */
  elapsed: string | null;
  /** The control this replaces still has to be reachable. */
  onRerun: React.ReactNode;
}) {
  const { rollup, setActiveMark, isFinalised } = useLedger();
  const { grand, itemsOn, inferred, inferredOn } = rollup;

  return (
    <section
      className="flex items-start gap-3 rounded-[10px] border border-green-line bg-green-tint px-4 py-3.5"
      data-testid="state-banner"
    >
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-green" strokeWidth={3} aria-hidden />

      <div className="min-w-0 flex-1">
        <h2 className="text-[13.5px] font-semibold text-green-deep">
          The crew costed this brief at <span className="num">{round(grand)}h</span> across{' '}
          <span className="num">{itemsOn}</span> card{itemsOn === 1 ? '' : 's'}
          {elapsed ? (
            <span className="font-normal text-green">
              {', in '}
              <span className="num">{elapsed}</span>
            </span>
          ) : null}
          .
        </h2>

        {/* Both sentences are conditional, and the banner keeps its shape with
            neither: a clean estimate says so by having nothing to add.
            Finalising is only GATED on open findings when the active config
            says so, so a finalised estimate can still carry undecided ones —
            and the panel below is read-only once it is. Telling somebody to
            decide what they can no longer decide is worse than saying nothing,
            so the wording turns to the record it has become. */}
        {(openRisk > 0 || inferredOn > 0) && (
          <p className="mt-1 max-w-[76ch] text-[12.5px] leading-relaxed text-green">
            {openRisk > 0 && (
              <>
                <span className="num">{openRisk}</span> risk{openRisk === 1 ? '' : 's'}{' '}
                {isFinalised
                  ? `${openRisk === 1 ? 'was' : 'were'} left undecided when this was finalised.`
                  : `need${openRisk === 1 ? 's' : ''} a decision before you can finalise.`}{' '}
              </>
            )}
            {inferredOn > 0 && (
              <>
                <span className="num">{inferredOn}</span> card{inferredOn === 1 ? '' : 's'}{' '}
                {inferredOn === 1 ? 'is' : 'are'} work the brief never asked for, worth{' '}
                <span className="num">{round(inferred)}h</span>.
              </>
            )}
          </p>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {openRisk > 0 && (
            <JumpLink
              to="risk"
              className="inline-flex h-7 items-center rounded-md border border-green bg-green px-2.5 text-[12px] font-semibold text-surface hover:bg-green-deep hover:text-surface"
              data-testid="banner-goto-risk"
            >
              {isFinalised ? 'See' : 'Decide'} the {openRisk} risk{openRisk === 1 ? '' : 's'}
            </JumpLink>
          )}
          {inferredOn > 0 && (
            <button
              type="button"
              onClick={() => setActiveMark('inferred')}
              className="inline-flex h-7 items-center rounded-md border border-green-line bg-surface px-2.5 text-[12px] font-semibold text-green hover:border-green"
              data-testid="banner-show-inferred"
            >
              Show what was inferred
            </button>
          )}
          {onRerun}
        </div>
      </div>
    </section>
  );
}
