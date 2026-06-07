import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { LiveMcpProvider } from './mcp-provider';

/**
 * Proves the LiveMcpProvider SUCCESS path against a real (local, stateless)
 * Streamable HTTP MCP server — connect → tools/list → mapped result. The other
 * tests only cover failure paths; this is the round trip that runs when a real
 * server (e.g. Shopify) is reachable. Offline, no credentials.
 */
describe('WS24-02: LiveMcpProvider success path (local MCP server)', () => {
  it('connects, lists tools, and returns ok:true with the tool', async () => {
    const httpServer = http.createServer(async (req, res) => {
      // Stateless: fresh server + transport per request.
      const server = new McpServer({ name: 'test-server', version: '1.0.0' });
      server.registerTool(
        'ping',
        { description: 'returns pong', inputSchema: {} },
        async () => ({ content: [{ type: 'text', text: 'pong' }] }),
      );
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;

    try {
      const result = await new LiveMcpProvider().testConnector(
        `http://127.0.0.1:${port}/mcp`,
        'http',
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.tools.map((t) => t.name)).toContain('ping');
      }
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});
