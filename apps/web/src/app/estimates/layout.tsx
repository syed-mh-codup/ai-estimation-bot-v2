import type React from 'react';
import { AppShell } from '@/components/app-shell';

/** The estimate detail carries a document column plus a sticky ledger rail. */
export default function EstimatesLayout({ children }: { children: React.ReactNode }) {
  return <AppShell wide>{children}</AppShell>;
}
