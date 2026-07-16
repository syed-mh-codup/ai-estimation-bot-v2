'use client';

import { Eyebrow } from '@/components/ui/card';
import { itemTaxed, round, useLedger } from './ledger-context';

/**
 * A jump list for a long document. An estimate runs to hundreds of rows; this
 * is how you get to "Back office" without scrolling past everything else, and
 * it doubles as a per-section subtotal readout.
 */
export function ContentsCard() {
  const { sectionsSorted, itemsIn, rollup } = useLedger();

  const subtotal = (sectionId: string | null) =>
    itemsIn(sectionId).reduce((s, it) => (it.enabled ? s + itemTaxed(it) : s), 0);

  const ungrouped = itemsIn(null);

  return (
    <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
      <Eyebrow>Contents</Eyebrow>
      <nav className="mt-2 flex flex-col">
        <Row href="#sow" label="Statement of work" />
        <Row href="#narrative" label="Narrative" />
        <Row href="#assumptions" label="Assumptions" />
        <Row href="#menucard" label="Menu card" value={`${round(rollup.grand)}h`} />
        {sectionsSorted.map((s) => (
          <Row key={s.id} href="#menucard" label={s.title} value={round(subtotal(s.id))} sub />
        ))}
        {ungrouped.length > 0 && (
          <Row href="#menucard" label="Ungrouped" value={round(subtotal(null))} sub />
        )}
      </nav>
    </div>
  );
}

function Row({
  href,
  label,
  value,
  sub,
}: {
  href: string;
  label: string;
  value?: string | number;
  sub?: boolean;
}) {
  return (
    <a
      href={href}
      className={
        'flex items-baseline justify-between gap-2.5 border-b border-line-soft py-1.5 last:border-b-0 hover:text-green ' +
        (sub ? 'pl-3 text-[12px] text-ink-3' : 'text-[12.5px] text-ink-2')
      }
    >
      <span className="min-w-0 truncate">{label}</span>
      {value !== undefined && <span className="num shrink-0 text-[11px] text-ink-4">{value}</span>}
    </a>
  );
}
