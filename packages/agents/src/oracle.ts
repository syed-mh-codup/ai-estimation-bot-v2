/**
 * Oracle — read-only question answering over one estimate. AEH-259.
 *
 * Oracle is not part of a run. It assembles everything known about a single
 * estimate, hands the lot to a model along with the admin-authored grounding
 * prompt, and streams back an answer that quotes the source before explaining
 * it. It has no write path: nothing in this module mutates an estimate, and the
 * only rows the feature writes at all are its own thread and message rows, which
 * live in the web layer.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. The citation wire format is owned by CODE, not by the prompt. The prompt is
 *    admin-editable at /admin/prompts, and if the marker syntax lived there an
 *    edit could silently break quote extraction — the answers would still look
 *    fine while every citation quietly stopped being checkable.
 * 2. Quote matching is normalised, and ONE implementation serves the write-time
 *    check, the render-time check, the evals and the UI highlighter. They must
 *    agree, or a quote verifies in one place and is flagged as fabricated in
 *    another.
 * 3. Verification is never stored. See findQuoteInSource.
 */
import type { PrismaClient } from '@repo/db';
import type { ChatMessage } from '@repo/providers';
import type { ComplexityOutput, Requirement } from '@repo/shared';
import { createHash } from 'node:crypto';

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

/**
 * Locate a quotation in a source text, or null if it is not there.
 *
 * Convenience over `createQuoteMatcher` for one-off checks. Prefer the matcher
 * when checking more than a single quote against the same source.
 */
export function findQuoteInSource(quote: string, source: string): QuoteLocation | null {
  return createQuoteMatcher(source)(quote);
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

// ─── Corpus ───────────────────────────────────────────────────────────────────

export type OracleLineItem = {
  role: string;
  title: string | null;
  baseHours: number;
  taxedHours: number;
  notes: string | null;
  requirementId: string | null;
  dependsOn: string[];
  anchorPresetIds: string[];
};

export type OracleMenuItem = {
  title: string;
  taxonomyKey: string;
  enabled: boolean;
  injected: boolean;
  sectionTitle: string | null;
  requirementIds: string[];
  lineItems: OracleLineItem[];
};

export type OracleHiddenWork = {
  riskFlag: string;
  claim: string;
  citation: string;
  requirementId: string;
  outcome: string;
  dismissReason: string | null;
};

export type OracleCorpus = {
  estimateId: string;
  title: string;
  status: string;
  sowText: string;
  /** sha256 of sowText. Stamped onto every message written against this corpus. */
  sowHash: string;
  runFinishedAt: Date | null;
  narrative: string[];
  assumptions: string[];
  complexityScore: number | null;
  complexity: ComplexityOutput | null;
  requirements: Requirement[];
  menuItems: OracleMenuItem[];
  hiddenWork: OracleHiddenWork[];
  claimedRiskFlags: string[];
};

export function hashSow(sowText: string): string {
  return createHash('sha256').update(sowText).digest('hex');
}

/**
 * Everything Oracle is allowed to know about one estimate.
 *
 * Reads only. Whatever does not exist yet is simply absent: a DRAFT estimate
 * that has never been run has source material and nothing else, and Oracle
 * behaves as a document reader — which is one of the more useful moments for it,
 * since reading a brief before committing to a run is exactly when questions
 * are cheapest to answer.
 *
 * @todo This is the retrieval seam. Today the whole corpus goes into every turn,
 * which is proven at this scale — the Librarian already sends an entire SOW with
 * no truncation guard anywhere in this package. When documents outgrow that, the
 * change belongs HERE: chunk the source, embed it, and select passages per
 * question (the preset RAG in rag-retriever.ts is the working precedent), or give
 * Oracle a search tool and let it fetch. Do not bolt truncation onto the caller —
 * silently dropping the second half of a brief would make Oracle confidently
 * wrong about what a client asked for, which is the one failure this feature
 * exists to prevent.
 */
export async function buildOracleCorpus(
  db: PrismaClient,
  estimateId: string,
): Promise<OracleCorpus | null> {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    include: {
      sections: { orderBy: { order: 'asc' } },
      menuItems: { include: { lineItems: true } },
      hiddenWork: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!estimate) return null;

  const sectionTitleById = new Map(estimate.sections.map((s) => [s.id, s.title]));
  const state = (estimate.agentState ?? {}) as Record<string, unknown>;
  const librarian = state['librarianOutput'] as { requirements?: Requirement[] } | undefined;

  return {
    estimateId: estimate.id,
    title: estimate.title,
    status: estimate.status,
    sowText: estimate.sowText,
    sowHash: hashSow(estimate.sowText),
    runFinishedAt: estimate.runFinishedAt,
    narrative: estimate.narrative,
    assumptions: estimate.assumptions,
    complexityScore: estimate.complexityScore,
    complexity: (state['complexity'] as ComplexityOutput | undefined) ?? null,
    requirements: librarian?.requirements ?? [],
    claimedRiskFlags: (state['claimedRiskFlags'] as string[] | undefined) ?? [],
    menuItems: estimate.menuItems.map((item) => {
      const meta = (item.meta ?? {}) as Record<string, unknown>;
      return {
        title: item.title,
        taxonomyKey: item.taxonomyKey,
        enabled: item.enabled,
        injected: item.injected,
        sectionTitle: item.sectionId ? (sectionTitleById.get(item.sectionId) ?? null) : null,
        requirementIds: (meta['requirementIds'] as string[] | undefined) ?? [],
        lineItems: item.lineItems.map((li) => {
          const liMeta = (li.meta ?? {}) as Record<string, unknown>;
          return {
            role: li.role,
            title: li.title,
            baseHours: li.baseHours,
            taxedHours: li.taxedHours,
            notes: li.notes,
            requirementId: (liMeta['requirementId'] as string | undefined) ?? null,
            dependsOn: (liMeta['dependsOn'] as string[] | undefined) ?? [],
            anchorPresetIds: (liMeta['anchorPresetIds'] as string[] | undefined) ?? [],
          };
        }),
      };
    }),
    hiddenWork: estimate.hiddenWork.map((f) => ({
      riskFlag: f.riskFlag,
      claim: f.claim,
      citation: f.citation,
      requirementId: f.requirementId,
      outcome: f.outcome,
      dismissReason: f.dismissReason,
    })),
  };
}

// ─── Prompt assembly ──────────────────────────────────────────────────────────

/**
 * The mechanical half of the contract, appended to the admin-authored prompt.
 *
 * Kept in code on purpose. The grounding DISCIPLINE — quote then explain, refuse
 * and name the gap — is prompt-tuning work and lives in the editable prompt. The
 * marker SYNTAX is a wire format between the model and a parser, and an admin
 * rewording the prompt must not be able to break quote extraction without
 * anyone noticing.
 */
const FORMAT_CONTRACT = `OUTPUT FORMAT

Wrap every verbatim quotation in doubled square brackets, like ${QUOTE_OPEN}the exact words from the corpus${QUOTE_CLOSE}. Use them for quotations only, never for emphasis or for your own words.

Text inside the markers is checked character by character against the corpus you were given. Anything that does not appear there is reported to the reader as unverified, so do not adjust, shorten or join passages inside a quotation. Quote separately instead.

Do not use the markers when you are saying the corpus does NOT contain something. There is nothing to quote in that case; say it in plain words.`;

export type OracleTurn = { role: 'USER' | 'ASSISTANT'; content: string };

/**
 * Render the corpus as the text the model sees.
 *
 * Headings are stable and code-generated, which is also what lets the offline
 * evals route a stub model on them — Oracle's user text is written by a person
 * and cannot be matched on.
 */
export function renderCorpus(corpus: OracleCorpus): string {
  const parts: string[] = [];

  parts.push(`# ESTIMATE\n\n${corpus.title} (status: ${corpus.status})`);
  parts.push(`# SOURCE MATERIAL\n\n${corpus.sowText}`);

  if (corpus.requirements.length > 0) {
    const lines = corpus.requirements.map((r) => {
      const bits = [`${r.id}: ${r.text}`, `  traced to: ${r.sourceRef}`];
      if (r.taxonomyKey) bits.push(`  taxonomy: ${r.taxonomyKey}`);
      if (r.ambiguities.length > 0) bits.push(`  ambiguities: ${r.ambiguities.join('; ')}`);
      if (r.blocksEstimation) bits.push('  flagged as blocking estimation');
      return bits.join('\n');
    });
    parts.push(`# REQUIREMENTS\n\n${lines.join('\n\n')}`);
  }

  if (corpus.narrative.length > 0) {
    parts.push(`# NARRATIVE\n\n${corpus.narrative.map((n) => `- ${n}`).join('\n')}`);
  }
  if (corpus.assumptions.length > 0) {
    parts.push(`# ASSUMPTIONS\n\n${corpus.assumptions.map((a) => `- ${a}`).join('\n')}`);
  }

  if (corpus.menuItems.length > 0) {
    const cards = corpus.menuItems.map((item) => {
      const head = [
        `## ${item.title}`,
        `taxonomy: ${item.taxonomyKey}`,
        `section: ${item.sectionTitle ?? 'Ungrouped'}`,
        item.enabled ? 'included in the total' : 'toggled OFF, excluded from the total',
        item.injected ? 'injected by the hidden-work audit, not asked for in the source' : null,
        item.requirementIds.length > 0 ? `covers: ${item.requirementIds.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      const lines = item.lineItems.map((li) => {
        const extra = [
          li.requirementId ? `req ${li.requirementId}` : null,
          li.dependsOn.length > 0 ? `depends on ${li.dependsOn.join(', ')}` : null,
          li.anchorPresetIds.length > 0 ? `anchored on ${li.anchorPresetIds.join(', ')}` : null,
          li.notes ? `note: ${li.notes}` : null,
        ]
          .filter(Boolean)
          .join('; ');
        return `- ${li.role} ${li.baseHours}h base / ${li.taxedHours}h taxed — ${li.title ?? 'untitled'}${extra ? ` (${extra})` : ''}`;
      });

      return `${head}\n${lines.join('\n')}`;
    });
    parts.push(`# MENU CARD\n\n${cards.join('\n\n')}`);
  }

  if (corpus.complexityScore !== null || corpus.complexity) {
    const bits = [`score: ${corpus.complexityScore ?? 'not set'} (of 5)`];
    if (corpus.complexity) {
      const multipliers = Object.entries(corpus.complexity.perItemMultipliers ?? {});
      if (multipliers.length > 0) {
        bits.push(`per-item multipliers: ${multipliers.map(([k, v]) => `${k}=${v}`).join(', ')}`);
      }
    }
    parts.push(`# COMPLEXITY\n\n${bits.join('\n')}`);
  }

  if (corpus.hiddenWork.length > 0) {
    const rows = corpus.hiddenWork.map((f) =>
      [
        `- ${f.riskFlag} (${f.outcome})`,
        `  raised against ${f.requirementId}: ${f.claim}`,
        `  citation: ${f.citation}`,
        f.dismissReason ? `  dismissed because: ${f.dismissReason}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    );
    parts.push(
      `# RISKS RAISED AND WHAT HAPPENED TO THEM\n\nThese are risks the Detective raised that no estimator claimed to have costed. Each carries what was decided.\n\n${rows.join('\n')}`,
    );
  }

  if (corpus.claimedRiskFlags.length > 0) {
    parts.push(
      `# RISKS THE ESTIMATORS SAID THEY COSTED\n\nThe council declared that its hours already account for these, which is why they raised no finding above.\n\n${corpus.claimedRiskFlags.map((f) => `- ${f}`).join('\n')}`,
    );
  }

  return parts.join('\n\n');
}

/**
 * The full message list for one Oracle turn.
 *
 * The corpus is replayed on every turn rather than only on the first: threads
 * are long-lived and an estimate changes underneath them, so re-sending is what
 * keeps an answer about the CURRENT state. Prior turns are replayed whole, with
 * no cap — the UI nudges the estimator to start a new thread when one grows,
 * which is what user-created threads are for.
 */
export function buildOracleMessages(args: {
  corpus: OracleCorpus;
  /** The admin-authored, versioned ORACLE prompt body. */
  instructions: string;
  history: OracleTurn[];
  question: string;
}): ChatMessage[] {
  const { corpus, instructions, history, question } = args;
  return [
    { role: 'system', content: `${instructions}\n\n${FORMAT_CONTRACT}` },
    {
      role: 'user',
      content: `Here is everything known about the estimate you are answering questions about. Answer only from this.\n\n${renderCorpus(corpus)}`,
    },
    {
      role: 'assistant',
      content: 'Understood. I have read the corpus and will answer only from it.',
    },
    ...history.map(
      (t): ChatMessage => ({
        role: t.role === 'USER' ? 'user' : 'assistant',
        content: t.content,
      }),
    ),
    { role: 'user', content: question },
  ];
}

/** A thread title derived from its opening question. No model call. */
export function deriveThreadTitle(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  if (flat.length <= 60) return flat || 'Untitled question';
  return `${flat.slice(0, 57).trimEnd()}…`;
}
