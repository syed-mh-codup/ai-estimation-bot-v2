'use client';

import { useEffect, type ReactNode } from 'react';
import { FileText, PanelRight, Activity, Stethoscope, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DOCK_TABS, closeDock, openDock, toggleDock, useDock, type DockTab } from './dock';

/**
 * Where you inspect the estimate, as a panel rather than a flyout. AEH-377.
 *
 * The third region of the screen, and the one with the clearest job. The
 * document is what the estimate says; the rail is where you act on it; this is
 * everything you consult ABOUT it — what the crew produced, why a run went the
 * way it did, what an edit is doing, what it cost. All of that used to be six
 * separate things: four cards stacked at the bottom of a 280px rail, below the
 * fold and below the controls, plus two floating tabs on the right edge. The
 * rail had eleven cards in it and the two most-used surfaces were the ones not
 * in it at all.
 *
 * One dock, five tabs, one notch, and the rule that follows: the next
 * inspection panel is a tab, not a twelfth card and not a sixth thing on the
 * edge of the screen.
 *
 * It is FULL HEIGHT and it has a border rather than a shadow, which is the
 * whole difference between a dock and the flyout it replaces. A 440 by 640 box
 * floating over the ledger reads as temporary and has to be dismissed before
 * you can check the row it is about.
 *
 * It does NOT reflow the page. Reserving its width was tried and reverted: the
 * document and the rail are a grid, so taking 420px off the container reflowed
 * the ledger's columns and rewrapped the card titles underneath — the reader
 * loses their place in the thing they opened the dock to ask about. There is
 * margin to the right of the content to sit over, so it sits over it.
 *
 * `open` and `tab` live in `dock.ts` rather than here. Several of the things
 * that move them — Oracle's ⌘K, a quoted span closing the panel to reveal
 * itself, the edits notch — sit on the far side of `LedgerProvider`, which
 * remounts its subtree whenever a run finishes.
 */
export function InspectDock({
  panels,
  isAdmin,
}: {
  /**
   * The body for each tab. Server components are fine — they arrive as
   * children, already rendered. A tab whose panel is absent is not offered:
   * the admin ones do not exist for an estimator, and offering an empty tab
   * teaches people the dock has nothing in it.
   */
  panels: Partial<Record<DockTab, ReactNode>>;
  isAdmin: boolean;
}) {
  const { open, tab } = useDock();

  // Escape closes it, the way it closes every other panel on this screen.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDock();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const offered = DOCK_TABS.filter(
    (key) => panels[key] !== undefined && (key !== 'admin' || isAdmin),
  );
  if (offered.length === 0) return null;

  // A tab that is no longer offered — admin rights gone, a panel absent — must
  // not leave the dock showing nothing at all.
  const active = offered.includes(tab) ? tab : (offered[0] as DockTab);

  if (!open) {
    // ONE notch, not one per tab. A tab is a thing you pick once you are
    // inside the dock; five of them stacked on the edge of the page is five
    // pieces of furniture floating over the estimate, which is more clutter
    // than the two floating tabs this was meant to replace, not less.
    return (
      <button
        type="button"
        onClick={() => openDock(active)}
        aria-label="Open the inspect dock"
        className={cn(
          'fixed right-0 bottom-16 z-40 flex h-9 items-center gap-2 rounded-l-[10px] border border-r-0 border-line bg-surface pr-3 pl-2.5 text-ink shadow-[0_6px_24px_rgba(35,33,27,0.12)] transition-colors',
          'hover:border-green-line hover:bg-green-tint',
          'focus-visible:ring-2 focus-visible:ring-green focus-visible:outline-none',
        )}
        data-testid="inspect-notch"
      >
        <PanelRight className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
        <span className="text-[12.5px] font-medium whitespace-nowrap">Inspect</span>
      </button>
    );
  }

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-[min(420px,100vw)] flex-col border-l border-line bg-surface shadow-[-16px_0_48px_rgba(35,33,27,0.12)]"
      aria-label="Inspect"
      data-testid="inspect-dock"
    >
      <div className="flex shrink-0 items-center gap-0.5 border-b border-line bg-surface-2 px-1.5 py-1.5">
        {offered.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => toggleDock(key)}
            aria-current={key === active}
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] transition-colors',
              key === active
                ? 'bg-surface font-semibold text-ink shadow-[0_1px_2px_rgba(35,33,27,0.08)]'
                : 'text-ink-3 hover:text-ink',
            )}
            data-testid={`dock-tab-${key}`}
          >
            <TabIcon tab={key} />
            <span className="truncate">{TAB_LABEL[key]}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={closeDock}
          aria-label="Close the inspect dock"
          className="ml-auto shrink-0 rounded p-1 text-ink-3 hover:bg-surface hover:text-ink"
          data-testid="dock-close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Each panel stays MOUNTED and is hidden rather than unmounted. Oracle
          is the reason: unmounting the inactive tabs would throw away an open
          conversation every time somebody glanced at a diagnostic, which is the
          same loss the provider boundary was drawn to prevent. */}
      {offered.map((key) => (
        <div
          key={key}
          hidden={key !== active}
          className={cn('min-h-0 flex-1 overflow-y-auto', key === active && 'flex flex-col')}
          data-testid={`dock-panel-${key}`}
        >
          {panels[key]}
        </div>
      ))}
    </aside>
  );
}

const TAB_LABEL: Record<DockTab, string> = {
  oracle: 'Oracle',
  artifacts: 'Artifacts',
  diagnostics: 'Run',
  activity: 'Edits',
  admin: 'Admin',
};

function TabIcon({ tab }: { tab: DockTab }) {
  const className = 'h-3.5 w-3.5 shrink-0';
  switch (tab) {
    case 'oracle':
      return <Sparkles className={cn(className, 'text-green')} aria-hidden />;
    case 'artifacts':
      return <FileText className={className} aria-hidden />;
    case 'diagnostics':
      return <Stethoscope className={className} aria-hidden />;
    case 'activity':
      return <Activity className={className} aria-hidden />;
    case 'admin':
      return <PanelRight className={className} aria-hidden />;
  }
}
