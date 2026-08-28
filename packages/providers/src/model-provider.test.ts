import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterModelProvider, type ChatStreamEvent } from './model-provider';

/**
 * The streamed path added for Oracle (AEH-259).
 *
 * Worth real coverage because every failure mode here is silent: a frame split
 * across two network chunks loses a word rather than throwing, and a missed
 * usage frame records a turn as costing nothing rather than as unknown. The
 * frame shapes below are copied from a live OpenRouter response.
 */

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const delta = (content: string, model = 'anthropic/claude-sonnet-5') => ({
  model,
  choices: [{ delta: { content } }],
});

async function collect(it: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function provider() {
  return new OpenRouterModelProvider({ apiKey: 'test-key' });
}

function textOf(events: ChatStreamEvent[]): string {
  return events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
}

afterEach(() => vi.unstubAllGlobals());

describe('chatStream', () => {
  it('yields the deltas in order and finishes with a done event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          frame(delta('The source ')),
          frame(delta('material says')),
          frame({
            model: 'anthropic/claude-sonnet-5',
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 1200, completion_tokens: 64, cost: 0.0042 },
          }),
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const events = await collect(
      provider().chatStream({ model: 'anthropic/claude-sonnet-5', messages: [] }),
    );

    expect(textOf(events)).toBe('The source material says');
    expect(events.at(-1)).toEqual({
      type: 'done',
      model: 'anthropic/claude-sonnet-5',
      usage: { promptTokens: 1200, completionTokens: 64, costUsd: 0.0042 },
    });
  });

  it('reassembles a frame split across network chunks', async () => {
    // The failure this guards: naive per-chunk parsing drops the half-frame and
    // the answer silently loses a word.
    const whole = frame(delta('rate limiting'));
    const cut = Math.floor(whole.length / 2);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse([whole.slice(0, cut), whole.slice(cut), 'data: [DONE]\n\n'])),
    );

    const events = await collect(provider().chatStream({ model: 'm', messages: [] }));
    expect(textOf(events)).toBe('rate limiting');
  });

  it('reports the model as served, not as requested', async () => {
    // fetchWithFallback means the two are not always the same, and a transcript
    // read later is uninterpretable if we record the wrong one.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([frame(delta('ok', 'openai/gpt-4o-mini')), 'data: [DONE]\n\n']),
      ),
    );

    const events = await collect(
      provider().chatStream({ model: 'anthropic/claude-sonnet-5', messages: [] }),
    );
    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'openai/gpt-4o-mini' });
  });

  it('reports unknown usage as null rather than zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(sseResponse([frame(delta('ok')), 'data: [DONE]\n\n'])),
    );

    const events = await collect(provider().chatStream({ model: 'm', messages: [] }));
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: null });
  });

  it('skips malformed frames instead of losing the whole answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        sseResponse([
          ': keep-alive comment\n\n',
          'data: {not json\n\n',
          frame(delta('still here')),
          'data: [DONE]\n\n',
        ]),
      ),
    );

    const events = await collect(provider().chatStream({ model: 'm', messages: [] }));
    expect(textOf(events)).toBe('still here');
  });

  it('asks OpenRouter for usage, which it does not send by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);

    await collect(provider().chatStream({ model: 'm', messages: [] }));

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('throws on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 429 })),
    );

    await expect(collect(provider().chatStream({ model: 'm', messages: [] }))).rejects.toThrow(
      /OpenRouter API error 429/,
    );
  });

  it('does not fall back to another model mid-stream', async () => {
    // A fallback here would splice two models' tokens into one answer with the
    // join invisible to the reader. Failing is the honest outcome.
    const fetchMock = vi.fn().mockRejectedValue(new Error('upstream down'));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenRouterModelProvider({ apiKey: 'k', fallbackModel: 'openai/gpt-4o-mini' });
    await expect(collect(p.chatStream({ model: 'anthropic/claude-sonnet-5', messages: [] }))).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
