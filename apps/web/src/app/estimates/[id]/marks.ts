/**
 * What a card is marked with, and how many cards carry each mark. AEH-377.
 *
 * A module of its own rather than more of `dto.ts`, because this is the one
 * vocabulary three very different surfaces have to agree on — the chips above
 * the ledger, the dimming of the rows below them, and the reference sheet that
 * explains both. A chip reading "3" that dims all but two cards is a bug nobody
 * would report and everybody would quietly distrust, so both read `cardMarks`
 * and neither re-derives anything.
 *
 * Pure and free of React on purpose: the arithmetic is directly assertable,
 * which is the only way this gets tested at all — the ledger's interactive half
 * is reachable only through Playwright. Same reasoning as `retaxRole`.
 */
import type { ItemDTO } from './dto';

/**
 * The marks, in the order they are offered above the ledger: what the crew
 * added to the brief first, then what has moved since, then what is frozen,
 * then what is merely unusual, and last the work that is not in the total.
 *
 * `ticked` is deliberately absent. It is transient selection state, the green
 * ring already draws it on the row, and `EditBar` already counts it — a filter
 * for "what did I just click" would be a fourth way of saying the same thing.
 *
 * `thinSlice` and `notSafelyRemovable` are absent for a blunter reason: the
 * preset graph has no edges, so `notSafelyRemovable` is false on every card
 * that exists today (AEH-314), and a chip whose count is always zero is worse
 * than no chip at all. Add them here when that lands.
 */
export const MARK_KEYS = [
  'inferred',
  'amended',
  'edited',
  'locked',
  'unmatched',
  'stale',
  'off',
] as const;

export type MarkKey = (typeof MARK_KEYS)[number];

/** What each chip says. */
export const MARK_LABEL: Record<MarkKey, string> = {
  inferred: 'Inferred',
  amended: 'Changed since the fork',
  edited: 'Edited by hand',
  locked: 'Locked',
  unmatched: 'No preset match',
  stale: 'Stale',
  off: 'Switched off',
};

/** And what it means — the sentence the tooltip could never be trusted to carry. */
export const MARK_STORY: Record<MarkKey, string> = {
  inferred: 'Implied by the brief rather than stated in it, and costed anyway.',
  amended: 'Came from the estimate this was forked from, and has moved since.',
  edited: 'Somebody set these hours or this wording by hand.',
  locked: 'Frozen — the hours, the description and the row itself are settled.',
  unmatched:
    'Priced with no historical match, so the hours came from reasoning rather than from work already delivered.',
  stale: 'Costed against buffers that have since changed. A re-run rebuilds it.',
  off: 'Priced and kept, but not counted in the total.',
};

/**
 * The 9.5px chip a mark is drawn in, and the same chip in the process tone.
 *
 * Here rather than beside the ledger that draws them because the reference
 * sheet draws them too, and a reference whose samples have drifted from the
 * screen they describe is worse than no reference: it teaches you to match a
 * shape that is not there any more. Neutral is the default on purpose — these
 * chips say what a card IS, not that anything is wrong with it, and the colour
 * contract reserves tone for state (green settles, bronze is in flight).
 */
export const MICRO_CHIP =
  'shrink-0 rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] text-ink-3 uppercase';

/** The same chip in the process tone, for the two marks that are about a run. */
export const BRONZE_CHIP =
  'shrink-0 rounded border border-bronze-line bg-bronze-tint px-1 text-[9.5px] font-bold tracking-[0.07em] text-bronze-ink uppercase';

/** What `cardMarks` needs that a card cannot tell you by itself. */
export type MarkContext = {
  /** A buffer moved after the delivery-overhead cards were generated. */
  overheadStale: boolean;
  /** Every frozen line on the estimate, by id. */
  lockedLineIds: ReadonlySet<string>;
};

/**
 * Every mark one card carries.
 *
 * Card-scoped even where the underlying fact is per-row, because that is the
 * unit the ledger lays out: a card holding one amended line is a card you want
 * to see when you ask to see amended work, and dimming half a card would be
 * meaningless.
 */
export function cardMarks(item: ItemDTO, ctx: MarkContext): MarkKey[] {
  const marks: MarkKey[] = [];
  if (item.injected) marks.push('inferred');
  if (item.lineItems.some((li) => li.carried === 'amended')) marks.push('amended');
  if (item.lineItems.some((li) => li.provenance !== 'CREW')) marks.push('edited');
  if (item.lineItems.some((li) => ctx.lockedLineIds.has(li.id))) marks.push('locked');
  // Overhead cards are excluded from "unmatched", not counted as a gap. Their
  // hours are a percentage OF other cards by construction, so they never had a
  // preset to anchor to and reporting them as unanchored would name a problem
  // that does not exist. AEH-335 explains where those cards come from.
  if (!item.overhead && item.sourcePresetId === null) marks.push('unmatched');
  if (item.overhead && ctx.overheadStale) marks.push('stale');
  if (!item.enabled) marks.push('off');
  return marks;
}

/**
 * How many cards carry each mark — and only the marks something actually
 * carries.
 *
 * The absent keys are the whole point. This row has to read as a summary of
 * what is unusual about THIS estimate before it reads as a filter, and a chip
 * saying "Stale 0" on every estimate that has never moved a buffer is noise
 * that trains people to stop reading the row.
 */
export function markCounts(items: ItemDTO[], ctx: MarkContext): Partial<Record<MarkKey, number>> {
  const counts: Partial<Record<MarkKey, number>> = {};
  for (const item of items) {
    for (const mark of cardMarks(item, ctx)) {
      counts[mark] = (counts[mark] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Should this card be dimmed while `active` is being looked at?
 *
 * Named rather than inlined so the "nothing picked dims nothing" case is stated
 * once. Getting that backwards would grey out the entire ledger on first paint,
 * which is exactly the sort of thing that looks deliberate in a screenshot.
 */
export function isDimmed(item: ItemDTO, active: MarkKey | null, ctx: MarkContext): boolean {
  if (active === null) return false;
  return !cardMarks(item, ctx).includes(active);
}
