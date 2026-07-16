import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A status pill. Colour never travels alone here — every pill carries its
 * label, so state survives colourblindness, greyscale printing and screenshots.
 *
 * The tones map to the palette's three jobs: green settles, bronze is in
 * flight, brick failed, neutral is inert.
 */
export type PillTone = 'neutral' | 'green' | 'bronze' | 'brick';

const TONES: Record<PillTone, string> = {
  neutral: 'bg-surface-2 text-ink-3 border-line',
  green: 'bg-green-tint text-green border-green-line',
  bronze: 'bg-bronze-tint text-bronze-ink border-bronze-line',
  brick: 'bg-brick-tint text-brick border-brick-line',
};

/** The editorial lifecycle of an estimate. */
export const STATUS_TONE: Record<string, PillTone> = {
  DRAFT: 'neutral',
  REVIEW: 'bronze',
  FINALISED: 'green',
};

export function Pill({
  tone = 'neutral',
  dot = true,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: PillTone; dot?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1',
        'text-[11px] font-bold uppercase tracking-[0.08em]',
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}
