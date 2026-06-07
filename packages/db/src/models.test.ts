import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from './generated/client/index.js';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

beforeAll(() => db.$connect());

afterAll(async () => {
  await db.$executeRaw`DELETE FROM "TaxonomyNodeVersion" WHERE "nodeKey" = 'test.node'`;
  await db.$executeRaw`DELETE FROM "TaxonomyNode" WHERE "key" = 'test.node'`;
  await db.$executeRaw`DELETE FROM "PromptVersion" WHERE "kind" = 'SUPERVISOR'::"AgentKind" AND "version" = 999`;
  await db.$executeRaw`DELETE FROM "EstimationConfig" WHERE "version" = 9999`;
  await db.$executeRaw`DELETE FROM "McpConnector" WHERE "name" = 'test-mcp'`;
  await db.$disconnect();
});

// ─── WS1-03: TaxonomyNode ─────────────────────────────────────────────────────

describe('WS1-03: TaxonomyNode CRUD', () => {
  it('creates a TaxonomyNode + TaxonomyNodeVersion', async () => {
    await db.taxonomyNode.create({
      data: { key: 'test.node', label: 'Test Node' },
    });
    const v = await db.taxonomyNodeVersion.create({
      data: {
        nodeKey: 'test.node',
        version: 1,
        label: 'Test Node v1',
        keywords: ['checkout'],
        active: true,
        changeMotivation: 'OTHER',
      },
    });
    expect(v.nodeKey).toBe('test.node');
    expect(v.active).toBe(true);

    const node = await db.taxonomyNode.findUnique({
      where: { key: 'test.node' },
      include: { versions: true },
    });
    expect(node?.versions).toHaveLength(1);
  });
});

// ─── WS1-04: Prompt + PromptVersion ──────────────────────────────────────────

describe('WS1-04: Prompt + PromptVersion', () => {
  it('creates a PromptVersion; only one active per kind enforced by application logic', async () => {
    // Ensure Prompt record exists (upsert since it uses @id on kind)
    await db.prompt.upsert({
      where: { kind: 'SUPERVISOR' },
      update: {},
      create: { kind: 'SUPERVISOR' },
    });

    const v = await db.promptVersion.create({
      data: {
        kind: 'SUPERVISOR',
        version: 999,
        body: 'You coordinate the council.',
        modelString: 'openrouter/anthropic/claude-3-5-sonnet',
        active: false,
        changeMotivation: 'OTHER',
      },
    });
    expect(v.kind).toBe('SUPERVISOR');
    expect(v.version).toBe(999);

    const found = await db.promptVersion.findUnique({
      where: { kind_version: { kind: 'SUPERVISOR', version: 999 } },
    });
    expect(found?.body).toContain('council');
  });
});

// ─── WS1-05: EstimationConfig ────────────────────────────────────────────────

describe('WS1-05: EstimationConfig active-version uniqueness', () => {
  it('creates config and only one should be active', async () => {
    const cfg = await db.estimationConfig.create({
      data: {
        version: 9999,
        active: false,
        complexityRules: { legacy: 4, integrations: 3, ai: 4, simpleWeb: 2 },
        pmCommunicationTaxPct: 0.1,
        baCommunicationTaxPct: 0.1,
        qaRegressionBufferPct: 0.2,
        infraBaseline: { envSetup: 8, cicd: 16, deploymentHypercare: 8 },
        changeMotivation: 'OTHER',
      },
    });
    expect(cfg.version).toBe(9999);

    const active = await db.estimationConfig.findMany({ where: { active: true } });
    // should have at most 1 active (application invariant)
    expect(active.length).toBeLessThanOrEqual(1);
  });
});

// ─── WS1-06: McpConnector ────────────────────────────────────────────────────

describe('WS1-06: McpConnector CRUD; authRef is reference not plaintext', () => {
  it('creates a connector with authRef as a reference string', async () => {
    const conn = await db.mcpConnector.create({
      data: {
        name: 'test-mcp',
        transport: 'http',
        endpoint: 'https://mcp.example.com',
        authRef: 'vault:mcp/test-mcp/token',
        enabled: false,
      },
    });
    expect(conn.authRef).toBe('vault:mcp/test-mcp/token');
    expect(conn.authRef).not.toMatch(/^sk-|Bearer |eyJ/);

    const read = await db.mcpConnector.findUnique({ where: { id: conn.id } });
    expect(read?.name).toBe('test-mcp');
    expect(read?.enabled).toBe(false);
  });
});
