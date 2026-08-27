import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ─── MCP Tool shape ───────────────────────────────────────────────────────────

export type McpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpConnectorRecord = {
  id: string;
  name: string;
  transport: string;
  endpoint: string;
  authRef: string | null;
  enabled: boolean;
};

// ─── Secret encryption ────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;

function deriveKey(masterKey: string): Buffer {
  return scryptSync(masterKey, 'codup-mcp-salt', KEY_LEN);
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const key = deriveKey(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), enc.toString('hex'), tag.toString('hex')].join(':');
}

export function decryptSecret(ciphertext: string, masterKey: string): string {
  const [ivHex, encHex, tagHex] = ciphertext.split(':');
  if (!ivHex || !encHex || !tagHex) throw new Error('Invalid ciphertext format');
  const key = deriveKey(masterKey);
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ─── McpProvider ──────────────────────────────────────────────────────────────

export type McpTestResult =
  | { ok: true; tools: McpTool[] }
  | { ok: false; error: string };

export interface IMcpProvider {
  listTools(connectorId: string): Promise<McpTool[]>;
  listAllTools(): Promise<Array<McpTool & { connectorId: string }>>;
  /**
   * `authSecret` is the DECRYPTED bearer token, or undefined for an open
   * server. It has to be on this signature rather than resolved internally
   * because `listTools` delegates here — without it a `LiveMcpProvider` would
   * return `[]` for every authenticated connector, which looks exactly like a
   * server with no tools.
   */
  testConnector(endpoint: string, transport: string, authSecret?: string): Promise<McpTestResult>;
}

/**
 * Stub MCP provider for use when no live MCP servers are available.
 * BLOCKED-CREDENTIAL: Replace StubMcpProvider with LiveMcpProvider once server URLs are configured.
 */
export class StubMcpProvider implements IMcpProvider {
  private readonly stubbedTools: Map<string, McpTool[]>;

  constructor(stubbedTools: Map<string, McpTool[]> = new Map()) {
    this.stubbedTools = stubbedTools;
  }

  async listTools(connectorId: string): Promise<McpTool[]> {
    return this.stubbedTools.get(connectorId) ?? [];
  }

  async listAllTools(): Promise<Array<McpTool & { connectorId: string }>> {
    const result: Array<McpTool & { connectorId: string }> = [];
    for (const [connectorId, tools] of this.stubbedTools) {
      for (const tool of tools) {
        result.push({ ...tool, connectorId });
      }
    }
    return result;
  }

  async testConnector(
    endpoint: string,
    _transport: string,
    _authSecret?: string,
  ): Promise<McpTestResult> {
    if (!endpoint || endpoint === 'unreachable') {
      return { ok: false, error: 'Connection refused' };
    }
    return { ok: true, tools: [] };
  }
}

/**
 * How long any single MCP server gets before we give up on it.
 *
 * This is not politeness. `listAllTools` walks the enabled connectors serially
 * inside an Inngest step, and the deploy target has a hard 300s per-step
 * ceiling — so one hung connector does not fail one lookup, it fails the whole
 * estimate run. A connection that ERRORS already degrades to an empty tool
 * list; one that hangs had nothing stopping it.
 */
const DEFAULT_MCP_TIMEOUT_MS = 12_000;

/** SSE's handshake goes through its own fetch, which needs the header too. */
function authedFetch(secret: string): typeof fetch {
  return (input, init) =>
    fetch(input, {
      ...init,
      headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${secret}` },
    });
}

/** Reject rather than hang. Resolves to the loser's error, never silently. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Live MCP provider — connects to real MCP servers over Streamable HTTP (or SSE).
 * Uses the official @modelcontextprotocol/sdk client. The SDK is imported lazily
 * so that merely importing this module (e.g. for the StubMcpProvider) doesn't
 * pull the SDK into bundles that never talk to a live server.
 */
export class LiveMcpProvider implements IMcpProvider {
  private readonly connectors: Map<string, McpConnectorRecord>;
  private readonly masterKey: string | undefined;
  private readonly timeoutMs: number;

  constructor(
    connectors: McpConnectorRecord[] = [],
    opts: { masterKey?: string | undefined; timeoutMs?: number } = {},
  ) {
    this.connectors = new Map(connectors.map((c) => [c.id, c]));
    this.masterKey = opts.masterKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  }

  /**
   * The bearer token for a connector, or undefined for an open server.
   *
   * A connector with a stored secret and no master key available is a
   * misconfiguration, not an open server — say so rather than silently
   * connecting unauthenticated and reporting "0 tools".
   */
  private secretFor(connector: McpConnectorRecord): string | undefined {
    if (!connector.authRef) return undefined;
    if (!this.masterKey) {
      throw new Error(
        `Connector "${connector.name}" has a stored secret but ENCRYPTION_KEY is not set`,
      );
    }
    return decryptSecret(connector.authRef, this.masterKey);
  }

  /** Open a connected client to an endpoint; caller must close it. */
  private async connect(endpoint: string, transport: string, authSecret?: string) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const url = new URL(endpoint);

    // The SDK takes auth as ordinary request headers on the transport; there is
    // no separate auth channel for a static bearer token.
    const requestInit = authSecret
      ? { headers: { Authorization: `Bearer ${authSecret}` } }
      : undefined;

    let clientTransport;
    if (transport.toLowerCase().includes('sse')) {
      const { SSEClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/sse.js'
      );
      clientTransport = new SSEClientTransport(url, {
        ...(requestInit ? { requestInit, eventSourceInit: { fetch: authedFetch(authSecret!) } } : {}),
      });
    } else {
      // Default to Streamable HTTP (what Shopify and most hosted servers use).
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      clientTransport = new StreamableHTTPClientTransport(url, {
        ...(requestInit ? { requestInit } : {}),
      });
    }

    const client = new Client(
      { name: 'codup-ai-estimation', version: '0.0.1' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);
    return client;
  }

  private static toTools(result: { tools: Array<{ name: string; description?: string; inputSchema?: unknown }> }): McpTool[] {
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
    }));
  }

  async testConnector(
    endpoint: string,
    transport: string,
    authSecret?: string,
  ): Promise<McpTestResult> {
    if (!endpoint) {
      return { ok: false, error: 'Endpoint is required' };
    }
    let client: Awaited<ReturnType<LiveMcpProvider['connect']>> | undefined;
    try {
      client = await withTimeout(
        this.connect(endpoint, transport, authSecret),
        this.timeoutMs,
        `Connecting to ${endpoint}`,
      );
      const result = await withTimeout(
        client.listTools(),
        this.timeoutMs,
        `Listing tools on ${endpoint}`,
      );
      return { ok: true, tools: LiveMcpProvider.toTools(result) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try {
        await client?.close();
      } catch {
        // ignore close errors
      }
    }
  }

  async listTools(connectorId: string): Promise<McpTool[]> {
    const connector = this.connectors.get(connectorId);
    if (!connector) return [];
    let secret: string | undefined;
    try {
      secret = this.secretFor(connector);
    } catch {
      // A connector we cannot authenticate contributes nothing. Surfacing it as
      // an empty tool list keeps one misconfigured server from failing a run.
      return [];
    }
    const result = await this.testConnector(connector.endpoint, connector.transport, secret);
    return result.ok ? result.tools : [];
  }

  async listAllTools(): Promise<Array<McpTool & { connectorId: string }>> {
    const out: Array<McpTool & { connectorId: string }> = [];
    for (const connector of this.connectors.values()) {
      if (!connector.enabled) continue;
      const tools = await this.listTools(connector.id);
      for (const tool of tools) {
        out.push({ ...tool, connectorId: connector.id });
      }
    }
    return out;
  }
}

/**
 * The provider a run should use, given what the admin has actually configured.
 *
 * This used to return a `StubMcpProvider` even when handed real connector
 * records, which is why it had no production caller: there was no way to reach
 * a live server through it, so an admin could add, test and enable a connector
 * and it would influence exactly zero estimates.
 *
 * Falls back to the stub when there is nothing to connect to — no enabled
 * connectors, or no master key to decrypt their secrets with. That is not a
 * degraded mode to apologise for; it is the correct provider for a machine with
 * no MCP configured, and it keeps tests and local dev from dialling out.
 */
export function buildMcpProvider(
  connectors: McpConnectorRecord[],
  opts: { masterKey?: string | undefined; stubbedTools?: Map<string, McpTool[]> } = {},
): IMcpProvider {
  const enabled = connectors.filter((c) => c.enabled);

  if (opts.stubbedTools) {
    const enabledIds = new Set(enabled.map((c) => c.id));
    const filtered = new Map<string, McpTool[]>();
    for (const [id, tools] of opts.stubbedTools) {
      if (enabledIds.has(id)) filtered.set(id, tools);
    }
    return new StubMcpProvider(filtered);
  }

  if (enabled.length === 0) return new StubMcpProvider();
  if (enabled.some((c) => c.authRef) && !opts.masterKey) return new StubMcpProvider();

  return new LiveMcpProvider(enabled, { masterKey: opts.masterKey });
}
