'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A rail link. The current section lifts onto the paper colour rather than
 * shouting in an accent — the accent is reserved for settled quantities.
 */
export function NavLink({
  href,
  children,
  testId,
}: {
  href: string;
  children: ReactNode;
  testId?: string;
}) {
  const pathname = usePathname();
  // /dashboard owns the estimates list; /estimates/[id] lives under it too.
  const active =
    href === '/dashboard'
      ? pathname === '/dashboard' || /^\/estimates\/(?!new)/.test(pathname)
      : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      data-testid={testId}
      className={cn(
        'flex items-center justify-between gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-[13.5px] transition-colors',
        active
          ? 'bg-surface font-semibold text-ink shadow-[0_1px_0_rgba(35,33,27,0.05)]'
          : 'text-ink-2 hover:bg-line hover:text-ink',
      )}
    >
      {children}
    </Link>
  );
}
