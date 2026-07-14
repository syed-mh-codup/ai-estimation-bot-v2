import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  StubSheetsProvider,
  LiveSheetsProvider,
  createSheetsProvider,
} from './sheets-provider';
import {
  StubSearchProvider,
  TavilySearchProvider,
  createSearchProvider,
} from './search-provider';
import { LiveMcpProvider } from './mcp-provider';

// WS25-02: provider coverage with mocks — exercises the stub/adapter paths that
// the feature tests don't reach.

describe('WS25-02: sheets provider', () => {
  it('stub create/update/getId behave', async () => {
    const p = new StubSheetsProvider();
    const created = await p.createSpreadsheet('Title', [{ title: 'Tab', rows: [['a', 1]] }], 'est-cov-01');
    expect(created.url).toContain('docs.google.com/spreadsheets');
    const updated = await p.updateSpreadsheet(created.spreadsheetId, []);
    expect(updated.spreadsheetId).toBe(created.spreadsheetId);
    expect(await p.getSpreadsheetId('unknown')).toBeNull();
  });

  it('factory returns the stub when no credentials', () => {
    delete process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
    delete process.env['GOOGLE_DRIVE_FOLDER_ID'];
    expect(createSheetsProvider()).toBeInstanceOf(StubSheetsProvider);
  });

  it('factory returns the stub when only one of the two required env vars is set', () => {
    process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = '{"client_email":"x","private_key":"y"}';
    delete process.env['GOOGLE_DRIVE_FOLDER_ID'];
    expect(createSheetsProvider()).toBeInstanceOf(StubSheetsProvider);
    delete process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
  });

  it('factory returns LiveSheetsProvider when both credentials are set', () => {
    process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = '{"client_email":"x@example.com","private_key":"fake-key"}';
    process.env['GOOGLE_DRIVE_FOLDER_ID'] = 'folder-123';
    expect(createSheetsProvider()).toBeInstanceOf(LiveSheetsProvider);
    delete process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
    delete process.env['GOOGLE_DRIVE_FOLDER_ID'];
  });
});

describe('WS25-02: search provider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stub returns no results', async () => {
    expect(await new StubSearchProvider().search('anything')).toEqual([]);
  });

  it('factory returns stub without a key, Tavily with one', () => {
    delete process.env['TAVILY_API_KEY'];
    expect(createSearchProvider()).toBeInstanceOf(StubSearchProvider);
    expect(createSearchProvider({ apiKey: 'k' })).toBeInstanceOf(TavilySearchProvider);
  });

  it('Tavily throws without a key', async () => {
    await expect(new TavilySearchProvider('').search('q')).rejects.toThrow(/TAVILY_API_KEY/);
  });

  it('Tavily maps results on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ results: [{ title: 'T', url: 'u', content: 'c' }] }),
      })),
    );
    const out = await new TavilySearchProvider('key').search('q', 3);
    expect(out).toEqual([{ title: 'T', url: 'u', snippet: 'c' }]);
  });

  it('Tavily throws on a non-OK response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })));
    await expect(new TavilySearchProvider('key').search('q')).rejects.toThrow(/Tavily error 500/);
  });
});

describe('WS25-02: LiveMcpProvider list methods', () => {
  it('listTools returns [] for an unknown connector', async () => {
    expect(await new LiveMcpProvider().listTools('nope')).toEqual([]);
  });

  it('listAllTools skips disabled connectors and tolerates unreachable ones', async () => {
    const provider = new LiveMcpProvider([
      { id: 'a', name: 'A', transport: 'http', endpoint: 'http://127.0.0.1:1/mcp', authRef: null, enabled: false },
      { id: 'b', name: 'B', transport: 'http', endpoint: 'http://127.0.0.1:1/mcp', authRef: null, enabled: true },
    ]);
    // Disabled 'a' is skipped; enabled 'b' refuses the connection → no tools.
    expect(await provider.listAllTools()).toEqual([]);
  });
});
