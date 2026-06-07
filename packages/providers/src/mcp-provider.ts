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
  testConnector(endpoint: string, transport: string): Promise<McpTestResult>;
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

  async testConnector(endpoint: string, _transport: string): Promise<McpTestResult> {
    if (!endpoint || endpoint === 'unreachable') {
      return { ok: false, error: 'Connection refused' };
    }
    return { ok: true, tools: [] };
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

  constructor(connectors: McpConnectorRecord[] = []) {
    this.connectors = new Map(connectors.map((c) => [c.id, c]));
  }

  /** Open a connected client to an endpoint; caller must close it. */
  private async connect(endpoint: string, transport: string) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const url = new URL(endpoint);

    let clientTransport;
    if (transport.toLowerCase().includes('sse')) {
      const { SSEClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/sse.js'
      );
      clientTransport = new SSEClientTransport(url);
    } else {
      // Default to Streamable HTTP (what Shopify and most hosted servers use).
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      clientTransport = new StreamableHTTPClientTransport(url);
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

  async testConnector(endpoint: string, transport: string): Promise<McpTestResult> {
    if (!endpoint) {
      return { ok: false, error: 'Endpoint is required' };
    }
    let client: Awaited<ReturnType<LiveMcpProvider['connect']>> | undefined;
    try {
      client = await this.connect(endpoint, transport);
      const result = await client.listTools();
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
    const result = await this.testConnector(connector.endpoint, connector.transport);
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
 * Build an McpProvider from a list of enabled connector records.
 * Disabled connectors are excluded.
 */
export function buildMcpProvider(
  connectors: McpConnectorRecord[],
  stubbedTools?: Map<string, McpTool[]>,
): IMcpProvider {
  const enabledIds = new Set(connectors.filter((c) => c.enabled).map((c) => c.id));
  const filtered = new Map<string, McpTool[]>();

  if (stubbedTools) {
    for (const [id, tools] of stubbedTools) {
      if (enabledIds.has(id)) {
        filtered.set(id, tools);
      }
    }
  }

  return new StubMcpProvider(filtered);
}
