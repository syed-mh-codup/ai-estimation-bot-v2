import type React from 'react';
import { Nav } from '@/components/nav';
import { cn } from '@/lib/utils';

/**
 * One shell for every signed-in route. `wide` gives the estimate detail room
 * for its document column plus the sticky ledger rail; everything else stays
 * at a readable measure.
 */
export function AppShell({
  children,
  wide = false,
}: {
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-canvas md:flex-row">
      <Nav />
      <main className="min-w-0 flex-1 px-4 py-5 md:px-8 md:py-7">
        <div className={cn('mx-auto', wide ? 'max-w-[1180px]' : 'max-w-4xl')}>{children}</div>
      </main>
    </div>
  );
}
