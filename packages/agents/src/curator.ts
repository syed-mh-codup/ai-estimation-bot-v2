import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import { CategorySchema } from '@repo/shared';

import { chatJSON } from './llm-json';
import { CALL_TIMEOUTS, callTuning, type ModelCallLevers } from './model-call';
import type { UsageRecorder } from './usage-recorder';

/**
 * The Curator — deciding what belongs together on a card. AEH-238.
 *
 * Runs when somebody asks for a card to be split or several merged. It decides
 * SHAPE and nothing else: which cards should exist afterwards, and which of the
 * existing lines belongs to each.
 *
 * It never proposes an hour, and that separation is the point rather than a
 * simplification. Cutting a module in two re-conceives the work, so the hours
 * have to move — but they move because the specialist council re-prices the
 * result against the requirement, not because a structural pass guessed. A
 * number invented here would compete with one that was reasoned, which is the
 * habit `costIt` and the four-hour rule have both been used to remove.
 *
 * Its own agent kind rather than the Architect's, because the Architect
 * assembles cards from a whole run's specialist output — a different input and a
 * different question. See the CURATOR entry in `agent-catalogue.ts`.
 */

/** One card the Curator proposes, in its own numbering. */
const LLMCuratedCardSchema = z.object({
  ref: z.number().int().min(1),
  title: z.string().min(1),
  /** Carried forward unless the split genuinely changes what the card is. */
  taxonomyKey: z.string().optional(),
  category: z.string().optional(),
  phase: z.enum(['Foundation', 'Core', 'Enhancement']).optional(),
  /** Line numbers from the list it was shown. */
  lines: z.array(z.number().int().min(1)).default([]),
});

const LLMCuratorSchema = z.object({
  cards: z.array(LLMCuratedCardSchema).min(1),
  notes: z.string().optional(),
});

export type CuratorContext = {
  modelProvider: IModelProvider;
  modelString: string;
  /** The admin-authored, versioned CURATOR prompt body. */
  instructions: string;
  recorder: UsageRecorder;
  levers?: ModelCallLevers | undefined;
};

/** One line the Curator may move, as it is shown to it. */
export type CuratableLine = {
  lineItemId: string;
  role: string;
  description: string;
  hours: number;
};

/** One card being restructured. */
export type CuratableCard = {
  menuItemId: string;
  title: string;
  taxonomyKey: string;
  category: string | null;
  phase: string | null;
  lines: CuratableLine[];
};

/** A card the Curator decided should exist, resolved to real ids. */
export type CuratedCard = {
  /** Set when this card should reuse an existing row rather than be created. */
  reuseMenuItemId: string | null;
  title: string;
  taxonomyKey: string;
  category: string | null;
  phase: string | null;
  /** Existing line items assigned here. */
  lineItemIds: string[];
};

export type CuratorOutput = {
  cards: CuratedCard[];
  /** What it says it did. Recorded as the edit's reasoning. */
  notes: string | null;
};

function buildUserMessage(args: {
  cards: CuratableCard[];
  instruction: string;
  ledgerContext: string;
  /** 1-based line number -> the line, in the order shown. */
  numbered: CuratableLine[];
}): string {
  const { cards, instruction, ledgerContext, numbered } = args;
  const cardBlocks = cards
    .map(
      (c) =>
        `Card "${c.title}" (taxonomyKey=${c.taxonomyKey}, category=${
          c.category ?? 'none'
        }, phase=${c.phase ?? 'none'})`,
    )
    .join('\n');
  const lineBlocks = numbered
    .map((l, i) => `${i + 1}. [${l.role}] ${l.hours}h — ${l.description}`)
    .join('\n');

  return `Restructure the following work.

${cardBlocks}

Its line items, numbered:
${lineBlocks}

The estimator's instruction:

${instruction}

The rest of this estimate, for context. You are NOT reshaping any of it — it is here so you do not create a card that duplicates one which already exists:
${ledgerContext}

Every one of the ${numbered.length} lines above must appear exactly once across your cards.`;
}

/**
 * Decide the shape, and resolve it against the cards that actually exist.
 *
 * Two pieces of validation are done here rather than trusted to the prompt,
 * because both failures are silent:
 *
 * A line the model left out would be work quietly disappearing from the
 * estimate, and a line it listed twice would be work counted twice. Anything
 * unassigned lands on the first card, and a duplicate is kept only on its first
 * mention.
 *
 * A card's reuse is decided HERE, not by the model: the proposal whose line set
 * most overlaps an original card inherits that card's row, so a split keeps one
 * real card and adds the rest. That means a card's id — and everything pointing
 * at it — survives a restructure wherever it honestly can.
 */
export async function runCurator(
  args: { cards: CuratableCard[]; instruction: string; ledgerContext: string },
  ctx: CuratorContext,
): Promise<CuratorOutput> {
  const numbered = args.cards.flatMap((c) => c.lines);
  if (numbered.length === 0) {
    return { cards: [], notes: 'Nothing to restructure — these cards have no line items.' };
  }

  const parsed = await chatJSON(
    ctx.modelProvider,
    {
      model: ctx.modelString,
      messages: [
        { role: 'system', content: ctx.instructions },
        { role: 'user', content: buildUserMessage({ ...args, numbered }) },
      ],
      temperature: 0,
      ...callTuning(ctx.levers, CALL_TIMEOUTS.single),
    },
    LLMCuratorSchema,
    'Curator',
    { kind: 'CURATOR', recorder: ctx.recorder },
  );

  // Assign lines, dropping duplicates and collecting anything left out.
  const claimed = new Set<number>();
  const assignments = parsed.cards.map((card) => {
    const mine: string[] = [];
    for (const n of card.lines) {
      const line = numbered[n - 1];
      if (!line || claimed.has(n)) continue;
      claimed.add(n);
      mine.push(line.lineItemId);
    }
    return { card, lineItemIds: mine };
  });

  const orphaned = numbered
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(({ n }) => !claimed.has(n))
    .map(({ l }) => l.lineItemId);
  if (orphaned.length > 0 && assignments[0]) {
    // Work that would otherwise vanish. The first card is an arbitrary home,
    // and deliberately so: losing a line is a real error, putting it in a
    // slightly wrong place is a tidy-up a person can see and fix.
    assignments[0].lineItemIds.push(...orphaned);
  }

  // Which original card each proposal should reuse: the one it took most of its
  // lines from, each original claimed at most once.
  const originalOf = new Map<string, string>();
  for (const c of args.cards) for (const l of c.lines) originalOf.set(l.lineItemId, c.menuItemId);
  const takenOriginals = new Set<string>();

  // Keyed by the assignment's INDEX, not by the model's `ref`.
  //
  // `ref` is the model's own numbering and the schema does not make it unique:
  // two proposals may both call themselves 1. Keyed by ref, the second write
  // overwrote the first, both proposals then read the same `reuseMenuItemId`,
  // every line landed on one card, and the original the first proposal should
  // have reused was left line-less and deleted by `applyRestructure`. A split
  // silently became a merge that lost a card.
  const indexOf = new Map(assignments.map((a, i) => [a, i]));
  const ranked = [...assignments].sort((a, b) => b.lineItemIds.length - a.lineItemIds.length);
  const reuseFor = new Map<number, string | null>();
  for (const a of ranked) {
    const counts = new Map<string, number>();
    for (const id of a.lineItemIds) {
      const origin = originalOf.get(id);
      if (origin) counts.set(origin, (counts.get(origin) ?? 0) + 1);
    }
    const best = [...counts.entries()]
      .filter(([id]) => !takenOriginals.has(id))
      .sort((x, y) => y[1] - x[1])[0];
    if (best) {
      takenOriginals.add(best[0]);
      reuseFor.set(indexOf.get(a)!, best[0]);
    } else {
      reuseFor.set(indexOf.get(a)!, null);
    }
  }

  const source = args.cards[0]!;
  const cards: CuratedCard[] = assignments.map(({ card, lineItemIds }, index) => {
    const reuseMenuItemId = reuseFor.get(index) ?? null;
    const inherited = args.cards.find((c) => c.menuItemId === reuseMenuItemId) ?? source;
    return {
      reuseMenuItemId,
      title: card.title.trim() || inherited.title,
      taxonomyKey: card.taxonomyKey?.trim() || inherited.taxonomyKey,
      // `CategorySchema` is a non-empty string, not a controlled vocabulary —
      // worth saying, because the name suggests otherwise. So this only rejects
      // blank and missing values, falling back to what the card already had.
      // That is the useful guarantee available: a card whose category the model
      // omitted keeps the one it was given rather than losing it.
      category: CategorySchema.safeParse(card.category).success
        ? (card.category ?? null)
        : inherited.category,
      phase: card.phase ?? inherited.phase,
      lineItemIds,
    };
  });

  return { cards, notes: parsed.notes?.trim() || null };
}
