'use client';

import { Eyebrow } from '@/components/ui/card';
import { JumpLink } from './JumpLink';
import { itemTaxed, round, useLedger } from './ledger-context';

/**
 * A jump list for a long document. An estimate runs to hundreds of rows; this
 * is how you get to "Back office" without scrolling past everything else, and
 * it doubles as a per-section subtotal readout.
 */
export function ContentsCard({
  hasRisk,
  openRisk,
}: {
  /** Whether the risk section renders at all — resolved findings still count. */
  hasRisk: boolean;
  /** How many still need a decision, so the row can say so without opening it. */
  openRisk: number;
}) {
  const { sectionsSorted, itemsIn, rollup } = useLedger();

  const subtotal = (sectionId: string | null) =>
    itemsIn(sectionId).reduce((s, it) => (it.enabled ? s + itemTaxed(it) : s), 0);

  const ungrouped = itemsIn(null);

  return (
    <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
      <Eyebrow>Contents</Eyebrow>
      <nav className="mt-2 flex flex-col">
        <Row to="sow" label="Statement of work" />
        <Row to="narrative" label="Narrative" />
        <Row to="assumptions" label="Assumptions" />
        {hasRisk && (
          <Row
            to="risk"
            label="Flagged risk"
            value={openRisk > 0 ? `${openRisk} open` : undefined}
          />
        )}
        <Row to="menucard" label="Menu card" value={`${round(rollup.grand)}h`} />
        {/* Each section's own anchor, not the menu card's. These rows have
            pointed at `#menucard` since this was written, which meant every
            jump below the first four landed in the same place and the list read
            as broken to anyone who tried it twice. AEH-377. */}
        {sectionsSorted.map((s) => (
          <Row
            key={s.id}
            to={`section-${s.id}`}
            label={s.title}
            value={round(subtotal(s.id))}
            sub
          />
        ))}
        {ungrouped.length > 0 && (
          <Row to="section-ungrouped" label="Ungrouped" value={round(subtotal(null))} sub />
        )}
      </nav>
    </div>
  );
}

/**
 * `JumpLink` rather than a bare anchor, because half this list points at
 * collapsible sections and a jump that lands on a closed one shows the reader
 * nothing at all. Scrolling was never the missing half. AEH-377.
 */
function Row({
  to,
  label,
  value,
  sub,
}: {
  to: string;
  label: string;
  value?: string | number;
  sub?: boolean;
}) {
  return (
    <JumpLink
      to={to}
      className={
        'flex items-baseline justify-between gap-2.5 border-b border-line-soft py-1.5 last:border-b-0 hover:text-green ' +
        (sub ? 'pl-3 text-[12px] text-ink-3' : 'text-[12.5px] text-ink-2')
      }
    >
      <span className="min-w-0 truncate">{label}</span>
      {value !== undefined && <span className="num shrink-0 text-[11px] text-ink-4">{value}</span>}
    </JumpLink>
  );
}
