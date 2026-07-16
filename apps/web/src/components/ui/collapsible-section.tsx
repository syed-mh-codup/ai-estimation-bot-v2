'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A collapsible/accordion section. Accepts server-rendered `children` (a client
 * wrapper around RSC children is fine) so it can wrap the estimate's SOW /
 * narrative / assumptions / menu-card sections without making them client
 * components. Open/closed state persists in localStorage when `storageKey` is
 * given.
 */
export function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
  storageKey,
  right,
  className,
  headingClassName,
  'data-testid': testId,
}: {
  title: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  /** Optional controls rendered on the right of the header (won't toggle collapse). */
  right?: ReactNode;
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
    <section className={className} data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className={cn(
            'flex flex-1 items-center gap-1.5 text-left text-sm font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700',
            headingClassName,
          )}
          data-testid={testId ? `${testId}-toggle` : undefined}
        >
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-90')}
            aria-hidden
          />
          {title}
        </button>
        {right}
      </div>
      {open && <div className="mt-2">{children}</div>}
    </section>
  );
}
