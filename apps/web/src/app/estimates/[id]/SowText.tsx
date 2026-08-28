'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { createQuoteMatcher } from '@repo/shared';
import { ORACLE_CITE_EVENT, askOracle, onBus, type OracleCiteDetail } from './oracle-bus';

/**
 * The source material, made interrogable.
 *
 * This replaces a plain `<p>{sowText}</p>`. It does two things that paragraph
 * could not: it offers "Ask Oracle about this" over a selection, and it can
 * find and highlight a span Oracle quoted so the estimator can check the quote
 * against the document with their own eyes.
 *
 * The text is deliberately NOT pre-chunked into spans. Splitting a brief into
 * per-sentence nodes up front would change what the reader sees on a page that
 * is meant to look like a document, and it would still not match the arbitrary
 * spans a model quotes. Instead the whole thing renders as one block and is
 * split into three pieces — before, match, after — only while a highlight is
 * active.
 */
export function SowText({ sowText }: { sowText: string }) {
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const [selection, setSelection] = useState<{ text: string; top: number; left: number } | null>(
    null,
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLElement>(null);

  // Built from the same matcher the citation check uses, so a quote that the
  // transcript marks verified is exactly one this can find. Two different
  // implementations here would mean a quote that renders as trustworthy and
  // then jumps nowhere.
  //
  // useMemo, not useCallback: useCallback would still evaluate
  // createQuoteMatcher(sowText) on every render and only memoise the reference
  // afterwards, rebuilding the normalised copy of the whole document each time
  // — the exact cost the one-pass matcher exists to avoid.
  const match = useMemo(() => createQuoteMatcher(sowText), [sowText]);

  useEffect(
    () =>
      onBus<OracleCiteDetail>(ORACLE_CITE_EVENT, ({ quote }) => {
        const at = match(quote);
        if (!at) return;
        setHighlight(at);
      }),
    [match],
  );

  // Scroll once the highlight has actually rendered, not when it is requested —
  // the section it lives in may still be opening.
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => {
      markRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  function onMouseUp() {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (!sel || text.length < 3 || !containerRef.current) {
      setSelection(null);
      return;
    }
    // Only offer this for text inside the source block.
    const anchor = sel.anchorNode;
    if (!anchor || !containerRef.current.contains(anchor)) {
      setSelection(null);
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const box = containerRef.current.getBoundingClientRect();
    setSelection({
      text,
      top: rect.top - box.top - 38,
      left: Math.max(0, rect.left - box.left),
    });
  }

  const before = highlight ? sowText.slice(0, highlight.start) : sowText;
  const inside = highlight ? sowText.slice(highlight.start, highlight.end) : '';
  const after = highlight ? sowText.slice(highlight.end) : '';

  return (
    <div ref={containerRef} className="relative" onMouseUp={onMouseUp}>
      <p
        className="rounded-md border border-line-soft bg-surface-2 p-3.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2"
        data-testid="sow-text"
      >
        {before}
        {highlight && (
          <mark
            ref={markRef}
            data-testid="sow-highlight"
            className="rounded-[3px] bg-bronze-tint px-0.5 text-ink ring-1 ring-bronze-line"
          >
            {inside}
          </mark>
        )}
        {after}
      </p>

      {selection && (
        <button
          type="button"
          data-testid="ask-oracle-selection"
          style={{ top: selection.top, left: selection.left }}
          className="absolute z-[5] flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink shadow-[0_6px_20px_rgba(35,33,27,0.14)] hover:border-green hover:text-green"
          onClick={() => {
            askOracle({
              question: `About this passage from the source material:\n\n"${selection.text}"\n\nWhat does it mean for this estimate?`,
            });
            setSelection(null);
            window.getSelection()?.removeAllRanges();
          }}
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Ask Oracle about this
        </button>
      )}

      {highlight && (
        <button
          type="button"
          onClick={() => setHighlight(null)}
          className="mt-2 text-[11.5px] text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
          data-testid="clear-highlight"
        >
          Clear highlight
        </button>
      )}
    </div>
  );
}
