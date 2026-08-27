import { describe, it, expect } from 'vitest';
import {
  buildMcpProvider,
  encryptSecret,
  decryptSecret,
  LiveMcpProvider,
  StubMcpProvider,
  type McpConnectorRecord,
} from './mcp-provider';

/**
 * The MCP subsystem shipped in halves: an admin could add, test and enable a
 * connector, and it influenced exactly zero estimates. `buildMcpProvider`
 * returned a StubMcpProvider even when handed real records, so there was no
 * path to a live server at all — which is why it had no production caller and
 * why `McpConnector.authRef` was never written. AEH-253 closed the gap; these
 * pin the decisions that make it safe.
 */

const MASTER = 'test-master-key-0123456789';

function connector(over: Partial<McpConnectorRecord> = {}): McpConnectorRecord {
  return {
    id: 'c1',
    name: 'shopify',
    transport: 'http',
    endpoint: 'https://mcp.example/sse',
    authRef: null,
    enabled: true,
    ...over,
  };
}

describe('buildMcpProvider — which provider a run actually gets', () => {
  it('returns a live provider for an enabled, open connector', () => {
    expect(buildMcpProvider([connector()])).toBeInstanceOf(LiveMcpProvider);
  });

  it('returns a live provider when a secret is stored and the key is available', () => {
    const c = connector({ authRef: encryptSecret('tok', MASTER) });
    expect(buildMcpProvider([c], { masterKey: MASTER })).toBeInstanceOf(LiveMcpProvider);
  });

  /**
   * A machine with nothing configured must not start dialling out. This is the
   * shape that keeps tests, CI and local dev on the stub without anyone having
   * to remember to inject one.
   */
  it('falls back to the stub when no connector is enabled', () => {
    expect(buildMcpProvider([connector({ enabled: false })])).toBeInstanceOf(StubMcpProvider);
    expect(buildMcpProvider([])).toBeInstanceOf(StubMcpProvider);
  });

  /**
   * Connecting unauthenticated to a server that needs a token does not fail
   * loudly — it succeeds and reports zero tools, which is indistinguishable
   * from a server that has none. Refusing to go live is the honest move.
   */
  it('falls back to the stub when a secret is stored but no key is available', () => {
    const c = connector({ authRef: encryptSecret('tok', MASTER) });
    expect(buildMcpProvider([c], {})).toBeInstanceOf(StubMcpProvider);
  });

  it('still supports an explicit stub tool map, filtered to enabled connectors', async () => {
    const provider = buildMcpProvider(
      [connector({ id: 'on', enabled: true }), connector({ id: 'off', enabled: false })],
      {
        stubbedTools: new Map([
          ['on', [{ name: 'a', description: '', inputSchema: {} }]],
          ['off', [{ name: 'b', description: '', inputSchema: {} }]],
        ]),
      },
    );
    const ids = (await provider.listAllTools()).map((t) => t.connectorId);
    expect(ids).toContain('on');
    expect(ids).not.toContain('off');
  });
});

describe('secret storage', () => {
  it('round-trips a token', () => {
    expect(decryptSecret(encryptSecret('sh_tok_123', MASTER), MASTER)).toBe('sh_tok_123');
  });

  it('does not store the token in the clear', () => {
    expect(encryptSecret('sh_tok_123', MASTER)).not.toContain('sh_tok_123');
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    const good = encryptSecret('sh_tok_123', MASTER);
    const [iv, enc, tag] = good.split(':');
    const tampered = [iv, `${enc?.slice(0, -2)}00`, tag].join(':');
    expect(() => decryptSecret(tampered, MASTER)).toThrow();
  });

  it('refuses the wrong master key', () => {
    expect(() => decryptSecret(encryptSecret('x', MASTER), 'other-key')).toThrow();
  });
});

describe('LiveMcpProvider degrades instead of failing a run', () => {
  it('reports an unreachable endpoint as a failed test, not a throw', async () => {
    const provider = new LiveMcpProvider([], { timeoutMs: 200 });
    const result = await provider.testConnector('http://127.0.0.1:1/nope', 'http');
    expect(result.ok).toBe(false);
  });

  /**
   * The reason a timeout exists at all: listAllTools walks connectors serially
   * inside an Inngest step, and the deploy target has a hard per-step ceiling.
   * One hung server must not take the estimate with it.
   */
  it('gives up on a hanging endpoint within the timeout', async () => {
    // 10.255.255.1 is non-routable: connect() hangs rather than refusing.
    const provider = new LiveMcpProvider([], { timeoutMs: 300 });
    const started = Date.now();
    const result = await provider.testConnector('http://10.255.255.1:9/mcp', 'http');
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 10_000);

  it('contributes no tools for a connector whose secret it cannot decrypt', async () => {
    const c = connector({ authRef: encryptSecret('tok', MASTER) });
    // Built directly rather than through buildMcpProvider, which would have
    // refused — this pins the provider's own behaviour if it is ever handed one.
    const provider = new LiveMcpProvider([c], { timeoutMs: 200 });
    expect(await provider.listTools('c1')).toEqual([]);
  });

  it('returns nothing for an unknown connector id', async () => {
    expect(await new LiveMcpProvider([]).listTools('missing')).toEqual([]);
  });
});
