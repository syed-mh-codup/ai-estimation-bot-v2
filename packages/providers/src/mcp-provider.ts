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

export type McpTestResult = { ok: true } | { ok: false; error: string };

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
    return { ok: true };
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
