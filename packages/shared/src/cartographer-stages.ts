/**
 * The stages a Cartographer derivation goes through. AEH-235.
 *
 * In `shared` rather than beside the agent, for the reason the graph walks are:
 * the browser needs them to render the progress track, and anything imported
 * from `@repo/agents` drags `@repo/db` and the Prisma client into the client
 * bundle — which fails at webpack, not at `tsc`. One list, read by the agent
 * that reports the stages and the component that draws them, so a renamed stage
 * cannot desync the track.
 *
 * ## What these percentages do and do not claim
 *
 * The boundaries are real: each stage begins when the work it names begins.
 * `asking` owns most of the span because it owns most of the time — one model
 * call over the whole menu card.
 *
 * That call is indivisible, so nothing here pretends to know how far THROUGH it
 * we are. The bar sits at the start of `asking` for the duration. What moves is
 * the count of dependencies seen in the response so far, read off the stream —
 * a counted number rather than an interpolation, which is the only reason it is
 * worth showing instead of a spinner.
 */
export const CARTOGRAPHER_STAGES = [
  { key: 'reading', name: 'Reading the menu card', from: 0 },
  { key: 'asking', name: 'Working out dependencies', from: 10 },
  { key: 'checking', name: 'Checking for cycles', from: 80 },
  { key: 'saving', name: 'Saving', from: 92 },
] as const;

export type CartographerStageKey = (typeof CARTOGRAPHER_STAGES)[number]['key'];

export type CartographerProgress = {
  stage: CartographerStageKey;
  /** Human-readable, for the status line. */
  label: string;
  pct: number;
  /** Cards on the menu card — the denominator worth knowing. */
  cards?: number;
  /** Dependencies seen in the response so far. Counted, never estimated. */
  edgesFound?: number;
};
