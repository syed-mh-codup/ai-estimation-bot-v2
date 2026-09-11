'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, List } from 'lucide-react';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/menu';
import { cn } from '@/lib/utils';
import { useLedger } from './ledger-context';
import { collapseAll, expandSection } from './oracle-bus';
import { documentOutline, rowInView, type OutlineRow } from './outline';

/**
 * Where anything that pins itself BELOW this bar has to pin. AEH-377.
 *
 * The bar is `h-11` and sticks at `top-0`; the ledger's column header used to
 * stick at `top-0` too, which put the two in the same place and the header
 * behind. Exported so the number lives once — Tailwind still sees the literal
 * here, so the class is generated even though the consumer only imports it.
 */
export const BELOW_DOC_BAR = 'top-11';

/**
 * Where you are in a long document, and how to get somewhere else.
 *
 * An estimate is a page you read by scrolling, and until now the only way to
 * navigate it was a card in the rail that scrolled away with everything else —
 * so on the row that actually prompts the question, "where am I" and "take me
 * to Back office" were both a scroll back to the top. The bar stays.
 *
 * It is the document's own navigation, and that is the structural point of it:
 * the rail is where you ACT on the estimate and the drawer is where you inspect
 * it, so a control that moves you around the document belongs to the document.
 * Collapse all comes with it for the same reason — it reshapes what you are
 * reading rather than changing anything about the estimate.
 *
 * The list comes from `documentOutline`, shared with the contents card, so the
 * two cannot disagree about what the page contains or what order it is in.
 */
export function DocumentBar({
  hasMenu,
  hasRisk,
}: {
  hasMenu: boolean;
  /** Resolved findings still render the section, and it is still worth reaching. */
  hasRisk: boolean;
}) {
  const { sectionsSorted, itemsIn } = useLedger();
  const rows = documentOutline({
    sections: sectionsSorted,
    hasUngrouped: itemsIn(null).length > 0,
    hasMenu,
    hasRisk,
  });

  const here = useScrollSpy(rows);
  const [collapsed, setCollapsed] = useState(false);

  const toggleAll = () => {
    const next = !collapsed;
    setCollapsed(next);
    collapseAll(next);
  };

  return (
    <div
      className="sticky top-0 z-[4] flex h-11 items-center gap-2 border-b border-line bg-canvas"
      data-testid="document-bar"
    >
      {/* A breadcrumb, not a label. Named rather than merely highlighted in a
          list, because the question it answers is asked while looking at a row
          two thousand pixels from any list: what am I reading. And two levels
          rather than one, because inside the ledger "Back office" alone is
          ambiguous — it is the menu card's Back office, and the crumb is what
          says the ledger is what you are in. */}
      <List className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
      <nav
        className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px]"
        aria-label="Where you are"
      >
        {here?.parent && (
          <>
            <span className="shrink-0 text-ink-4">{here.parent}</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-ink-4" aria-hidden />
          </>
        )}
        <span className="min-w-0 truncate font-semibold text-ink" data-testid="document-bar-here">
          {here?.label ?? 'this estimate'}
        </span>
      </nav>

      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-ink-4 hover:text-ink focus-visible:ring-1 focus-visible:ring-green focus-visible:outline-none"
            data-testid="jump-to"
          >
            Jump to <ChevronDown className="h-3.5 w-3.5" aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="max-h-[60vh] overflow-y-auto">
          {rows.map((row) => (
            <MenuItem
              key={row.id}
              onSelect={() => jumpTo(row.id)}
              className={cn(row.section && 'pl-5 text-[12px]', here?.id === row.id && 'text-ink')}
              data-testid={`jump-to-${row.id}`}
            >
              <span className="truncate">{row.label}</span>
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>

      <button
        type="button"
        onClick={toggleAll}
        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[12px] text-ink-2 hover:border-ink-4 hover:text-ink focus-visible:ring-1 focus-visible:ring-green focus-visible:outline-none"
        data-testid="collapse-all"
      >
        {collapsed ? (
          <ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronsDownUp className="h-3.5 w-3.5" aria-hidden />
        )}
        {collapsed ? 'Expand all' : 'Collapse all'}
      </button>
    </div>
  );
}

/**
 * Open the target if it is collapsed, then go to it.
 *
 * Both halves, for the reason `JumpLink` exists: a jump that lands on a folded
 * section shows the reader nothing, which is the bug AEH-259 fixed for the
 * Oracle's quote jumps. `scrollIntoView` rather than a hash because a hash that
 * has not changed does nothing at all, and the same row gets picked twice more
 * often than you would think.
 */
function jumpTo(id: string) {
  expandSection(id);
  const go = () =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  // Once now, so the jump happens even where animation frames are not running —
  // a background tab schedules none at all, and a jump that silently does
  // nothing is worse than one that lands slightly off.
  go();
  // And again after the expand has painted: a section that was collapsed is the
  // wrong height until then, and scrolling to the wrong height is how a jump
  // lands a screen short of its target.
  requestAnimationFrame(go);
}

/**
 * Keep `rowInView` fed with the current scroll position.
 *
 * A scroll listener rather than an IntersectionObserver, deliberately: the
 * observer's answer is per-element visibility, and reducing a set of those to
 * one position needs the same geometry anyway. Collapsed sections are the case
 * that decides it — five folded sections are five headings within 200px of each
 * other, all intersecting at once.
 *
 * The decision itself lives in `outline.ts` and is pure, so it is tested there.
 * What is left here is only the plumbing.
 */
function useScrollSpy(rows: OutlineRow[]): OutlineRow | null {
  const [hereId, setHereId] = useState<string | null>(null);
  // The ids as one string, so the effect re-runs when the outline actually
  // changes rather than on every render that rebuilds the array.
  const key = rows.map((r) => r.id).join('|');

  useEffect(() => {
    const ids = key.split('|').filter(Boolean);
    if (ids.length === 0) return;

    const stubs: OutlineRow[] = ids.map((id) => ({ id, label: '' }));
    let queued = false;
    const read = () => {
      queued = false;
      const here = rowInView(
        stubs,
        (id) => document.getElementById(id)?.getBoundingClientRect().top ?? null,
        // The bar is 44px tall; a heading level with its underside is here.
        56,
      );
      setHereId(here?.id ?? null);
    };

    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(read);
    };

    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [key]);

  return rows.find((r) => r.id === hereId) ?? null;
}
