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
};

export type EmbedOptions = {
  model: string;
  input: string | string[];
};

export type ModelProviderConfig = {
  apiKey: string;
  baseUrl?: string;
  fallbackModel?: string;
};

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IModelProvider {
  chat(options: ChatOptions): Promise<string>;
  embed(options: EmbedOptions): Promise<number[][]>;
}

// ─── OpenRouter adapter ───────────────────────────────────────────────────────

const ChatResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({ content: z.string() }),
    }),
  ),
});

const EmbedResponseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })),
});

export class OpenRouterModelProvider implements IModelProvider {
  private readonly baseUrl: string;
  private readonly fallbackModel?: string;

  constructor(private readonly config: ModelProviderConfig) {
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.fallbackModel = config.fallbackModel;
  }

  async chat(options: ChatOptions): Promise<string> {
    const response = await this.fetchWithFallback('/chat/completions', options.model, {
      model: options.model,
      messages: options.messages,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens,
      ...(options.plugins ? { plugins: options.plugins } : {}),
    });
    const parsed = ChatResponseSchema.parse(response);
    return parsed.choices[0]?.message.content ?? '';
  }

  async embed(options: EmbedOptions): Promise<number[][]> {
    const response = await this.fetchWithFallback('/embeddings', options.model, {
      model: options.model,
      input: options.input,
    });
    const parsed = EmbedResponseSchema.parse(response);
    return parsed.data.map((d) => d.embedding);
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
    return res.json();
  }
}

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
