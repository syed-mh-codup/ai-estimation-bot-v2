/**
 * Citations: the wire format Oracle quotes in, and the check that the quotes are
 * real. AEH-259.
 *
 * This lives in @repo/shared rather than beside the rest of Oracle for a
 * concrete reason: the SOW renderer is a CLIENT component and needs the very
 * same matcher to highlight a quoted span. Importing it from @repo/agents pulls
 * that package's barrel, which reaches run-estimate, then @repo/providers, then
 * googleapis, then node:fs — and the browser build fails. Splitting the pure
 * string logic out is what lets ONE implementation serve the write-time check,
 * the render-time check, the evals and the highlighter, which is the property
 * that matters: a quotation that verifies in one place and not another is worse
 * than no check at all.
 *
 * Nothing here touches a database, a model or the DOM.
 */

// ─── Citation wire format ─────────────────────────────────────────────────────

/**
 * Oracle wraps verbatim quotations in these markers.
 *
 * Chosen over guillemets or typographic quotes because those legitimately occur
 * in client documents, and a marker that appears inside the source material
 * cannot delimit a quotation OF that material. Doubled brackets do not occur in
 * prose, and models emit them reliably without escaping games.
 */
export const QUOTE_OPEN = '[[';
export const QUOTE_CLOSE = ']]';

/** One piece of a rendered answer: prose, or a verbatim quotation. */
export type AnswerSegment = { type: 'text'; value: string } | { type: 'quote'; value: string };

/**
 * Split an answer into prose and quotations.
 *
 * Also the parser the transcript UI uses, so what gets highlighted is exactly
 * what gets verified. Tolerant of an unterminated opener, which happens
 * mid-stream on every single turn: the tail is rendered as prose until the
 * closing marker arrives.
 */
export function splitAnswer(text: string): AnswerSegment[] {
  const segments: AnswerSegment[] = [];
  let cursor = 0;

  for (;;) {
    const open = text.indexOf(QUOTE_OPEN, cursor);
    if (open === -1) break;
    const close = text.indexOf(QUOTE_CLOSE, open + QUOTE_OPEN.length);
    if (close === -1) break;

    if (open > cursor) segments.push({ type: 'text', value: text.slice(cursor, open) });
    segments.push({ type: 'quote', value: text.slice(open + QUOTE_OPEN.length, close) });
    cursor = close + QUOTE_CLOSE.length;
  }

  if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
  return segments;
}

/** Every verbatim span an answer claims to quote, in order, deduplicated. */
export function extractCitations(text: string): string[] {
  const quotes = splitAnswer(text)
    .filter((s): s is { type: 'quote'; value: string } => s.type === 'quote')
    .map((s) => s.value.trim())
    .filter((s) => s.length > 0);
  return [...new Set(quotes)];
}

// ─── Quote matching ───────────────────────────────────────────────────────────

/**
 * Fold the differences that are rendering rather than content.
 *
 * Whitespace is the big one: models reflow line breaks and collapse the runs of
 * spaces that survive PDF extraction, so a genuine quotation routinely fails a
 * naive `includes()`. Typographic quotes and dashes are folded for the same
 * reason — a model that retypes an apostrophe as a curly one has not fabricated
 * anything.
 *
 * This does weaken "verbatim" very slightly, and that is a deliberate trade: the
 * cost of rejecting real quotations (the estimator stops trusting the check, and
 * the check is the whole safeguard) is far higher than the cost of accepting one
 * whose apostrophe is the wrong shape. Nothing here folds words, numbers,
 * punctuation that changes meaning, or order.
 */
const FOLD: Record<string, string> = {
  '\u2018': "'",
  '\u2019': "'",
  '\u201B': "'",
  '\u2032': "'",
  '\u201C': '"',
  '\u201D': '"',
  '\u201F': '"',
  '\u2033': '"',
  '\u2010': '-',
  '\u2011': '-',
  '\u2012': '-',
  '\u2013': '-',
  '\u2014': '-',
  '\u2015': '-',
  '\u2212': '-',
};

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f', '\v', '\u00A0']);

/**
 * Normalise, and remember where every surviving character came from.
 *
 * One pass, and deliberately no per-character regex: this runs across a whole
 * source document every time a transcript renders, and a regex-engine call per
 * character is the difference between imperceptible and a visible stall on a
 * long brief.
 *
 * `map[i]` is the offset in the ORIGINAL text of the character that produced
 * `text[i]`. That is what lets a match found in normalised space be reported
 * against real offsets, so the UI highlights the actual characters in the actual
 * document rather than an approximation of them.
 */
function normaliseWithMap(text: string): { text: string; map: number[] } {
  const map: number[] = [];
  let out = '';
  let pendingSpace = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (WHITESPACE.has(ch)) {
      // Collapsed to at most one space, and never a leading one.
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      map.push(i);
      pendingSpace = false;
    }
    out += (FOLD[ch] ?? ch).toLowerCase();
    map.push(i);
  }

  return { text: out, map };
}

export function normalizeForMatch(text: string): string {
  return normaliseWithMap(text).text;
}

/** Where a quotation sits in the raw source, as offsets into the ORIGINAL text. */
export type QuoteLocation = { start: number; end: number };

/** Finds quotations in one fixed source. */
export type QuoteMatcher = (quote: string) => QuoteLocation | null;

/**
 * Build a matcher over one source text.
 *
 * The normalised copy and its index map are built ONCE and reused for every
 * quotation, which matters because a single answer can carry several and a
 * transcript carries many answers.
 *
 * The result is deliberately NEVER persisted. Recomputing on every read is what
 * lets the UI tell two very different failures apart: a quotation missing while
 * the source hash still matches was FABRICATED, and a quotation missing because
 * the hash has moved is merely STALE. A stored verdict would answer neither
 * question a week later, and catching fabrication is the point of the feature.
 */
export function createQuoteMatcher(source: string): QuoteMatcher {
  const normalised = normaliseWithMap(source);

  return (quote: string): QuoteLocation | null => {
    const trimmed = quote.trim();
    if (!trimmed) return null;

    // Exact first: the common case, and it needs no mapping back.
    const exact = source.indexOf(trimmed);
    if (exact !== -1) return { start: exact, end: exact + trimmed.length };

    const needle = normalizeForMatch(trimmed);
    if (!needle) return null;
    const at = normalised.text.indexOf(needle);
    if (at === -1) return null;

    const start = normalised.map[at] ?? 0;
    const lastIndex = normalised.map[at + needle.length - 1] ?? start;
    return { start, end: lastIndex + 1 };
  };
}

/** A quotation and whether it is actually present in the corpus it claims. */
export type CitationCheck = { quote: string; verified: boolean; location: QuoteLocation | null };

/**
 * The mechanical citation-integrity check.
 *
 * `sourceText` is the SOW, so a quotation found there is jumpable in the UI.
 * `corpusText` is everything Oracle was given — a quotation may legitimately come
 * from the narrative, an assumption or a card, in which case it is verified but
 * not jumpable.
 */
export function checkCitations(
  citations: string[],
  corpusText: string,
  sourceText: string,
): CitationCheck[] {
  // Two matchers, each built once, rather than one per quotation per source.
  const inCorpus = createQuoteMatcher(corpusText);
  const inSource = createQuoteMatcher(sourceText);
  return citations.map((quote) => ({
    quote,
    verified: inCorpus(quote) !== null,
    location: inSource(quote),
  }));
}
