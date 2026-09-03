import { replaceEstimateGraph, type PrismaClient } from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import {
  CARTOGRAPHER_STAGES,
  CartographerOutputSchema,
  type CartographerOutput,
  type CartographerProgress,
  type Requirement,
} from '@repo/shared';

import { streamJSON } from './llm-json';
import { createUsageRecorder } from './usage-recorder';

/**
 * The Cartographer — works out which of one estimate's cards depend on which.
 * AEH-235.
 *
 * On demand, never part of a run. It uses a heavy model and most estimates are
 * never configured, so deriving a graph on every run would spend real money on
 * estimates nobody ever cuts scope from.
 *
 * ## Why this reads the estimate and not the preset library
 *
 * Dependencies are a property of the project being built. The preset library
 * records what past work needed, but every project is different, so one
 * project's ordering is not evidence about another's — and in any case only 12
 * of 140 cards in this system carry a `sourcePresetId`, so there is nothing to
 * look up for the overwhelming majority of work. The graph is worked out for
 * THIS estimate, from what this estimate actually contains.
 *
 * ## Why it does not reuse Oracle's corpus
 *
 * `buildOracleCorpus` looks like the right input and is not. It omits
 * `MenuItem.id`, so there would be no stable handle to map an edge back onto a
 * card, and its own `@todo` marks it as the seam Oracle's retrieval work will
 * change — coupling a second agent to it means Oracle's future chunking
 * silently alters what this one sees. A dedicated builder also drops `sowText`
 * and per-line-item detail that a graph task has no use for.
 */

export type ScopeCorpusCard = {
  /** 1-based position in the list shown to the model. */
  number: number;
  menuItemId: string;
  title: string;
  taxonomyKey: string;
  phase: string | null;
  category: string | null;
  taxedHours: number;
  /** The requirements this card was costed against, in the SOW's own words. */
  requirementTexts: string[];
};

export type ScopeCorpus = {
  estimateId: string;
  title: string;
  cards: ScopeCorpusCard[];
};

/**
 * Assemble what the Cartographer needs to see.
 *
 * Injected cards are excluded. Process overhead and hidden-work placeholders
 * are real cost but they are not scope anybody chooses, they are not on the
 * configurator's menu, and letting the model draw edges to them would produce
 * dependencies on work that cannot be toggled.
 *
 * Returns null when there is nothing to map — no estimate, or no real cards.
 */
export async function buildScopeCorpus(
  db: PrismaClient,
  estimateId: string,
): Promise<ScopeCorpus | null> {
  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    select: {
      id: true,
      title: true,
      agentState: true,
      menuItems: {
        where: { injected: false },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          title: true,
          taxonomyKey: true,
          phase: true,
          category: true,
          meta: true,
          lineItems: { select: { taxedHours: true } },
        },
      },
    },
  });
  if (!estimate || estimate.menuItems.length === 0) return null;

  // Requirement text is the difference between "Notifications" and "email the
  // buyer when an order ships" — a card title alone is often too terse to judge
  // ordering from. Sourced the same way Oracle sources it, and tolerated as
  // absent: an estimate whose run predates this still has to be mappable.
  const state = (estimate.agentState ?? {}) as Record<string, unknown>;
  const librarian = state['librarianOutput'] as { requirements?: Requirement[] } | undefined;
  const requirementById = new Map((librarian?.requirements ?? []).map((r) => [r.id, r.text]));

  const cards: ScopeCorpusCard[] = estimate.menuItems.map((m, i) => {
    const meta = (m.meta ?? {}) as { requirementIds?: string[] };
    return {
      number: i + 1,
      menuItemId: m.id,
      title: m.title,
      taxonomyKey: m.taxonomyKey,
      phase: m.phase,
      category: m.category,
      taxedHours: m.lineItems.reduce((sum, li) => sum + li.taxedHours, 0),
      requirementTexts: (meta.requirementIds ?? [])
        .map((id) => requirementById.get(id))
        .filter((t): t is string => typeof t === 'string' && t.length > 0),
    };
  });

  return { estimateId: estimate.id, title: estimate.title, cards };
}

/** Render the corpus as the numbered list the prompt's contract refers to. */
export function renderScopeCorpus(corpus: ScopeCorpus): string {
  const lines = corpus.cards.map((c) => {
    const bits = [c.taxonomyKey];
    if (c.category) bits.push(c.category);
    if (c.phase) bits.push(`phase ${c.phase}`);
    bits.push(`${c.taxedHours.toFixed(1)}h`);
    const head = `${c.number}. ${c.title} [${bits.join(' · ')}]`;
    if (c.requirementTexts.length === 0) return head;
    return `${head}\n   asked for: ${c.requirementTexts.join(' | ')}`;
  });

  return [
    `Estimate: ${corpus.title}`,
    `${corpus.cards.length} cards.`,
    '',
    lines.join('\n'),
  ].join('\n');
}

export type CartographerResult = {
  /** Edges accepted and stored. */
  written: number;
  /** Hand-authored edges left exactly as they were. */
  preserved: number;
  /** Proposed and refused, with the reason — reported, never silent. */
  rejected: Array<{ reason: string; detail: string }>;
  /** Cards marked always-included. */
  foundation: string[];
  notes: string;
};

/**
 * Derive and store an estimate's dependency graph.
 *
 * The model's output is a proposal, not a result. Everything it returns is
 * resolved against the cards that actually exist and then put through the same
 * three guards as a hand-authored graph — unknown card, self-edge, cycle — by
 * `replaceEstimateGraph`. Two paths into one validator, so a derived graph and
 * a typed one cannot end up held to different standards.
 *
 * Replaces the DERIVED half of the graph. Hand-authored edges are preserved and
 * take precedence — a derived edge that would contradict one is refused. Saved
 * configurations are untouched: their picks reference cards, not edges, so they
 * survive, though what a pick drags in naturally changes with the graph.
 */
export async function runCartographer(args: {
  db: PrismaClient;
  estimateId: string;
  modelProvider: IModelProvider;
  prompt: { body: string; modelString: string };
  /** Called as the work advances. Optional: tests and scripts ignore it. */
  onProgress?: (p: CartographerProgress) => void;
}): Promise<CartographerResult> {
  const { db, estimateId, modelProvider, prompt, onProgress } = args;

  const report = (
    stage: CartographerProgress['stage'],
    extra: Omit<CartographerProgress, 'stage' | 'label' | 'pct'> = {},
  ): void => {
    const meta = CARTOGRAPHER_STAGES.find((st) => st.key === stage)!;
    onProgress?.({ stage, label: meta.name, pct: meta.from, ...extra });
  };

  report('reading');
  const corpus = await buildScopeCorpus(db, estimateId);
  if (!corpus) {
    throw new Error('Nothing to map: this estimate has no menu card yet.');
  }

  report('asking', { cards: corpus.cards.length, edgesFound: 0 });
  const recorder = createUsageRecorder({ db, estimateId });
  const output: CartographerOutput = await streamJSON(
    modelProvider,
    {
      model: prompt.modelString,
      messages: [
        { role: 'system', content: prompt.body },
        { role: 'user', content: renderScopeCorpus(corpus) },
      ],
      // Zero, like every other structured agent here. A dependency graph is a
      // reading of the scope, not a creative act, and the same menu card should
      // produce the same graph twice.
      temperature: 0,
    },
    CartographerOutputSchema,
    'CARTOGRAPHER',
    { kind: 'CARTOGRAPHER', recorder },
    (accumulated) => {
      // Counted off the partial response rather than interpolated. Every edge
      // object carries exactly one `"dependent"` key, so the occurrences are
      // the edges emitted so far — a real number, which is the whole point of
      // showing it instead of a guessed percentage.
      report('asking', {
        cards: corpus.cards.length,
        edgesFound: countOccurrences(accumulated, '"dependent"'),
      });
    },
  );

  report('checking', { cards: corpus.cards.length, edgesFound: output.edges.length });

  const byNumber = new Map(corpus.cards.map((c) => [c.number, c]));
  const rejected: CartographerResult['rejected'] = [];

  const edges = output.edges.flatMap((e) => {
    const dependent = byNumber.get(e.dependent);
    const prerequisite = byNumber.get(e.prerequisite);
    // A number outside the list is the model inventing a card. Dropped here
    // rather than passed on, because `replaceEstimateGraph` would only be able
    // to report an unresolvable id, not the number that caused it.
    if (!dependent || !prerequisite) {
      rejected.push({
        reason: 'UNKNOWN_CARD',
        detail: `no card ${!dependent ? e.dependent : e.prerequisite} in this estimate`,
      });
      return [];
    }
    return [
      {
        dependentId: dependent.menuItemId,
        prerequisiteId: prerequisite.menuItemId,
        note: e.why.trim() || null,
      },
    ];
  });

  report('saving', { cards: corpus.cards.length, edgesFound: edges.length });
  // Hand-authored edges survive. Re-deriving supersedes the machine's previous
  // reading, not somebody's typed-in knowledge — and because preserved edges
  // are seeded first, a derived edge that would contradict one is refused
  // rather than overriding it.
  const result = await replaceEstimateGraph(db, estimateId, edges, 'INFERRED', {
    preserve: ['MANUAL'],
  });
  const titleOf = new Map(corpus.cards.map((c) => [c.menuItemId, c.title]));
  for (const r of result.rejected) {
    rejected.push({
      reason: r.reason,
      detail: `${titleOf.get(r.dependentId) ?? r.dependentId} → ${
        titleOf.get(r.prerequisiteId) ?? r.prerequisiteId
      }`,
    });
  }

  // Foundation is a flag on the card, so it is set separately from the edges.
  // Every non-foundation card is cleared as well as the named ones set: this
  // action is "work out the whole graph", and leaving a stale always-included
  // flag behind would silently make a card unremovable for reasons no longer
  // recorded anywhere.
  const foundationIds = output.foundation
    .map((n) => byNumber.get(n)?.menuItemId)
    .filter((id): id is string => id !== undefined);

  await db.$transaction([
    db.menuItem.updateMany({
      where: { estimateId, injected: false },
      data: { foundation: false },
    }),
    ...(foundationIds.length > 0
      ? [db.menuItem.updateMany({ where: { id: { in: foundationIds } }, data: { foundation: true } })]
      : []),
  ]);

  return {
    written: result.written.length,
    preserved: result.preserved,
    rejected,
    foundation: foundationIds,
    notes: output.notes.trim(),
  };
}

/** Non-overlapping occurrences of `needle`. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}
