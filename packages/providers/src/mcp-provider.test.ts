import { describe, it, expect } from 'vitest';
import {
  StubMcpProvider,
  buildMcpProvider,
  encryptSecret,
  decryptSecret,
  type McpTool,
} from './mcp-provider';

const MASTER_KEY = 'test-master-key-for-testing-only';

const SAMPLE_TOOLS: McpTool[] = [
  {
    name: 'get_product',
    description: 'Fetch a product by ID',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'list_orders',
    description: 'List orders',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── WS4-01: tool discovery, disabled connectors excluded ─────────────────────

describe('WS4-01: McpProvider tool discovery', () => {
  it('lists tools from enabled connector', async () => {
    const stubbedTools = new Map([['conn1', SAMPLE_TOOLS]]);
    const provider = new StubMcpProvider(stubbedTools);
    const tools = await provider.listTools('conn1');
    expect(tools).toHaveLength(2);
    expect(tools[0]?.name).toBe('get_product');
  });

  it('excludes disabled connectors from buildMcpProvider', async () => {
    const connectors = [
      { id: 'c1', name: 'enabled-server', transport: 'http', endpoint: 'http://enabled', authRef: null, enabled: true },
      { id: 'c2', name: 'disabled-server', transport: 'http', endpoint: 'http://disabled', authRef: null, enabled: false },
    ];
    const stubbedTools = new Map<string, McpTool[]>([
      ['c1', SAMPLE_TOOLS],
      ['c2', SAMPLE_TOOLS],
    ]);
    const provider = buildMcpProvider(connectors, stubbedTools);
    const allTools = await provider.listAllTools();
    const connectorIds = allTools.map((t) => t.connectorId);
    expect(connectorIds).toContain('c1');
    expect(connectorIds).not.toContain('c2');
  });

  it('listAllTools includes connectorId on each tool', async () => {
    const stubbedTools = new Map([['c1', SAMPLE_TOOLS]]);
    const provider = new StubMcpProvider(stubbedTools);
    const all = await provider.listAllTools();
    expect(all.every((t) => t.connectorId === 'c1')).toBe(true);
  });
});

// ─── WS4-02: connection test routine ─────────────────────────────────────────

describe('WS4-02: testConnector', () => {
  it('returns ok:true for valid endpoint', async () => {
    const provider = new StubMcpProvider();
    const result = await provider.testConnector('https://mcp.example.com', 'http');
    expect(result.ok).toBe(true);
  });

  it('returns ok:false for unreachable endpoint', async () => {
    const provider = new StubMcpProvider();
    const result = await provider.testConnector('unreachable', 'http');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
    }
  });
});

// ─── WS4-03: encrypted secret storage ────────────────────────────────────────

describe('WS4-03: encrypted secret round-trip', () => {
  it('encrypts and decrypts a secret correctly', () => {
    const secret = 'sk-shopify-mcp-token-12345';
    const ciphertext = encryptSecret(secret, MASTER_KEY);
    const plaintext = decryptSecret(ciphertext, MASTER_KEY);
    expect(plaintext).toBe(secret);
  });

  it('ciphertext differs from plaintext (never stored in clear)', () => {
    const secret = 'sk-shopify-mcp-token-12345';
    const ciphertext = encryptSecret(secret, MASTER_KEY);
    expect(ciphertext).not.toBe(secret);
    expect(ciphertext).not.toContain(secret);
  });

  it('wrong key fails to decrypt', () => {
    const secret = 'sk-secret';
    const ciphertext = encryptSecret(secret, MASTER_KEY);
    expect(() => decryptSecret(ciphertext, 'wrong-key')).toThrow();
  });
});

// ─── WS4-04: tool schema contract test ───────────────────────────────────────

describe('WS4-04: MCP tool schema contract', () => {
  it('tool list from stub matches expected shape', async () => {
    const stubbedTools = new Map([['c1', SAMPLE_TOOLS]]);
    const provider = new StubMcpProvider(stubbedTools);
    const tools = await provider.listTools('c1');

    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('description');
      expect(tool).toHaveProperty('inputSchema');
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.inputSchema).toBe('object');
    }
  });
});
