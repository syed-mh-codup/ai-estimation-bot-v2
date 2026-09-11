'use client';

import { Eyebrow } from '@/components/ui/card';
import { JumpLink } from './JumpLink';
import { itemTaxed, round, useLedger } from './ledger-context';
import { documentOutline } from './outline';

/**
 * The document's parts with a subtotal against each.
 *
 * It was the only navigation on the screen and it is not any more — the
 * document bar carries that, pinned, where the question is actually asked. What
 * this keeps is the half a pinned bar cannot do: the whole shape at once, with
 * the hours beside each part, which is a rail thing because it is a number you
 * are accountable for rather than a way of moving around.
 *
 * Both read `documentOutline`, so the two lists cannot disagree about what the
 * page contains. AEH-377.
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

  const rows = documentOutline({
    sections: sectionsSorted,
    hasUngrouped: itemsIn(null).length > 0,
    // This card only renders once there is a menu card, so the ledger's rows
    // always belong in the list.
    hasMenu: true,
    hasRisk,
  });

  const valueFor = (id: string, section?: { id: string | null }) => {
    if (section) return round(subtotal(section.id));
    if (id === 'menucard') return `${round(rollup.grand)}h`;
    if (id === 'risk') return openRisk > 0 ? `${openRisk} open` : undefined;
    return undefined;
  };

  return (
    <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
      <Eyebrow>Contents</Eyebrow>
      <nav className="mt-2 flex flex-col">
        {rows.map((row) => (
          <JumpLink
            key={row.id}
            to={row.id}
            className={
              'flex items-baseline justify-between gap-2.5 border-b border-line-soft py-1.5 last:border-b-0 hover:text-green ' +
              (row.section ? 'pl-3 text-[12px] text-ink-3' : 'text-[12.5px] text-ink-2')
            }
          >
            <span className="min-w-0 truncate">{row.label}</span>
            {valueFor(row.id, row.section) !== undefined && (
              <span className="num shrink-0 text-[11px] text-ink-4">
                {valueFor(row.id, row.section)}
              </span>
            )}
          </JumpLink>
        ))}
      </nav>
    </div>
  );
}
