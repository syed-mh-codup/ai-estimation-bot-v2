/**
 * The list of models an admin can pick from at /admin/prompts.
 *
 * Fetched live rather than hardcoded, which is the whole point: a model string
 * used to be free text, so a typo saved cleanly and only surfaced mid-run as a
 * failed estimate, and a newly released model needed a deploy to become
 * reachable. Neither is true now.
 *
 * Cached for an hour. This makes /admin/prompts the first page in the app whose
 * render touches a third-party API, so every failure path here degrades to the
 * old free-text field rather than to an error — an admin must never be locked
 * out of editing a prompt because OpenRouter is having a bad day.
 */

export type ModelOption = {
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per input token, as OpenRouter reports it. */
  promptPrice: number | null;
  completionPrice: number | null;
  /**
   * Whether this model accepts a reasoning-effort setting at all.
   *
   * Read from the feed's own `supported_parameters`, which is the only honest
   * source: a hardcoded list of "the thinking models" would be a second source
   * of truth about a third party's catalogue, wrong the week after it was
   * written. It is what lets the editors offer the reasoning control for
   * `~google/gemini-flash-latest` and not for `openai/gpt-4o-mini`, with no
   * model names in the code.
   *
   * It matters because an unsupported lever is INERT, not rejected — measured
   * against the live API, `reasoning: { effort: 'low' }` sent to gpt-4o-mini
   * returns a normal completion with the field silently dropped. So nothing
   * downstream would ever complain, and an admin could set a lever, see a save
   * succeed, and get no effect and no explanation.
   */
  supportsReasoning: boolean;
};

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

type ApiModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: { output_modalities?: unknown };
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
};

/**
 * Either spelling counts. OpenRouter's feed lists `reasoning` and
 * `reasoning_effort` as separate entries and a model may advertise one, the
 * other, or both; all three cases mean the same thing to us.
 */
function readsReasoning(supported: unknown): boolean {
  if (!Array.isArray(supported)) return false;
  return supported.some((p) => p === 'reasoning' || p === 'reasoning_effort');
}

function toNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Every text-generating model OpenRouter currently serves.
 *
 * Returns an empty array on any failure. That is the signal the caller uses to
 * fall back to a plain text input, so it must never throw.
 */
export async function fetchModelOptions(): Promise<ModelOption[]> {
  // Under test the app must not reach OpenRouter: a dropdown whose contents
  // depend on a third party's catalogue is not something an e2e run can assert
  // against, and the request itself would be a flake waiting to happen.
  if (process.env['OPENROUTER_STUB'] === '1') return STUB_MODELS;

  try {
    const res = await fetch(MODELS_URL, { next: { revalidate: 3600 } });
    if (!res.ok) return [];
    const payload = (await res.json()) as { data?: ApiModel[] };

    return (payload.data ?? [])
      .filter((m) => {
        if (typeof m.id !== 'string' || !m.id) return false;
        const out = m.architecture?.output_modalities;
        // Absent modalities means an older entry; assume text rather than drop it.
        return !Array.isArray(out) || out.includes('text');
      })
      .map((m) => ({
        id: m.id as string,
        name: typeof m.name === 'string' ? m.name : (m.id as string),
        contextLength: toNumber(m.context_length),
        promptPrice: toNumber(m.pricing?.prompt),
        completionPrice: toNumber(m.pricing?.completion),
        supportsReasoning: readsReasoning(m.supported_parameters),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/**
 * A fixed handful for the e2e run. Includes the two models the seed actually
 * uses, so a spec can assert the saved value is present and selectable.
 */
const STUB_MODELS: ModelOption[] = [
  {
    id: 'anthropic/claude-sonnet-5',
    name: 'Anthropic: Claude Sonnet 5',
    contextLength: 200_000,
    promptPrice: 0.000003,
    completionPrice: 0.000015,
    supportsReasoning: true,
  },
  {
    // Deliberately false, and deliberately the model the seed uses: this is the
    // case that proves the reasoning control is gated rather than always drawn.
    // Checked against the live feed on 8 September — gpt-4o-mini advertises
    // neither `reasoning` nor `reasoning_effort`.
    id: 'openai/gpt-4o-mini',
    name: 'OpenAI: GPT-4o-mini',
    contextLength: 128_000,
    promptPrice: 0.00000015,
    completionPrice: 0.0000006,
    supportsReasoning: false,
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Google: Gemini 2.5 Pro',
    contextLength: 1_000_000,
    promptPrice: 0.00000125,
    completionPrice: 0.00001,
    supportsReasoning: true,
  },
];

/**
 * What the model picker needs to render one option.
 *
 * Lives here rather than beside the component that consumes it, and that is
 * load-bearing: `model-call-fields.tsx` is a `'use client'` module, and EVERY
 * export of a client module becomes a client reference. A plain function
 * exported from there cannot be called during a server render — it throws
 * "Attempted to call toModelChoices() from the server but toModelChoices is on
 * the client" — and neither `tsc` nor `next build` can see it coming, because
 * it is a runtime boundary violation rather than a type error. It only shows up
 * as a 500 on the page.
 *
 * So the shape and its builder live on the server side of the boundary, next to
 * the `ModelOption` they are derived from, and the client component imports the
 * TYPE alone — types are erased, so that import crosses nothing.
 */
export type ModelChoice = {
  id: string;
  label: string;
  hint: string;
  supportsReasoning: boolean;
};

/**
 * Build the picker's options from the catalogue.
 *
 * Shared by all three editors, which each want the same hint line — it used to
 * be copied per page.
 */
export function toModelChoices(models: ModelOption[]): ModelChoice[] {
  return models.map((m) => ({
    id: m.id,
    label: m.name,
    supportsReasoning: m.supportsReasoning,
    hint: [
      m.contextLength ? `${Math.round(m.contextLength / 1000)}k context` : null,
      m.promptPrice !== null ? `$${(m.promptPrice * 1_000_000).toFixed(2)}/M in` : null,
      m.completionPrice !== null ? `$${(m.completionPrice * 1_000_000).toFixed(2)}/M out` : null,
      m.supportsReasoning ? 'thinking' : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
}
