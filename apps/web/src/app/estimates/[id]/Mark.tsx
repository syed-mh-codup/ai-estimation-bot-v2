'use client';

import { cn } from '@/lib/utils';
import { Menu, MenuContent, MenuItem, MenuNote, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { askOracle } from './oracle-bus';
import { useLedger } from './ledger-context';
import { MARK_LABEL, MARK_STORY, type MarkKey } from './marks';

/**
 * A mark that explains itself where you met it. AEH-377.
 *
 * This is the half of the missing legend that a legend could never be. The
 * round trip a lookup table demands — notice the bronze rule on row seven, go
 * up to a key, match a glyph against fourteen entries several of which differ
 * only by hue, read it, come back, find your row again — is long enough that
 * people stop making it and go on guessing. Worse, the grouping such a table
 * needs ("where did this come from?") is a question you can only answer once
 * you already know the answer.
 *
 * So the answer moves to the mark. You have already looked at it; clicking it
 * is now rewarded. It carries the two things you almost always want next — the
 * others like it, and why this one — and it works on touch and in a keyboard
 * tab order, which the `title` tooltip it replaces never did.
 *
 * The tooltip stays anyway, as `title`. It is free, it is what a fast reader
 * hovering expects, and it is the only thing that survives when JavaScript has
 * not hydrated yet.
 */
export function Mark({
  kind,
  cardTitle,
  className,
  children,
  'data-testid': testId,
}: {
  kind: MarkKey;
  /** Named in the Oracle question, so it is about this card rather than the concept. */
  cardTitle: string;
  className?: string;
  children: React.ReactNode;
  'data-testid'?: string;
}) {
  const { markCounts, activeMark, setActiveMark } = useLedger();

  const total = markCounts[kind] ?? 0;
  // "The other two", not "the three" — you are looking at one of them.
  const others = Math.max(0, total - 1);
  const filtering = activeMark === kind;

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          title={MARK_STORY[kind]}
          aria-label={`${MARK_LABEL[kind]} — what this means`}
          className={cn(
            'shrink-0 cursor-pointer transition-shadow',
            'hover:shadow-[0_0_0_2px_rgba(47,107,76,0.22)]',
            'focus-visible:ring-1 focus-visible:ring-green focus-visible:outline-none',
            className,
          )}
          data-testid={testId}
        >
          {children}
        </button>
      </MenuTrigger>

      <MenuContent className="max-w-[320px]">
        <MenuNote className="text-[13px] font-semibold text-ink">{MARK_LABEL[kind]}</MenuNote>
        <MenuNote className="pt-0 text-[12px] leading-relaxed text-ink-3">
          {MARK_STORY[kind]}
        </MenuNote>

        <MenuSeparator />

        {/* Offered only when there is something else to see. On an estimate with
            one inferred card, "show the other 0" is worse than no row. */}
        {others > 0 && (
          <MenuItem onSelect={() => setActiveMark(filtering ? null : kind)}>
            {filtering
              ? 'Stop picking these out'
              : `Show the other ${others} ${others === 1 ? 'card' : 'cards'}`}
          </MenuItem>
        )}

        <MenuItem
          onSelect={() =>
            askOracle({
              question: `The card "${cardTitle}" is marked ${MARK_LABEL[kind].toLowerCase()}. Why — and what would change if it were not?`,
            })
          }
        >
          Ask Oracle about this one
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
