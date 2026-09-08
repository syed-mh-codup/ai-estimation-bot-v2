/**
 * The per-call levers that decide whether a chosen model can actually finish.
 *
 * `modelString` has been data for a while: it lives on `PromptVersion` and on
 * `ArtifactTypeVersion`, and an admin picks it from a live OpenRouter
 * catalogue. Every parameter deciding whether the picked model FITS was still
 * code, hardcoded in this package — which is how an admin could select a
 * reasoning model from a dropdown and then have no way, short of a deploy, to
 * change the one setting that determines whether it lands inside the function's
 * ceiling. That is AEH-322, and this module is its seam.
 *
 * Two of the three levers are data, because they are coupled to the model
 * choice, which is already data: reasoning effort (only some models have it at
 * all) and provider sort (which upstream host OpenRouter buys from). The third,
 * the timeout, is deliberately NOT data — see CALL_TIMEOUTS.
 */
import type { ChatOptions } from '@repo/providers';

/**
 * Down, never off — and "default" means "send no reasoning field at all",
 * which is not the same as sending an off switch.
 *
 * Measured during AEH-321: the same call with reasoning explicitly DISABLED
 * hung for over nine minutes and never returned. So there is no `none` here,
 * and null means the field is omitted and the model keeps its own default
 * rather than being told to stop thinking.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

/**
 * Which upstream host OpenRouter buys from.
 *
 * `price` is spelled out rather than left implicit because it IS OpenRouter's
 * default, and an admin who has deliberately chosen the cheapest host should be
 * able to see on the page that they chose it.
 */
export type ProviderSort = 'throughput' | 'latency' | 'price';

/**
 * What an admin has chosen for one prompt version or artifact type version.
 * Null and undefined both mean "unset — leave the default alone", so a row
 * nobody has touched behaves exactly as it did before this existed.
 */
export type ModelCallLevers = {
  reasoningEffort?: ReasoningEffort | null;
  providerSort?: ProviderSort | null;
};

/**
 * Per-call wall-clock budgets, derived from the STEP they run in rather than
 * from the model they call — which is exactly why they are code and not a field
 * on the version row.
 *
 * Vercel Hobby gives a step 300s and no more. What has to fit inside that is a
 * step's WORST case, which is its per-call budget times how many attempts the
 * step is allowed. So the number an admin would have to reason about is not
 * "how long may this model take" but "how long may this model take, given how
 * many times THIS step retries, so the product still leaves room to record the
 * failure" — and a wrong answer produces a step the platform kills with no
 * readable error. That is the same silent footgun AEH-322 refuses to hand back
 * for `maxTokens`, so the timeout stays here where the retry count is visible.
 *
 * The arithmetic, per step, each landing on ~240s of the 300s and leaving ~60s
 * to write a real error:
 *
 *   librarian / detective / architect   1 attempt  x 240s = 240s
 *   specialists:<req>                   2 attempts x 120s = 240s
 *
 * The specialist figure is 2 attempts because `withRetry` defaults to
 * maxRetries=1. If that default changes, this number changes with it — they are
 * one budget expressed in two places and nothing but this comment ties them
 * together.
 */
export const CALL_TIMEOUTS = {
  /** One attempt inside its own step: Librarian, Detective, Architect. */
  single: 240_000,
  /** `withRetry` gives the specialist council two attempts inside one step. */
  retried: 120_000,
  /**
   * Best-effort and N-per-step: the Archivist's rerank runs once per
   * requirement inside a single step, and already falls back to vector order on
   * any failure, so a tight budget costs a slightly worse ordering and never a
   * failed run. (It is also unreachable in production today — nothing sets
   * `rerank: true` outside tests — which is the other reason not to let it
   * spend the step's budget.)
   */
  bestEffort: 30_000,
} as const;

/**
 * What the crew uses when an admin has chosen nothing.
 *
 * Both halves were measured on 8 September against the model the crew actually
 * runs on, `~google/gemini-flash-latest`, with a specialist-shaped JSON call.
 * Median of three runs each:
 *
 *   default                       25.2s   1868 reasoning tokens   $0.0139
 *   reasoning effort low          13.2s      0 reasoning tokens   $0.0062
 *   provider sort throughput      12.1s   1737 reasoning tokens   $0.0129
 *   both                           4.9s      0 reasoning tokens   $0.0054
 *
 * `providerSort: 'throughput'` is set, and is worth 2.1x on its own. That was
 * the surprise: every endpoint for this model is operated by Google, so sorting
 * by throughput picks between two of Google's own front doors rather than
 * between a fast host and a slow one — and it still moves the call off `Google`
 * (Vertex) onto `Google AI Studio` and halves the wall clock. The prior guess,
 * that a single-operator model would make this lever nearly inert, was wrong.
 * It is also the lever with no cost of any kind: same model, same reasoning,
 * same output, ~$0.001 cheaper by accident.
 *
 * `reasoningEffort` is deliberately UNSET, though it is worth another 2.4x on
 * top. Turning thinking down is the biggest single lever on wall clock, but
 * here it would be turning it down on the numbers that ARE the product: across
 * those runs the same requirement decomposed into 20-22 line items with
 * thinking on and 16-19 with it low. An artifact that thinks less reads
 * slightly flatter; an estimate that thinks less bills differently. So the
 * default leaves the model alone, and the lever is per-agent on the prompt
 * editor — where whoever owns the estimate's credibility can set it on the
 * Specialists without touching the Librarian, and can compare two runs before
 * keeping it.
 */
export const CREW_DEFAULT_LEVERS: ModelCallLevers = {
  reasoningEffort: null,
  providerSort: 'throughput',
};

/**
 * Turn an admin's choices into the subset of `ChatOptions` that carries them.
 *
 * Every field is OMITTED rather than sent as undefined when unset. That matters
 * more than it looks: OpenRouter's default routing has to stay the default for
 * a caller who has not opted in, and `reasoning: undefined` is not the same
 * wire message as no `reasoning` key.
 *
 * Note what this does NOT do: gate a lever on whether the model supports it.
 * Measured against the live API — `reasoning: { effort: 'low' }` sent to
 * `openai/gpt-4o-mini`, which does not advertise `reasoning` in its
 * `supported_parameters`, returns a normal completion with the field silently
 * ignored. An unsupported lever is inert, not an error, so the honest place to
 * stop it is the editor that offers it and the save that stores it, both of
 * which know the catalogue — not here, where a run would have to reach
 * OpenRouter's model feed mid-pipeline to find out.
 *
 * The strict alternative exists and is deliberately unused:
 * `provider: { require_parameters: true }` turns that same call into
 * `No endpoints found that can handle the requested parameters`. It would
 * convert a lever left on a model that ignores it from a no-op into a broken
 * run, which is a worse failure than the one it prevents.
 */
export function callTuning(
  levers: ModelCallLevers | undefined,
  timeoutMs: number,
): Pick<ChatOptions, 'reasoning' | 'provider' | 'timeoutMs'> {
  const effort = levers?.reasoningEffort ?? null;
  const sort = levers?.providerSort ?? null;
  return {
    timeoutMs,
    ...(effort ? { reasoning: { effort } } : {}),
    ...(sort ? { provider: { sort } } : {}),
  };
}

/** Parse a stored value into a `ReasoningEffort`, or null if it is not one. */
export function toReasoningEffort(value: string | null | undefined): ReasoningEffort | null {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}

/** Parse a stored value into a `ProviderSort`, or null if it is not one. */
export function toProviderSort(value: string | null | undefined): ProviderSort | null {
  return value === 'throughput' || value === 'latency' || value === 'price' ? value : null;
}
