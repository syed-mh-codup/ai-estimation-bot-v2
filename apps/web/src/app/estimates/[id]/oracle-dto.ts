import { checkCitations, splitAnswer, type AnswerSegment } from '@repo/shared';

/**
 * Shapes and pure mappers for the Oracle surface.
 *
 * Separate from oracle-actions.ts for a reason that has already cost this repo a
 * broken deploy: a `'use server'` module may export ONLY async functions, and a
 * single synchronous export there fails the build of every route that imports
 * anything from the file — while typecheck, lint and the whole unit suite stay
 * green. See AEH-253 and the dto.ts sitting next to this one.
 */

/** Whether a quotation still holds up against the corpus as it stands now. */
export type CitationStatus =
  /** Found in the corpus. */
  | 'verified'
  /** Not found, and the source has not changed since — the model invented it. */
  | 'fabricated'
  /** Not found, but the source has moved since this was written. */
  | 'source-moved';

export type CitationView = {
  quote: string;
  status: CitationStatus;
  /** Offsets into the CURRENT sowText, when the quote is jumpable. */
  location: { start: number; end: number } | null;
};

export type OracleMessageDTO = {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  createdAt: string;
  citations: CitationView[];
  /** The estimate has moved on since this turn was written. */
  stale: boolean;
  modelString: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
};

export type OracleThreadDTO = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
};

/** The row shape these mappers read. Structural, so callers can select narrowly. */
export type MessageRow = {
  id: string;
  role: 'USER' | 'ASSISTANT';
  content: string;
  citations: string[];
  sowHash: string;
  estimateRunAt: Date | null;
  modelString: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  createdAt: Date;
};

/** What the estimate looks like right now, to judge a stored turn against. */
export type CorpusNow = {
  sowHash: string;
  runFinishedAt: Date | null;
  sowText: string;
  /** The whole corpus as text — a quote may come from a card, not the source. */
  corpusText: string;
};

/**
 * Has the estimate moved on since this turn was written?
 *
 * Two independent signals because two different things change underneath a
 * conversation. Re-ingesting the source material changes the hash; re-running
 * the pipeline deletes and recreates every line item, so an answer about a card
 * can be obsolete while the source is untouched.
 */
export function isStale(row: Pick<MessageRow, 'sowHash' | 'estimateRunAt'>, now: CorpusNow): boolean {
  if (row.sowHash !== now.sowHash) return true;
  const wrote = row.estimateRunAt?.getTime() ?? null;
  const current = now.runFinishedAt?.getTime() ?? null;
  return wrote !== current;
}

/**
 * Classify a stored turn's quotations against the corpus as it stands.
 *
 * The distinction between `fabricated` and `source-moved` is the whole reason
 * verification is recomputed rather than stored. A quotation that is missing
 * while the source is byte-identical to when it was written cannot be explained
 * away — the model made it up, and the reader needs to be told loudly. The same
 * missing quotation against an edited source is ordinary drift and deserves a
 * quiet note, not an accusation. Collapsing the two would either cry wolf on
 * every edit or hide the one failure this feature exists to catch.
 */
export function toMessageDTO(row: MessageRow, now: CorpusNow): OracleMessageDTO {
  const stale = isStale(row, now);

  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    stale,
    modelString: row.modelString,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    costUsd: row.costUsd,
    citations: checkCitations(row.citations, now.corpusText, now.sowText).map((c) => ({
      quote: c.quote,
      status: c.verified ? 'verified' : stale ? 'source-moved' : 'fabricated',
      location: c.location,
    })),
  };
}

export type ThreadRow = {
  id: string;
  title: string;
  updatedAt: Date;
  _count: { messages: number };
};

export function toThreadDTO(row: ThreadRow): OracleThreadDTO {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    messageCount: row._count.messages,
  };
}

/**
 * Roughly how much of the model's attention this thread is already using.
 *
 * Characters over four is the usual rule of thumb and is plenty here: this
 * drives a suggestion to start a new thread, not a limit. There is deliberately
 * no cap — the corpus and every prior turn are replayed in full, and cutting a
 * conversation off mid-investigation to save tokens would be the wrong trade
 * for the person trying to understand a document.
 */
export function estimateThreadTokens(messages: Pick<MessageRow, 'content'>[]): number {
  return Math.round(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}

/** Past this, the UI suggests starting a fresh thread. A nudge, not a limit. */
export const THREAD_NUDGE_TOKENS = 24_000;

/** Re-exported so the transcript renders exactly what the checker verified. */
export function renderSegments(content: string): AnswerSegment[] {
  return splitAnswer(content);
}
