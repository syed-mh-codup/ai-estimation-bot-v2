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
      message: z.object({ content: z.string() }),
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

export class OpenRouterModelProvider implements IModelProvider {
  private readonly baseUrl: string;
  private readonly fallbackModel?: string;

  constructor(private readonly config: ModelProviderConfig) {
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.fallbackModel = config.fallbackModel;
  }

  async chat(options: ChatOptions): Promise<ChatResult> {
    const response = await this.fetchWithFallback('/chat/completions', options.model, {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens,
      ...(options.plugins ? { plugins: options.plugins } : {}),
      ...(options.responseFormat ? { response_format: { type: options.responseFormat } } : {}),
    });
    const parsed = ChatResponseSchema.parse(response);
    return {
      text: parsed.choices[0]?.message.content ?? '',
      model: parsed.model ?? options.model,
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
    const res = await this.fetchRaw('/chat/completions', {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.plugins ? { plugins: options.plugins } : {}),
    });
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

            if (typeof chunk.model === 'string') servedModel = chunk.model;
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
      model: parsed.model ?? options.model,
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: 0,
            costUsd: typeof parsed.usage.cost === 'number' ? parsed.usage.cost : null,
          }
        : null,
    };
  }

  private async fetchWithFallback(
    path: string,
    model: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.fetchApi(path, body);
    } catch (err) {
      if (this.fallbackModel && model !== this.fallbackModel) {
        return this.fetchApi(path, { ...body, model: this.fallbackModel });
      }
      throw err;
    }
  }

  private async fetchApi(path: string, body: Record<string, unknown>): Promise<unknown> {
    const res = await this.fetchRaw(path, body);
    return res.json();
  }

  private async fetchRaw(path: string, body: Record<string, unknown>): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://codup.co',
      },
      body: JSON.stringify(body),
    });
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
