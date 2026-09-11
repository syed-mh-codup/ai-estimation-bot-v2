'use client';

import { expandSection } from './oracle-bus';

/**
 * A link to a section of this document that also OPENS it. AEH-377.
 *
 * A bare `<a href="#risk">` scrolls to a collapsed section and shows the reader
 * an unopened header — which is the same bug AEH-259 fixed for the Oracle's
 * quote jumps, arrived at from the other direction. Every collapsible section
 * already listens for `estimate:expand-section`; this is the one-line sender,
 * named so nobody has to remember that the event exists.
 *
 * The `href` stays real rather than being replaced by an onClick. It is what
 * makes the link middle-clickable, copyable, focusable and legible in the
 * status bar, and the browser's own scrolling is better than anything worth
 * writing here — the event only handles the opening.
 */
export function JumpLink({
  to,
  className,
  children,
  'data-testid': testId,
}: {
  /** The section's `id`, without the hash. */
  to: string;
  className?: string;
  children: React.ReactNode;
  'data-testid'?: string;
}) {
  return (
    <a
      href={`#${to}`}
      onClick={() => expandSection(to)}
      className={className}
      data-testid={testId}
    >
      {children}
    </a>
  );
}
