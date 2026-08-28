'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A collapsible panel of the document. Accepts server-rendered `children` (a
 * client wrapper around RSC children is fine) so it can wrap the estimate's
 * SOW / narrative / assumptions without making them client components.
 * Open/closed state persists in localStorage when `storageKey` is given.
 */
export function CollapsibleSection({
  id,
  title,
  children,
  defaultOpen = true,
  storageKey,
  right,
  meta,
  className,
  headingClassName,
  'data-testid': testId,
}: {
  /**
   * Anchor for in-page links. ContentsCard has linked to #sow, #narrative and
   * #assumptions since it was written, and none of them ever resolved: this
   * component took no id and does not spread rest props, so only the menu card
   * (which sets its own id) was reachable. Oracle's quote jump needs #sow to
   * exist, which is what finally surfaced it. AEH-259.
   */
  id?: string;
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  /** Optional controls rendered on the right of the header (won't toggle collapse). */
  right?: ReactNode;
  /** Quiet context shown beside the title — e.g. "written by the Architect". */
  meta?: ReactNode;
  className?: string;
  headingClassName?: string;
  'data-testid'?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Read persisted state after mount to avoid an SSR/CSR hydration mismatch.
  useEffect(() => {
    if (!storageKey) return;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored != null) setOpen(stored === '1');
    } catch {
      /* localStorage unavailable — keep default */
    }
  }, [storageKey]);

  // Respond to the page-level "collapse/expand all" control.
  useEffect(() => {
    const onAll = (e: Event) => {
      const collapsed = (e as CustomEvent<{ collapsed: boolean }>).detail?.collapsed;
      const next = !collapsed;
      setOpen(next);
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? '1' : '0');
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener('estimate:collapse-all', onAll);
    return () => window.removeEventListener('estimate:collapse-all', onAll);
  }, [storageKey]);

  // A deep link or a quote jump must be able to reveal this section — landing
  // on a collapsed block and highlighting something inside it shows the reader
  // nothing at all.
  useEffect(() => {
    if (!id) return;
    const onExpand = (e: Event) => {
      if ((e as CustomEvent<{ id: string }>).detail?.id !== id) return;
      setOpen(true);
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, '1');
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener('estimate:expand-section', onExpand);
    return () => window.removeEventListener('estimate:expand-section', onExpand);
  }, [id, storageKey]);

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      if (storageKey) {
        try {
          window.localStorage.setItem(storageKey, next ? '1' : '0');
        } catch {
          /* ignore */
        }
      }
      return next;
    });
  }

  return (
    <section
      id={id}
      className={cn('rounded-[10px] border border-line bg-surface', className)}
      data-testid={testId}
    >
      <div className="flex items-center gap-2.5 px-4 py-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            'flex flex-1 items-center gap-2.5 text-left font-serif text-[17.5px] font-medium text-ink',
            headingClassName,
          )}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-ink-4 transition-transform',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          {title}
        </button>
        {meta && <span className="text-[11.5px] text-ink-3">{meta}</span>}
        {right}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}
