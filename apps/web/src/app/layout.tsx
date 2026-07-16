import type React from 'react';
import type { Metadata } from 'next';
import localFont from 'next/font/local';
import './globals.css';

/**
 * Three faces, three jobs (see globals.css):
 *   Newsreader     — editorial serif: titles, section headings, the grand total
 *   Hanken Grotesk — humanist sans: all UI text
 *   IBM Plex Mono  — every number, so hour columns align like a statement
 *
 * Self-hosted from src/fonts rather than next/font/google on purpose: the
 * Google fetch happens at build time, and when it fails it does NOT fail the
 * build — it silently swaps in system fallbacks, which quietly destroys the
 * tabular alignment the whole ledger depends on. These are OFL-licensed,
 * latin-subset woff2 (~220KB total).
 */
const newsreader = localFont({
  src: '../fonts/newsreader-var.woff2',
  weight: '400 600',
  style: 'normal',
  variable: '--font-newsreader',
  display: 'swap',
});

const hanken = localFont({
  src: '../fonts/hanken-grotesk-var.woff2',
  weight: '400 700',
  style: 'normal',
  variable: '--font-hanken',
  display: 'swap',
});

const plexMono = localFont({
  src: [
    { path: '../fonts/plex-mono-400.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/plex-mono-500.woff2', weight: '500', style: 'normal' },
    { path: '../fonts/plex-mono-600.woff2', weight: '600', style: 'normal' },
  ],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Estimation — Codup',
  description: 'AI-powered project estimation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${hanken.variable} ${plexMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
