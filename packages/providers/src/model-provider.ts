import { z } from 'zod';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Multimodal content parts (OpenRouter chat format). */
export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image_url'; image_url: { url: string } };
export type FilePart = { type: 'file'; file: { filename: string; file_data: string } };
export type ContentPart = TextPart | ImagePart | FilePart;

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  /** Plain string (text-only, back-compatible) or multimodal content parts. */
  content: string | ContentPart[];
};

export type ChatOptions = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** OpenRouter plugins, e.g. the PDF `file-parser` (passed through verbatim). */
  plugins?: unknown[];
  /**
   * 'json_object' asks the model to guarantee syntactically valid JSON output
   * (OpenAI-compatible models). Agents that parse a strict envelope should set
   * this instead of relying on a regex `{...}` extraction — a model that
   * returns prose or markdown fences around JSON is exactly what silently
   * triggers the old "fallback to a stub value" bug.
   */
  responseFormat?: 'json_object';
  /**
   * How much a reasoning model is allowed to think before it answers.
   *
   * Measured, on 4 September, against the ERD section that had been taking
   * whole generations down (AEH-321). Same prompt, same model
   * (`deepseek/deepseek-v4-flash-0731`), one variable:
   *
   *   default        143.4s   41,336 completion tokens (33,542 of them reasoning)
   *   effort 'low'    87.3s    3,909 completion tokens (1,396 of them reasoning)
   *
   * So on this model reasoning is ~80% of both the wall clock and the bill, and
   * `completion_tokens` INCLUDES it — a usage row reading 30k is mostly thought,
   * not document.
   *
   * `{ enabled: false }` is deliberately not used anywhere and should not be:
   * the same call with reasoning switched off hung for over nine minutes and
   * never returned. Turn it DOWN, never OFF.
   *
   * Passed through verbatim; OpenRouter's `/models` feed lists `reasoning` and
   * `reasoning_effort` in `supported_parameters` for models that accept it.
   */
  reasoning?: { effort?: 'low' | 'medium' | 'high'; max_tokens?: number };
  /**
   * Give up on the whole call — primary AND fallback — after this many ms.
   *
   * Without it a call has no ceiling of its own, so on a serverless deploy the
   * only thing that ends a slow completion is the platform killing the process:
   * on Vercel that is a 300s `FUNCTION_INVOCATION_TIMEOUT`, which Inngest sees
   * as a bare HTTP 504 with no step output. Every one of AEH-321's failed
   * generations died that way — the whole budget spent, the completion paid
   * for, and an error that names nothing.
   *
   * A caller that sets this fails inside the platform's ceiling instead, with
   * an error that says what timed out.
   */
  timeoutMs?: number;
  /**
   * Which upstream host OpenRouter should serve this model from.
   *
   * OpenRouter serves one model from several providers at very different
   * speeds, and routes by PRICE unless told otherwise — so on a call with a
   * hard deadline the default is exactly backwards: it will pick the cheapest
   * host, which is frequently the slowest.
   *
   * That is not theoretical. On 4 September the artifact outline call was
   * measured at 37.2s standalone and abandoned twice at 240s in production
   * inside the same ten minutes — same prompt, same model, same reasoning
   * setting. The only variable left is who served it.
   *
   * `sort: 'throughput'` costs more per token by construction, because it stops
   * choosing on price. At roughly two cents a document that is not the
   * constraint; missing the function's ceiling is.
   *
   * Passed through verbatim.
   */
  provider?: {
    sort?: 'throughput' | 'latency' | 'price';
    order?: string[];
    only?: string[];
    ignore?: string[];
    allow_fallbacks?: boolean;
  };
};

export type EmbedOptions = {
  model: string;
  input: string | string[];
};

/**
 * What a completed call actually cost. Every field is optional at the type level
 * because a provider is not obliged to report any of it, and a missing figure
 * must read as "unknown" rather than as zero.
 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  /** USD, as reported by the provider. */
  costUsd: number | null;
};

/**
 * One frame of a streamed completion.
 *
 * `done` always arrives last, and carries the model as SERVED rather than as
 * requested — routing means the two are not always the same, and a transcript
 * read six months later is uninterpretable without knowing which model wrote it.
 */
export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage: TokenUsage | null; model: string };

/** A completed `chat` call: the text plus what it cost and which model served it. */
export type ChatResult = {
  text: string;
  usage: TokenUsage | null;
  /** The model as SERVED — fallback may differ from the requested string. */
  model: string;
  /**
   * Why the model stopped, verbatim from the provider — "stop", "length",
   * "content_filter". Optional so every stub in the repo stays valid.
   *
   * Carried because an empty `text` is otherwise unexplainable. A model that
   * hits its token cap can return `content: null` with `finish_reason:
   * "length"`, and without this the caller sees an empty string and no reason
   * for it. That happened in production on 3 September and cost an eight-minute
   * generation to diagnose from a stack trace.
   */
  finishReason?: string | null;
};

/** A completed `embed` call: the vectors plus what it cost and which model served it. */
export type EmbedResult = {
  vectors: number[][];
  usage: TokenUsage | null;
  model: string;
};

export type ModelProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  fallbackModel?: string;
};

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IModelProvider {
  chat(options: ChatOptions): Promise<ChatResult>;
  embed(options: EmbedOptions): Promise<EmbedResult>;
  /**
   * The same call as `chat`, delivered incrementally.
   *
   * Added for Oracle (AEH-259), whose turns carry an entire source document and
   * would otherwise sit silent for many seconds behind a `chat()` promise. It is
   * on the interface rather than on the OpenRouter class alone so any agent can
   * use it later.
   *
   * Unlike `chat`, this does NOT fall back to another model on error. A fallback
   * mid-stream would mean tokens from two different models concatenated into one
   * answer, with the join invisible to the reader. Failing is the honest outcome;
   * the caller has already shown a partial answer and can say it broke.
   */
  chatStream(options: ChatOptions): AsyncIterable<ChatStreamEvent>;
}

// ─── OpenRouter adapter ───────────────────────────────────────────────────────

const ChatResponseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(
    z.object({
      /**
       * `content` is NULLABLE, and this is not defensive padding.
       *
       * A model that stops on its token cap can return `"content": null` with
       * `finish_reason: "length"` — reasoning models in particular, where the
       * cap is spent before any answer is emitted. Requiring a string turned
       * that into a ZodError thrown from inside the provider, which surfaced as
       * an unreadable stack trace and lost an eight-minute generation.
       *
       * Absent is not the same as empty, but both mean "no text came back", and
       * the caller is far better placed to decide what that means than a
       * parser is. `finish_reason` is what makes the decision possible.
       */
      message: z.object({ content: z.string().nullish() }),
      finish_reason: z.string().nullish(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

const EmbedResponseSchema = z.object({
  model: z.string().optional(),
  data: z.array(z.object({ embedding: z.array(z.number()) })),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
});

/**
 * The model to report as SERVED, given what the response echoed back.
 *
 * OpenRouter's chat endpoint echoes a fully-qualified `provider/model`, but the
 * embeddings endpoint echoes a bare name (`text-embedding-3-small` for a
 * requested `openai/text-embedding-3-small`) — verified live. Left alone that
 * splits the per-model spend report into two spellings of the same model.
 *
 * So a bare name is qualified with the requested string, but ONLY when it is
 * demonstrably the same model — matching the requested string's last segment. A
 * bare name that does NOT match is a fallback route having served something
 * else, and that is exactly the fact the report must not lose: it is kept
 * verbatim rather than relabelled as the model we asked for.
 */
export function qualifyModel(echoed: string | undefined, requested: string): string {
  if (!echoed) return requested;
  if (echoed.includes('/')) return echoed;
  const requestedLeaf = requested.slice(requested.lastIndexOf('/') + 1);
  return echoed === requestedLeaf ? requested : echoed;
}

/**
 * Run `fn`, and if the call budget aborts it, say so in words.
 *
 * An abort arrives as `TimeoutError: The operation was aborted due to timeout`,
 * which names neither the model nor the budget — so the error a caller records
 * is no more actionable than the platform 504 the budget exists to replace.
 *
 * Wraps BOTH the request and the body read, because for a buffered completion
 * the wait is almost entirely in the read: OpenRouter sends headers as soon as
 * it begins responding, so `fetch` resolves immediately and the model's whole
 * generation elapses inside `.json()`.
 */
async function named<T>(
  fn: () => Promise<T>,
  body: Record<string, unknown>,
  timeoutMs: number | undefined,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        `OpenRouter call to ${String(body['model'])} exceeded its ${timeoutMs}ms budget and was abandoned.`,
      );
    }
    throw err;
  }
}

export class OpenRouterModelProvider implements IModelProvider {
  private readonly baseUrl: string;
  private readonly fallbackModel?: string;

  constructor(private readonly config: ModelProviderConfig) {
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.fallbackModel = config.fallbackModel;
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const response = await this.fetchWithFallback(
      '/chat/completions',
      options.model,
      {
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens,
        ...(options.plugins ? { plugins: options.plugins } : {}),
        ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
      },
      options.timeoutMs,
    );
    const parsed = ChatResponseSchema.parse(response);
    return {
      text: parsed.choices[0]?.message.content ?? '',
      finishReason: parsed.choices[0]?.finish_reason ?? null,
      model: qualifyModel(parsed.model, options.model),
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
            costUsd: typeof parsed.usage.cost === 'number' ? parsed.usage.cost : null,
          }
        : null,
    };
  }

  /**
   * Streamed completion over OpenRouter's SSE endpoint.
   *
   * Frame shape verified live against the API: every frame carries `model` and
   * `provider`; content arrives as `choices[0].delta.content`; and with
   * `stream_options.include_usage` a final frame before `[DONE]` carries
   * `usage` with token counts and the actual cost. Parsing is deliberately
   * permissive — an unrecognised frame is skipped rather than failing the whole
   * answer, because a keep-alive comment or a new field must not lose a reply
   * the user is already reading.
   */
  async *chatStream(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    const res = await this.fetchRaw(
      '/chat/completions',
      {
        model: options.model,
        messages: options.messages,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
        ...(options.plugins ? { plugins: options.plugins } : {}),
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
      },
      options.timeoutMs,
    );
    if (!res.body) throw new Error('OpenRouter returned no response body for a streamed call');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let servedModel = options.model;
    let usage: TokenUsage | null = null;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Keep the trailing partial.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;

            let parsed: unknown;
            try {
              parsed = JSON.parse(payload);
            } catch {
              continue;
            }
            const chunk = parsed as StreamChunk;

            if (typeof chunk.model === 'string') {
              servedModel = qualifyModel(chunk.model, options.model);
            }
            if (chunk.usage) {
              usage = {
                promptTokens: chunk.usage.prompt_tokens ?? 0,
                completionTokens: chunk.usage.completion_tokens ?? 0,
                costUsd: typeof chunk.usage.cost === 'number' ? chunk.usage.cost : null,
              };
            }
            const text = chunk.choices?.[0]?.delta?.content;
            if (text) yield { type: 'delta', text };
          }
        }
      }
    } finally {
      // Abandoning a half-read stream leaks the socket until GC otherwise, and
      // a user closing the panel mid-answer is the common case here.
      await reader.cancel().catch(() => {});
    }

    yield { type: 'done', usage, model: servedModel };
  }

  async embed(options: EmbedOptions): Promise<EmbedResult> {
    const response = await this.fetchWithFallback('/embeddings', options.model, {
      model: options.model,
      input: options.input,
    });
    const parsed = EmbedResponseSchema.parse(response);
    return {
      vectors: parsed.data.map((d) => d.embedding),
      model: qualifyModel(parsed.model, options.model),
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: 0,
            costUsd: typeof parsed.usage.cost === 'number' ? parsed.usage.cost : null,
          }
        : null,
    };
  }

  /**
   * `timeoutMs` is a budget for the CALL, not for each attempt.
   *
   * A per-attempt timeout would let a primary that burns the whole budget be
   * followed by a fallback that gets a fresh one, so a caller asking for 240s
   * could sit for 480s — past the very ceiling it set the timeout to stay
   * inside. So the deadline is fixed once, here, and the fallback gets whatever
   * is left of it.
   */
  private async fetchWithFallback(
    path: string,
    model: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const remaining = (): number | undefined =>
      deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
    try {
      return await this.fetchApi(path, body, remaining());
    } catch (err) {
      if (this.fallbackModel && model !== this.fallbackModel) {
        return this.fetchApi(path, { ...body, model: this.fallbackModel }, remaining());
      }
      throw err;
    }
  }

  private async fetchApi(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const res = await this.fetchRaw(path, body, timeoutMs);
    // Reading the body is the part that actually waits, so it needs the same
    // naming as the request. OpenRouter sends headers as soon as it starts
    // responding and streams the JSON after, so `fetch` resolves in
    // milliseconds and the whole completion elapses inside `.json()`. An abort
    // therefore lands HERE, not on the request — which is how AEH-321's first
    // real timeout still surfaced as a bare `TimeoutError: The operation was
    // aborted due to timeout`, naming neither the model nor the budget.
    return named(() => res.json(), body, timeoutMs);
  }

  private async fetchRaw(
    path: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Response> {
    const res = await named(
      () =>
        fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://codup.co',
          },
          body: JSON.stringify(body),
          ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) }),
        }),
      body,
      timeoutMs,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenRouter API error ${res.status}: ${text}`);
    }
    return res;
  }
}

/** The subset of an OpenRouter stream frame this adapter reads. */
type StreamChunk = {
  model?: string;
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
};

/** Factory: create a ModelProvider from environment config. */
export function createModelProvider(
  overrides?: Partial<ModelProviderConfig>,
): IModelProvider {
  const apiKey = overrides?.apiKey ?? process.env['OPENROUTER_API_KEY'] ?? '';
  return new OpenRouterModelProvider({
    apiKey,
    baseUrl: overrides?.baseUrl,
    fallbackModel: overrides?.fallbackModel ?? process.env['OPENROUTER_FALLBACK_MODEL'],
  });
}
