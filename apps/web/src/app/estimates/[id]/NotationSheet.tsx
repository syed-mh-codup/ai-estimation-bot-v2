'use client';

import { useState } from 'react';
import { Lock, LockOpen } from 'lucide-react';
import { Dialog, DialogTrigger, SheetContent, DialogTitle } from '@/components/ui/dialog';
import { useLedger } from './ledger-context';
import { BRONZE_CHIP, MICRO_CHIP } from './marks';
import { BEATS, NOTATION, NOTATION_CLOSING, type NotationSample } from './notation';

/**
 * The whole vocabulary at once, for the person who wants it. AEH-377.
 *
 * The third and quietest of the three things that explain a mark, and its
 * position in that order is the design. A legend was the obvious answer to
 * "nothing on this screen says what these symbols mean" and it is the wrong
 * one on its own, because it fixes a discoverability problem with a feature you
 * have to discover, and because looking a glyph up costs a round trip most
 * people stop making after the second time. So the marks answer for themselves
 * where you meet them, the row above the ledger says which ones this estimate
 * carries, and this sits behind a link for reading up rather than looking up —
 * before a client call, or on somebody's first day.
 *
 * A sheet rather than a dialog because it is consulted rather than answered,
 * and because a centred modal over a ledger you are trying to read against is
 * the wrong shape. Each entry that corresponds to a filter chip offers the
 * count in THIS estimate and takes you to those cards, closing behind itself —
 * a reference that is a way in rather than a dead end.
 */
export function NotationSheet() {
  const { markCounts, setActiveMark } = useLedger();
  const [open, setOpen] = useState(false);

  const show = (mark: Parameters<typeof setActiveMark>[0]) => {
    setActiveMark(mark);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="shrink-0 text-[11.5px] text-ink-4 underline decoration-dotted underline-offset-2 hover:text-ink-2"
          data-testid="open-notation"
        >
          What do these mean?
        </button>
      </DialogTrigger>

      <SheetContent className="max-w-[520px]" aria-describedby={undefined}>
        <div className="shrink-0 border-b border-line px-5 pt-5 pb-4">
          <DialogTitle>How to read this estimate</DialogTitle>
          <p className="mt-1.5 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-3">
            Four things about a row, then every mark one can carry.
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="notation-body">
          <ol className="space-y-3">
            {BEATS.map((beat, i) => (
              <li key={beat.title} className="flex gap-3">
                <span className="num mt-px shrink-0 text-[11px] font-semibold text-ink-4">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink">{beat.title}</div>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{beat.body}</p>
                </div>
              </li>
            ))}
          </ol>

          {NOTATION.map((group) => (
            <section key={group.question} className="mt-7">
              <h3 className="font-serif text-[15px] font-medium text-ink">{group.question}</h3>

              <dl className="mt-2.5 space-y-3.5">
                {group.entries.map((entry, i) => {
                  const count = entry.mark ? markCounts[entry.mark] : undefined;
                  return (
                    <div
                      key={i}
                      className="border-t border-line-soft pt-3 first:border-t-0 first:pt-0"
                      data-testid={entry.mark ? `notation-${entry.mark}` : undefined}
                    >
                      <dt className="flex flex-wrap items-center gap-2">
                        <Sample sample={entry.sample} />
                        <span className="min-w-0 flex-1 text-[12.5px] leading-snug font-semibold text-ink">
                          {entry.meaning}
                        </span>
                      </dt>
                      <dd className="mt-1 text-[12px] leading-relaxed text-ink-3">
                        {entry.note}
                        {/* Only where something actually carries it. "0 in this
                            estimate" is a fact about nothing, and a row of them
                            teaches you to skip the line that matters. */}
                        {entry.mark && count !== undefined && (
                          <>
                            {' '}
                            <button
                              type="button"
                              onClick={() => show(entry.mark ?? null)}
                              className="font-semibold text-green underline decoration-dotted underline-offset-2 hover:text-green-deep"
                              data-testid={`notation-goto-${entry.mark}`}
                            >
                              Show the {count} in this estimate
                            </button>
                          </>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          ))}

          <p className="mt-7 border-t border-line pt-3.5 text-[12px] leading-relaxed text-ink-4">
            {NOTATION_CLOSING}
          </p>
        </div>
      </SheetContent>
    </Dialog>
  );
}

/**
 * The example itself, drawn the way the ledger draws it.
 *
 * Every one of these reuses the ledger's own class strings rather than an
 * approximation of them — the chips from `marks.ts`, the hatch and the rules
 * copied from the row treatments they illustrate. A sample that merely
 * resembles the thing is the failure this sheet exists to avoid.
 */
function Sample({ sample }: { sample: NotationSample }) {
  switch (sample.kind) {
    case 'chip':
      return (
        <span className={sample.tone === 'bronze' ? BRONZE_CHIP : MICRO_CHIP}>{sample.text}</span>
      );

    case 'word':
      return (
        <span className="shrink-0 text-[9.5px] font-bold tracking-[0.06em] text-ink-4 underline decoration-line decoration-dotted underline-offset-2 uppercase">
          {sample.text}
        </span>
      );

    case 'meta':
      return <span className="shrink-0 text-[11px] text-ink-4">{sample.text}</span>;

    case 'envelope':
      return <span className="shrink-0 text-[10px] text-ink-4">{sample.text}</span>;

    case 'buffered':
      return (
        <span className="flex shrink-0 items-baseline gap-1.5">
          <span className="num text-xs text-ink">4</span>
          <span className="num text-[10px] text-ink-4">+15% →</span>
          <span className="num text-xs font-semibold text-green">4.6</span>
        </span>
      );

    case 'dash':
      return <span className="num shrink-0 text-xs text-ink-4">—</span>;

    case 'side':
      return (
        <span className="flex shrink-0 gap-1">
          <span className="num w-[22px] rounded-[3px] border border-green-line bg-green-tint px-0.5 text-center text-[9.5px] font-bold text-green">
            BE
          </span>
          <span className="num w-[22px] rounded-[3px] border border-line-soft px-0.5 text-center text-[9.5px] font-bold text-ink-4">
            FE
          </span>
        </span>
      );

    case 'hatch':
      return (
        <span className="h-5 w-12 shrink-0 rounded-[3px] border border-line-soft bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,rgba(148,143,129,0.05)_5px,rgba(148,143,129,0.05)_10px)]" />
      );

    case 'bronzeRule':
      return (
        <span className="h-5 w-12 shrink-0 rounded-[3px] border border-line-soft border-l-2 border-l-bronze-line" />
      );

    case 'ring':
      return <span className="h-5 w-12 shrink-0 rounded-[3px] ring-1 ring-green/50 ring-inset" />;

    case 'forkRules':
      return (
        <span className="flex shrink-0 items-center gap-1">
          <span className="h-5 w-[3px] rounded-full bg-green" />
          <span className="h-5 w-[3px] rounded-full bg-ink-4" />
          <span className="h-5 w-[3px] rounded-full bg-[repeating-linear-gradient(to_bottom,var(--color-ink-4)_0_3px,transparent_3px_6px)]" />
        </span>
      );

    case 'locks':
      return (
        <span className="flex shrink-0 items-center gap-1.5">
          <LockOpen className="h-3 w-3 text-ink-4" aria-hidden />
          <Lock className="h-3 w-3 text-bronze-ink/60" aria-hidden />
          <Lock className="h-3 w-3 text-bronze-ink" aria-hidden />
        </span>
      );
  }
}
