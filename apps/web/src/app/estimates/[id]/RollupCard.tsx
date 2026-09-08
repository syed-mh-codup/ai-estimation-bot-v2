'use client';

import { useState } from 'react';
import {
  HOUSE_FIELD,
  isTaxableRole,
  isValidBufferPct,
  MAX_BUFFER_PCT,
  MIN_BUFFER_PCT,
  OVERRIDE_FIELD,
  type TaxableRole,
} from '@repo/shared';
import { Eyebrow } from '@/components/ui/card';
import { ROLES, round, useLedger } from './ledger-context';

/** What each role's buffer is called in the estimate's own language. */
const BUFFER_NOUN: Record<TaxableRole, string> = {
  QA: 'regression',
  PM: 'comms',
  BA: 'comms',
};

/**
 * One role's buffer, editable in place.
 *
 * Committed on blur and on Enter rather than on every keystroke: each commit
 * re-taxes that role's line items and writes a provenance row, so reacting to
 * every digit would record "2", "25", "250" on the way to 25.
 *
 * Clearing the field means "go back to the house default", which is why the
 * empty string is checked BEFORE any numeric coercion — `Number('')` is 0, not
 * NaN, so a cleared box run through `Number()` would silently pin a 0% buffer
 * on the estimate instead of releasing it.
 */
function BufferField({ role }: { role: TaxableRole }) {
  const { taxPercents, houseRates, overrides, taxChanges, onEditTaxPct, isFinalised } = useLedger();
  const effective = taxPercents[role];
  const override = overrides[OVERRIDE_FIELD[role]];
  const house = houseRates ? houseRates[HOUSE_FIELD[role]] : 0;
  const isOverridden = override !== null;

  // Keyed on the effective figure so a server reconciliation, a reset, or a
  // rejected edit all pull the box back to the truth instead of stranding a
  // draft the estimate does not have.
  const [draft, setDraft] = useState<string>(String(effective));
  const [key, setKey] = useState<number>(effective);
  if (key !== effective) {
    setKey(effective);
    setDraft(String(effective));
  }

  const commit = () => {
    const raw = draft.trim();
    if (raw === '') {
      if (isOverridden) onEditTaxPct(role, null);
      else setDraft(String(effective));
      return;
    }
    const next = Number(raw);
    if (!isValidBufferPct(next)) {
      setDraft(String(effective));
      return;
    }
    if (next !== effective || !isOverridden) onEditTaxPct(role, next);
  };

  const note = taxChanges[role];
  const title = note
    ? `${role} buffer set to ${note.toPct === null ? 'the house default' : `${note.toPct}%`}` +
      ` from ${note.fromPct === null ? 'the house default' : `${note.fromPct}%`}` +
      ` · ${note.atLabel}${note.by ? ` · ${note.by}` : ''}`
    : `Inheriting the house default of ${house}%`;

  if (isFinalised) {
    return (
      <span className="text-[10.5px] text-ink-4" title={title}>
        {effective > 0 ? `+${effective}% ${BUFFER_NOUN[role]}` : 'no buffer'}
        {isOverridden && <span className="ml-1 text-bronze-ink">·&nbsp;set here</span>}
      </span>
    );
  }

  return (
    <span className="flex items-baseline gap-1 text-[10.5px] text-ink-4">
      <span aria-hidden>+</span>
      <input
        type="number"
        min={MIN_BUFFER_PCT}
        max={MAX_BUFFER_PCT}
        step={1}
        value={draft}
        aria-label={`${role} buffer percent`}
        title={title}
        data-testid={`buffer-${role}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setDraft(String(effective));
            e.currentTarget.blur();
          }
        }}
        className={`num w-[34px] rounded-[4px] border bg-transparent px-1 py-px text-right text-[10.5px] tabular-nums outline-none focus:border-green ${
          isOverridden ? 'border-bronze-line text-bronze-ink' : 'border-line-soft text-ink-4'
        }`}
      />
      <span aria-hidden>% {BUFFER_NOUN[role]}</span>
      {isOverridden && (
        <button
          type="button"
          onClick={() => onEditTaxPct(role, null)}
          title={`Go back to the house default of ${house}%`}
          data-testid={`buffer-reset-${role}`}
          className="text-[10.5px] text-ink-4 underline decoration-dotted hover:text-ink-2"
        >
          reset
        </button>
      )}
    </span>
  );
}

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
  const { rollup, taxPercents, sections, overheadStale } = useLedger();
  const { totals, grand, excluded, itemsOn, itemsOff, lineItemCount, inferred, inferredOn } =
    rollup;

  const share = (v: number) => (grand > 0 ? Math.round((v / grand) * 100) : 0);

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
          {isTaxableRole(r) ? (
            <BufferField role={r} />
          ) : (
            /* DEV carries no communication tax by construction — the
               complexity multiplier is already applied to it upstream, so a
               buffer on top would charge for the same uncertainty twice. */
            <span className="text-[10.5px] text-ink-4" title="DEV is untaxed: the complexity multiplier is already applied">
              {taxPercents[r] > 0 ? `+${taxPercents[r]}% buffer` : 'no buffer'}
            </span>
          )}
          <span>
            <span className="num text-[13px] font-medium text-ink" data-testid={`total-${r}`}>
              {round(totals[r])}
            </span>
            <span className="num ml-1.5 text-[10.5px] text-ink-4">{share(totals[r])}%</span>
          </span>
        </div>
      ))}

      {/* A buffer moved after the delivery-overhead cards were generated, so
          those cards are a percentage of hours that have since changed. Said
          rather than fixed: nothing on an overhead card distinguishes a
          generated figure from an estimator's edit, so regenerating them would
          discard real decisions and bring back cards somebody deleted on
          purpose. A re-run rebuilds them at the current rates. AEH-335. */}
      {overheadStale && (
        <div
          className="mt-2.5 border-t border-dashed border-line pt-2.5 text-[10.5px] text-bronze-ink"
          data-testid="rollup-overhead-stale"
        >
          Delivery overhead was costed at earlier buffers. Re-run to rebuild those cards.
        </div>
      )}

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
        <div
          data-testid="rollup-excluded"
          className="mt-2.5 flex justify-between gap-2 border-t border-dashed border-line pt-2.5 text-[11.5px] text-ink-3"
        >
          <span>
            <span className="num">{itemsOff}</span> item{itemsOff === 1 ? '' : 's'} switched off
          </span>
          <span className="num">{round(excluded)}h</span>
        </div>
      )}
    </div>
  );
}
