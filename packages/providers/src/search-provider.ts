import type { SearchResult } from '@repo/shared';

export interface ISearchProvider {
  /**
   * Which adapter this is, for the record. A citation grounded in a live web
   * search and one produced with the stub in place are not worth the same, and
   * until now nothing recorded which of the two an estimate got.
   */
  readonly name: string;
  search(query: string, maxResults?: number): Promise<SearchResult[]>;
}

/**
 * Stub search adapter — returns empty results.
 * BLOCKED-CREDENTIAL: replace with a real adapter when Tavily/Brave API key is available.
 */
export class StubSearchProvider implements ISearchProvider {
  readonly name = 'stub';

  async search(_query: string, _maxResults = 5): Promise<SearchResult[]> {
    return [];
  }
}

/**
 * Tavily search adapter (real implementation behind the interface).
 * Requires TAVILY_API_KEY env var.
 */
export class TavilySearchProvider implements ISearchProvider {
  readonly name = 'tavily';
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['TAVILY_API_KEY'] ?? '';
  }

  async search(query: string, maxResults = 5): Promise<SearchResult[]> {
    if (!this.apiKey) {
      throw new Error('TAVILY_API_KEY not configured');
    }
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.apiKey, query, max_results: maxResults }),
    });
    if (!res.ok) throw new Error(`Tavily error ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? []).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
    }));
  }
}

export function createSearchProvider(overrides?: { apiKey?: string }): ISearchProvider {
  const key = overrides?.apiKey ?? process.env['TAVILY_API_KEY'];
  if (!key) return new StubSearchProvider();
  return new TavilySearchProvider(key);
}
