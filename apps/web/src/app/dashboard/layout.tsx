import type React from 'react';
import { Nav } from '@/components/nav';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50">
      <Nav />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
