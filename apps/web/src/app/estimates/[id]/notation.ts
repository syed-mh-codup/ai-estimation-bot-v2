/**
 * Every mark this screen can draw, written down once. AEH-377.
 *
 * This is the reference sheet, and it is deliberately the THIRD thing that
 * explains a mark rather than the first. The marks answer for themselves where
 * you meet them (`Mark.tsx`), the row above the ledger says which ones this
 * estimate carries and how many (`MarkFilter.tsx`), and this is for the person
 * who wants the whole vocabulary at once — reading up before a client call,
 * or arriving at the screen for the first time.
 *
 * The ordering is the point of it. Grouped by the QUESTION each mark answers,
 * because a flat alphabetical list of fourteen glyphs is a lookup table, and a
 * lookup table demands a round trip — notice a mark, leave the row, match a
 * shape against entries that differ only by hue, come back, find the row
 * again — long enough that people stop making it. Grouped by question you can
 * arrive from the question you actually have.
 *
 * Data rather than markup so it is assertable: `notation.test.ts` holds the
 * sheet to `MARK_KEYS`, which is the drift that would otherwise happen quietly
 * — a mark added to the ledger and never written down here.
 */
import type { MarkKey } from './marks';

/**
 * How an entry draws its own example.
 *
 * A sample rather than a description of a sample: "a bronze chip reading
 * Inferred" is a sentence you have to render in your head and then match
 * against the screen, and the matching is the step that fails.
 */
export type NotationSample =
  /** A micro-chip, in the neutral tone or the process one. */
  | { kind: 'chip'; tone: 'neutral' | 'bronze'; text: string }
  /** The small capitalised word a row carries beside its description. */
  | { kind: 'word'; text: string }
  /** A card's margin line — phase, category, the preset it matched. */
  | { kind: 'meta'; text: string }
  /** A line's quieter margin line — the complexity it was priced at. */
  | { kind: 'envelope'; text: string }
  /** The buffer hint and the figure it produced, which is the point of it. */
  | { kind: 'buffered' }
  /** The dash a role column draws instead of a zero. */
  | { kind: 'dash' }
  /** The BE and FE pair, one on and one off. */
  | { kind: 'side' }
  /** The diagonal hatching over a switched-off row. */
  | { kind: 'hatch' }
  /** The bronze rule in the margin of an inferred card. */
  | { kind: 'bronzeRule' }
  /** The green ring round a ticked row. */
  | { kind: 'ring' }
  /** All three fork margin rules together — they only mean anything as a set. */
  | { kind: 'forkRules' }
  /** The padlock at its three weights. */
  | { kind: 'locks' };

export type NotationEntry = {
  /**
   * The filter chip this documents, where there is one.
   *
   * It is what lets the sheet say "3 in this estimate" beside an entry and
   * take you to them, so the reference is a way INTO the ledger rather than a
   * dead end. Entries without one describe row treatments and figures, which
   * are not card-scoped and so cannot be counted or filtered.
   */
  mark?: MarkKey;
  sample: NotationSample;
  /** The one-line answer. */
  meaning: string;
  /** Why it is drawn that way, or what follows from it. */
  note: string;
};

export type NotationGroup = { question: string; entries: NotationEntry[] };

/**
 * How to read one row, in the order you meet it.
 *
 * Four beats and no more. This is the only walkthrough on the screen, and it
 * is about the NOTATION rather than the layout — that distinction is the whole
 * reason it exists. A tour of the layout teaches where things are, which
 * changes; six tickets moved something on this screen in a fortnight, and a
 * tour written against any one of them would now be lying. The notation is
 * stable, worth learning once, and useless to rediscover on every estimate.
 */
export const BEATS: { title: string; body: string }[] = [
  {
    title: 'A card is one piece of work',
    body: 'Its four columns are the roles that do it. Every figure on this screen is hours.',
  },
  {
    title: 'The marks beside the title say where it came from',
    body: 'A word or a shape, never a colour on its own. Click any one of them and it explains itself, and offers to show you the others like it.',
  },
  {
    title: 'You type base hours, and the buffer is added for you',
    body: 'A figure drawn in green is one a buffer has already changed. Correcting it upwards charges for the same uncertainty twice.',
  },
  {
    title: 'The total counts only what is switched on',
    body: 'A switched-off card keeps its hours and stays on the page, so it can come back without being re-estimated.',
  },
];

export const NOTATION: NotationGroup[] = [
  {
    question: 'Is this work in the estimate?',
    entries: [
      {
        mark: 'off',
        sample: { kind: 'chip', tone: 'neutral', text: 'Off' },
        meaning: 'Priced and kept, but not counted in the total.',
        note: 'The hours stay on the card so it can be switched back on without being re-estimated, and the roll-up reports them separately — a total never quietly carries work somebody took out.',
      },
      {
        sample: { kind: 'hatch' },
        meaning: 'The row treatment for a switched-off card.',
        note: 'The same state said three times, deliberately: the chip survives greyscale, the hatching is readable at a glance down a long ledger, and the struck-through title still works when the row is too narrow for either.',
      },
      {
        sample: { kind: 'chip', tone: 'neutral', text: 'Load bearing' },
        meaning: 'Cannot be switched off — other scope in this estimate depends on it.',
        note: 'Switching a card back on is never gated. The judgment is about removing something others stand on, not about adding it.',
      },
      {
        sample: { kind: 'chip', tone: 'neutral', text: 'Slice' },
        meaning: 'On the thin slice — the earliest path to something demoable.',
        note: 'Set by the crew rather than by you. It is how a phase-one cut gets proposed: fork the estimate, switch off everything without this mark, and read the new total.',
      },
    ],
  },
  {
    question: 'Where did it come from?',
    entries: [
      {
        mark: 'inferred',
        sample: { kind: 'chip', tone: 'bronze', text: 'Inferred' },
        meaning: 'Implied by the brief rather than stated in it, and costed anyway.',
        note: 'These hours are as real and as buffered as any other, and they are inside the headline total. The roll-up also reports them on their own line, because it is worth knowing how much of a number nobody asked for before defending it.',
      },
      {
        sample: { kind: 'bronzeRule' },
        meaning: 'The row treatment for an inferred card.',
        note: 'A rule in the margin rather than a tint, so a run’s inferred cards read as a group without any one of them shouting — and so it can sit alongside the hatching, which the same card can also carry.',
      },
      {
        mark: 'edited',
        sample: { kind: 'word', text: 'edited' },
        meaning: 'Somebody set these hours or this wording by hand.',
        note: 'No word at all means the figure is the council’s own, untouched.',
      },
      {
        sample: { kind: 'word', text: 'steered' },
        meaning: 'The council re-priced the line, inside an edit a person asked for.',
        note: 'Kept distinct from edited on purpose: reading a steered row as hand-typed understates how it was costed, and reading it as the council’s own hides that somebody asked for it.',
      },
      {
        sample: { kind: 'meta', text: 'matched PRE-12 · 0.81' },
        meaning: 'Priced against a job already delivered, and how close the match was.',
        note: 'The phase, the category and the historical preset the card was anchored to all sit in the same margin line.',
      },
      {
        mark: 'unmatched',
        sample: { kind: 'chip', tone: 'neutral', text: 'No match' },
        meaning: 'Priced with no historical anchor at all.',
        note: 'The hours came from reasoning rather than from work you have actually delivered, which is worth knowing before defending them. Delivery-overhead cards are priced as a percentage of other cards and never had a preset to match, so they are left out of this count.',
      },
      {
        sample: { kind: 'envelope', text: 'moderate · ai-assisted' },
        meaning: 'The complexity a line was priced at, and whether its hours are already discounted.',
        note: 'The second half is the one that matters: the figure in the box has already been reduced for AI-assisted delivery, so correcting it upwards takes the discount off twice.',
      },
      {
        mark: 'amended',
        sample: { kind: 'forkRules' },
        meaning:
          'On a fork only. Green is carried over and signed off, solid grey is carried over unchanged, broken grey came across and has moved since.',
        note: 'Meant to be read down the margin rather than across. Where the rule runs unbroken this estimate matches the one it was forked from; where it breaks is where the new work entered.',
      },
    ],
  },
  {
    question: 'Can I change it?',
    entries: [
      {
        sample: { kind: 'ring' },
        meaning: 'Ticked for the next AI edit.',
        note: 'You declare what may change, and nothing typed into the instruction can widen it — the tick and the role chips together are the boundary, and the bar at the foot of the ledger says how many lines it covers before you commit. A ring rather than a tint because the hatching and the bronze rule already claim the row’s background.',
      },
      {
        mark: 'locked',
        sample: { kind: 'locks' },
        meaning: 'Frozen, and how much of the card is: open, part bronze, solid bronze.',
        note: 'A lock settles a line’s hours, its wording and its existence, for people and for the AI alike. It sits at three scopes — one line, one role on one card, or one role across every card, which is what the padlock in a column heading does. It does not stop a card being switched in or out, because that changes neither the hours nor the wording.',
      },
    ],
  },
  {
    question: 'What is this number?',
    entries: [
      {
        sample: { kind: 'buffered' },
        meaning: 'A buffered figure. You type base hours; a role’s buffer is added for you.',
        note: 'QA carries a regression buffer and PM and BA a communications one. DEV carries none, because the complexity multiplier is already applied to it and a buffer on top would charge twice for the same uncertainty. The percentages sit in the column headings, where they can be changed per estimate.',
      },
      {
        mark: 'stale',
        sample: { kind: 'chip', tone: 'bronze', text: 'Stale' },
        meaning: 'Costed against buffers that have since moved.',
        note: 'A delivery-overhead card is a percentage of hours that have changed underneath it. Said rather than silently corrected: nothing on the card separates a generated figure from an estimator’s edit, so recomputing would discard real decisions. A re-run rebuilds them at the current rates.',
      },
      {
        sample: { kind: 'side' },
        meaning: 'Which side of the stack a DEV line is on. Green is on, and a line can be neither, either or both.',
        note: 'It does not split the hours, which is why it sits beside the description rather than beside the figure. Untagged is not an error — most rows predate tagging — but it costs precision when this estimate feeds the preset library.',
      },
      {
        sample: { kind: 'dash' },
        meaning: 'No hours for that role.',
        note: 'Zero, drawn as a dash so the column reads as a column. A literal 0 would sit in the digit rhythm and have to be read before it could be dismissed.',
      },
    ],
  },
];

/** The rule the whole sheet is built on, worth saying out loud at the end of it. */
export const NOTATION_CLOSING =
  'Colour never travels alone on this screen. Every mark carries a word or a shape as well, so an estimate survives being printed in greyscale, screenshotted, or read by somebody who cannot tell bronze from green.';
