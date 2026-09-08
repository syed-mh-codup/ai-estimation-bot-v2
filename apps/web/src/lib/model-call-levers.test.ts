import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { leverToFormValue, readModelCallLevers } from './model-call-levers';

/**
 * The gate these tests are about: a lever must only be stored against a model
 * that can actually honour it.
 *
 * It matters because the API does not complain. Checked against the live
 * OpenRouter API on 8 September: `reasoning: { effort: 'low' }` sent to
 * `openai/gpt-4o-mini`, which advertises neither `reasoning` nor
 * `reasoning_effort`, returns a normal completion with the field silently
 * dropped. So nothing downstream would ever surface the mistake — an admin
 * would set a lever, watch the save succeed, and get no effect and no
 * explanation. This is the only place that can say no.
 */
const CATALOGUE = [
  {
    id: 'google/gemini-flash-latest',
    name: 'Gemini Flash',
    contextLength: 1_000_000,
    promptPrice: null,
    completionPrice: null,
    supportsReasoning: true,
  },
  {
    id: 'openai/gpt-4o-mini',
    name: 'GPT-4o-mini',
    contextLength: 128_000,
    promptPrice: null,
    completionPrice: null,
    supportsReasoning: false,
  },
];

const fetchModelOptions = vi.hoisted(() => vi.fn());
vi.mock('./openrouter-models', () => ({ fetchModelOptions }));

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  fetchModelOptions.mockReset();
  fetchModelOptions.mockResolvedValue(CATALOGUE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readModelCallLevers', () => {
  it('stores a reasoning lever for a model that supports it', async () => {
    const levers = await readModelCallLevers(
      form({ reasoningEffort: 'low', providerSort: 'throughput' }),
      'google/gemini-flash-latest',
    );
    // Stored UPPER_CASE like every other enum in the schema, sent lowercase on
    // the wire. This function is the only place the two spellings meet.
    expect(levers).toEqual({ reasoningEffort: 'LOW', providerSort: 'THROUGHPUT' });
  });

  it('DROPS a reasoning lever for a model that does not support it', async () => {
    const levers = await readModelCallLevers(
      form({ reasoningEffort: 'high', providerSort: 'throughput' }),
      'openai/gpt-4o-mini',
    );
    expect(levers.reasoningEffort).toBeNull();
    // The routing lever survives: it is OpenRouter's routing rather than a
    // model parameter, so it means something for every model.
    expect(levers.providerSort).toBe('THROUGHPUT');
  });

  it('drops it even when the model is switched in the SAME submission', async () => {
    // The case the editor's own gating cannot catch: an admin sets thinking to
    // low while a reasoning model is selected, then changes the model before
    // saving. Both arrive together, and the model is what decides.
    const levers = await readModelCallLevers(
      form({ reasoningEffort: 'medium' }),
      'openai/gpt-4o-mini',
    );
    expect(levers.reasoningEffort).toBeNull();
  });

  it('keeps what was asked for when the catalogue cannot be reached', async () => {
    // An empty list is how fetchModelOptions reports failure. Refusing to save
    // a lever because a third party is down would be the same trap the model
    // picker's free-text fallback exists to avoid, and the cost of guessing
    // wrong is a field the API ignores.
    fetchModelOptions.mockResolvedValue([]);
    const levers = await readModelCallLevers(
      form({ reasoningEffort: 'low' }),
      'openai/gpt-4o-mini',
    );
    expect(levers.reasoningEffort).toBe('LOW');
  });

  it('keeps what was asked for when the model is not in the catalogue', async () => {
    // Absence is not proof the model lacks the setting — only that this list
    // has not heard of it. A delisted or brand-new model must stay editable.
    const levers = await readModelCallLevers(
      form({ reasoningEffort: 'low' }),
      'some/model-nobody-lists',
    );
    expect(levers.reasoningEffort).toBe('LOW');
  });

  it('reads an empty selection as unset, not as an error', async () => {
    const levers = await readModelCallLevers(
      form({ reasoningEffort: '', providerSort: '' }),
      'google/gemini-flash-latest',
    );
    expect(levers).toEqual({ reasoningEffort: null, providerSort: null });
    // Nothing was asked for, so the catalogue never needed consulting.
    expect(fetchModelOptions).not.toHaveBeenCalled();
  });

  it('reads a missing field as unset', async () => {
    const levers = await readModelCallLevers(form({}), 'google/gemini-flash-latest');
    expect(levers).toEqual({ reasoningEffort: null, providerSort: null });
  });

  it('refuses an off switch, however it is spelled', async () => {
    // Measured during AEH-321: the same call with reasoning explicitly disabled
    // hung for over nine minutes and never returned. Down, never off — so these
    // fall through to null, which means "send no reasoning field at all".
    for (const spelling of ['none', 'off', 'disabled', 'false', '0']) {
      const levers = await readModelCallLevers(
        form({ reasoningEffort: spelling }),
        'google/gemini-flash-latest',
      );
      expect(levers.reasoningEffort).toBeNull();
    }
  });

  it('refuses a routing value OpenRouter does not define', async () => {
    const levers = await readModelCallLevers(
      form({ providerSort: 'cheapest' }),
      'google/gemini-flash-latest',
    );
    expect(levers.providerSort).toBeNull();
  });

  it('accepts every routing value OpenRouter does define', async () => {
    for (const [sent, stored] of [
      ['throughput', 'THROUGHPUT'],
      ['latency', 'LATENCY'],
      ['price', 'PRICE'],
    ] as const) {
      const levers = await readModelCallLevers(
        form({ providerSort: sent }),
        'google/gemini-flash-latest',
      );
      expect(levers.providerSort).toBe(stored);
    }
  });
});

describe('leverToFormValue', () => {
  it('round-trips a stored enum back to the form spelling', () => {
    expect(leverToFormValue('LOW')).toBe('low');
    expect(leverToFormValue('THROUGHPUT')).toBe('throughput');
  });

  it('leaves an unset lever unset', () => {
    expect(leverToFormValue(null)).toBeNull();
    expect(leverToFormValue(undefined)).toBeNull();
  });
});
