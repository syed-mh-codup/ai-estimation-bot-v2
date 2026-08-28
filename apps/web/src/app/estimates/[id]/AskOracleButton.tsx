'use client';

import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { askOracle } from './oracle-bus';

/**
 * "Ask Oracle about this", wherever this happens to be.
 *
 * Seeds the composer rather than sending: the seeded wording is a starting
 * point and the estimator usually wants to sharpen it before spending a turn on
 * it. It also means the panel never opens mid-answer to a question nobody
 * actually asked.
 *
 * Quiet by default and revealed on hover of the surrounding `group`, because
 * these sit on the densest rows of the densest screen in the app. It stays
 * reachable by keyboard regardless — `focus-visible` brings it back, which
 * hover-only affordances lose.
 */
export function AskOracleButton({
  question,
  label,
  testid,
  className,
}: {
  question: string;
  label: string;
  testid?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testid}
      onClick={(e) => {
        e.stopPropagation();
        askOracle({ question });
      }}
      className={cn(
        'shrink-0 rounded p-0.5 text-ink-4 opacity-0 transition-opacity',
        'group-hover:opacity-100 focus-visible:opacity-100 hover:text-green',
        'focus-visible:ring-1 focus-visible:ring-green focus-visible:outline-none',
        className,
      )}
    >
      <Sparkles className="h-3 w-3" aria-hidden />
    </button>
  );
}
