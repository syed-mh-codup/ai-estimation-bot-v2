import type React from 'react';
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Estimation',
  description: 'AI-powered project estimation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
