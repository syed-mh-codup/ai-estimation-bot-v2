import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  OpenRouterModelProvider,
  EmbeddingProvider,
  EMBEDDING_DIMENSION,
  StubSearchProvider,
  TavilySearchProvider,
  createModelProvider,
} from './index';
import type { IModelProvider } from './model-provider';

// ─── WS3-01: ModelProvider chat + embed, model string swap ────────────────────

describe('WS3-01: OpenRouterModelProvider', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
  });

  it('chat() returns completion content', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Hello world' } }] }),
    });

    const provider = new OpenRouterModelProvider({ apiKey: 'test-key' });
    const result = await provider.chat({
      model: 'openrouter/anthropic/claude-3-haiku',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(result.text).toBe('Hello world');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/chat/completions'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('embed() returns vectors', async () => {
    const mockVector = new Array<number>(EMBEDDING_DIMENSION).fill(0.1);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: mockVector }] }),
    });

    const provider = new OpenRouterModelProvider({ apiKey: 'test-key' });
    const result = await provider.embed({
      model: 'openai/text-embedding-3-small',
      input: 'test text',
    });
    expect(result.vectors).toHaveLength(1);
    expect(result.vectors[0]).toHaveLength(EMBEDDING_DIMENSION);
  });

  it('model string swap changes the model sent (without code change)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });

    const provider = new OpenRouterModelProvider({ apiKey: 'test-key' });
    await provider.chat({
      model: 'openrouter/google/gemini-pro',
      messages: [{ role: 'user', content: 'test' }],
    });

    const body = JSON.parse(mockFetch.mock.calls[0]![1].body as string);
    expect(body.model).toBe('openrouter/google/gemini-pro');
  });

  it('createModelProvider returns an IModelProvider', () => {
    const p = createModelProvider({ apiKey: 'test' });
    expect(typeof p.chat).toBe('function');
    expect(typeof p.embed).toBe('function');
  });
});

// ─── WS3-02: EmbeddingProvider dimension check ────────────────────────────────

describe('WS3-02: EmbeddingProvider', () => {
  it('embeds text and returns vectors of configured dimension', async () => {
    const mockVector = new Array<number>(EMBEDDING_DIMENSION).fill(0.5);
    const mockModel: IModelProvider = {
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn().mockResolvedValue({ vectors: [mockVector], model: 'stub/model', usage: null }),
    };

    const ep = new EmbeddingProvider(mockModel);
    const results = await ep.embed('test text');
    expect(results.vectors).toHaveLength(1);
    expect(results.vectors[0]).toHaveLength(EMBEDDING_DIMENSION);
    expect(ep.dimension).toBe(EMBEDDING_DIMENSION);
  });

  it('throws if dimension mismatches', async () => {
    const mockModel: IModelProvider = {
      chat: vi.fn(),
      chatStream: vi.fn(),
      embed: vi.fn().mockResolvedValue({ vectors: [[0.1, 0.2, 0.3]], model: 'stub/model', usage: null }),
    };

    const ep = new EmbeddingProvider(mockModel);
    await expect(ep.embed('test')).rejects.toThrow(/dimension mismatch/);
  });
});

// ─── WS3-03: SearchProvider interface + contract test ─────────────────────────

describe('WS3-03: SearchProvider interface contract', () => {
  it('StubSearchProvider returns empty array (no credentials)', async () => {
    const provider = new StubSearchProvider();
    const results = await provider.search('shopify checkout');
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(0);
  });

  it('TavilySearchProvider.search() normalises results to SearchResult shape', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        results: [
          { title: 'Shopify Docs', url: 'https://shopify.dev', content: 'Rate limit 2/s' },
        ],
      }),
    });

    const provider = new TavilySearchProvider('fake-key');
    const results = await provider.search('shopify rate limit');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Shopify Docs',
      url: 'https://shopify.dev',
      snippet: 'Rate limit 2/s',
    });
  });

  it('adapter swap: replacing StubSearchProvider with TavilySearchProvider uses same interface', () => {
    const stub = new StubSearchProvider();
    const tavily = new TavilySearchProvider('key');
    // Both satisfy the interface contract
    expect(typeof stub.search).toBe('function');
    expect(typeof tavily.search).toBe('function');
  });
});

// ─── WS3-04: Fallback model on primary error ──────────────────────────────────

describe('WS3-04: Provider fallback on error', () => {
  it('routes to fallback model when primary fails', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    mockFetch
      .mockResolvedValueOnce({ ok: false, text: async () => 'overloaded', status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'fallback response' } }] }),
      });

    const provider = new OpenRouterModelProvider({
      apiKey: 'test-key',
      fallbackModel: 'openrouter/anthropic/claude-haiku',
    });

    const result = await provider.chat({
      model: 'openrouter/anthropic/claude-opus',
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(result.text).toBe('fallback response');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const fallbackBody = JSON.parse(mockFetch.mock.calls[1]![1].body as string);
    expect(fallbackBody.model).toBe('openrouter/anthropic/claude-haiku');
  });
});
