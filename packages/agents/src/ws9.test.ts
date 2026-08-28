import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import { queryPresetsByVector } from './rag-retriever';
import { runLibrarian, type LibrarianContext, type TaxonomyEntry } from './librarian';
import type { IModelProvider } from '@repo/providers';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

// Use orthogonal unit vectors (each preset in a unique dimension) to ensure
// cosine similarity ordering is deterministic across parallel test suites.
function makeVec(dim: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[dim] = 1.0;
  return v;
}

// ─── Fixture data ─────────────────────────────────────────────────────────────
const TAX_KEY1 = `ws9-b2b-checkout-${Date.now()}`;
const TAX_KEY2 = `ws9-auth-sso-${Date.now()}`;
const PRESET_ID1 = `ws9-preset-checkout-${Date.now()}`;
const PRESET_ID2 = `ws9-preset-sso-${Date.now()}`;

let userId = '';

beforeAll(async () => {
  await db.$connect();

  const user = await db.user.create({
    data: { email: `ws9-test-${Date.now()}@example.com`, hash: 'hash', role: 'ESTIMATOR' },
  });
  userId = user.id;

  // Seed taxonomy nodes (TaxonomyNode requires: key, label)
  await db.taxonomyNode.create({
    data: {
      key: TAX_KEY1,
      label: 'B2B Checkout Flow',
      versions: {
        create: {
          label: 'B2B Checkout Flow',
          keywords: ['checkout', 'cart', 'payment', 'order'],
          active: true,
          version: 1,
          changeMotivation: 'OTHER',
        },
      },
    },
  });

  await db.taxonomyNode.create({
    data: {
      key: TAX_KEY2,
      label: 'SSO / Auth',
      versions: {
        create: {
          label: 'SSO / Auth',
          keywords: ['sso', 'oauth', 'saml', 'authentication', 'login'],
          active: true,
          version: 1,
          changeMotivation: 'OTHER',
        },
      },
    },
  });

  // Seed presets (embedding is Unsupported type — set via raw SQL after create)
  // WS9 uses dimensions 0 and 1 (orthogonal unit vectors for isolation)
  const preset1 = await db.preset.create({
    data: {
      id: PRESET_ID1,
      versions: {
        create: {
          version: 1,
          active: true,
          category: 'ecommerce',
          name: 'B2B Checkout',
          description: 'B2B multi-step checkout',
          devHours: 70,
          touchesBackend: true,
          touchesFrontend: true,
          platforms: [],
          reqType: 'FEATURE',
          keywords: ['checkout', 'cart', 'payment'],
          userStoryTags: [],
          projectSizeFit: [],
          integrationCount: 1,
          dataVolume: 'LOW',
          phase: 'CORE',
          requires: [],
          blocks: [],
          canParallel: true,
          aiAssist: 'LOW',
          risk: 'MEDIUM',
          spikeNeeded: false,
          notes: '',
          changeMotivation: 'OTHER',
        },
      },
    },
    include: { versions: true },
  });
  await db.$executeRawUnsafe(
    `UPDATE "PresetVersion" SET embedding = $1::vector WHERE id = $2`,
    `[${makeVec(0).join(',')}]`,
    preset1.versions[0]!.id,
  );

  const preset2 = await db.preset.create({
    data: {
      id: PRESET_ID2,
      versions: {
        create: {
          version: 1,
          active: true,
          category: 'auth',
          name: 'SSO Integration',
          description: 'Single sign-on OAuth2',
          devHours: 30,
          touchesBackend: true,
          touchesFrontend: true,
          platforms: [],
          reqType: 'FEATURE',
          keywords: ['sso', 'oauth'],
          userStoryTags: [],
          projectSizeFit: [],
          integrationCount: 1,
          dataVolume: 'LOW',
          phase: 'CORE',
          requires: [],
          blocks: [],
          canParallel: true,
          aiAssist: 'LOW',
          risk: 'LOW',
          spikeNeeded: false,
          notes: '',
          changeMotivation: 'OTHER',
        },
      },
    },
    include: { versions: true },
  });
  await db.$executeRawUnsafe(
    `UPDATE "PresetVersion" SET embedding = $1::vector WHERE id = $2`,
    `[${makeVec(1).join(',')}]`,
    preset2.versions[0]!.id,
  );
});

afterAll(async () => {
  // Clean up in dependency order
  await db.presetVersion.deleteMany({ where: { presetId: { in: [PRESET_ID1, PRESET_ID2] } } });
  await db.preset.deleteMany({ where: { id: { in: [PRESET_ID1, PRESET_ID2] } } });
  await db.taxonomyNodeVersion.deleteMany({ where: { nodeKey: { in: [TAX_KEY1, TAX_KEY2] } } });
  await db.taxonomyNode.deleteMany({ where: { key: { in: [TAX_KEY1, TAX_KEY2] } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

// ─── WS9-01: RAG retriever ───────────────────────────────────────────────────

describe('WS9-01: RAG retriever over taxonomy + preset corpus', () => {
  it('queryPresetsByVector returns presets ordered by cosine similarity', async () => {
    // Query with dim=0 unit vector → PRESET_ID1 (dim=0) should be first
    const queryVec = makeVec(0);
    const results = await queryPresetsByVector(db, queryVec, 5);
    expect(results.length).toBeGreaterThan(0);
    // First result should be PRESET_ID1 (only one with non-zero in dim 0)
    expect(results[0]?.presetId).toBe(PRESET_ID1);
    expect(typeof results[0]?.score).toBe('number');
    expect(results[0]?.score).toBeGreaterThanOrEqual(0);
    expect(results[0]?.score).toBeLessThanOrEqual(1);
  });

  it('queryPresetsByVector returns fewer results than k if not enough presets', async () => {
    const queryVec = makeVec(0);
    const results = await queryPresetsByVector(db, queryVec, 100);
    // We only seeded 2 presets in this test
    expect(results.length).toBeLessThanOrEqual(100);
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─── WS9-02: Librarian agent ─────────────────────────────────────────────────

function makeLLMRequirement(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    text: 'Build B2B checkout flow with cart management',
    category: 'B2B',
    reqType: 'Checkout',
    platforms: ['Shopify'],
    projectSize: 'Mid-market',
    dataVolume: 'Low',
    integrationCount: 1,
    candidateMenuCardId: 'MC-B2B-CHECKOUT',
    taxonomyKey: 'b2b.checkout',
    sourceRef: 'SOW section 1',
    ambiguities: [],
    blocksEstimation: false,
    ...overrides,
  };
}

describe('WS9-02: Librarian agent SOW → requirements with the controlled envelope', () => {
  const mockModelProvider: IModelProvider = {
    chat: vi.fn(),
    chatStream: vi.fn(),
    embed: vi.fn(),
  };

  const libCtx: LibrarianContext = {
    modelProvider: mockModelProvider,
    modelString: 'openrouter/anthropic/claude-3-haiku',
    instructions: 'You are the Librarian agent. Decompose SOW into requirements.',
  };

  const taxonomy: TaxonomyEntry[] = [
    { key: 'b2b.checkout', label: 'B2B Checkout Flow', keywords: ['checkout', 'cart', 'payment'] },
    { key: 'auth.sso', label: 'SSO / Auth', keywords: ['sso', 'oauth', 'authentication'] },
  ];

  it('maps requirements to valid taxonomy keys and assigns sequential REQ ids', async () => {
    vi.mocked(mockModelProvider.chat).mockResolvedValue(
      JSON.stringify({
        requirements: [
          makeLLMRequirement(),
          makeLLMRequirement({
            text: 'Implement SSO with OAuth2',
            category: 'B2B',
            reqType: 'Authentication',
            candidateMenuCardId: 'MC-B2B-AUTH',
            taxonomyKey: 'auth.sso',
          }),
        ],
      }),
    );

    const result = await runLibrarian('Build B2B checkout with SSO', taxonomy, libCtx);
    expect(result.requirements).toHaveLength(2);
    expect(result.requirements[0]?.id).toBe('REQ-001');
    expect(result.requirements[1]?.id).toBe('REQ-002');
    expect(result.requirements[0]?.taxonomyKey).toBe('b2b.checkout');
    expect(result.requirements[1]?.taxonomyKey).toBe('auth.sso');
  });

  it('flags unmapped requirements with null taxonomyKey', async () => {
    vi.mocked(mockModelProvider.chat).mockResolvedValue(
      JSON.stringify({
        requirements: [
          makeLLMRequirement({ text: 'Build quantum computing module', taxonomyKey: null }),
        ],
      }),
    );

    const result = await runLibrarian('Build quantum computing module', taxonomy, libCtx);
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.taxonomyKey).toBeNull();
  });

  it('handles LLM response wrapped in markdown code block', async () => {
    vi.mocked(mockModelProvider.chat).mockResolvedValue(
      '```json\n' + JSON.stringify({ requirements: [makeLLMRequirement()] }) + '\n```',
    );

    const result = await runLibrarian('Checkout integration', taxonomy, libCtx);
    expect(result.requirements).toHaveLength(1);
    expect(result.requirements[0]?.taxonomyKey).toBe('b2b.checkout');
  });

  it('throws loudly (no silent fallback) on a malformed response', async () => {
    vi.mocked(mockModelProvider.chat).mockResolvedValue('not json at all, sorry');

    await expect(runLibrarian('Checkout integration', taxonomy, libCtx)).rejects.toThrow();
  });

  it('accepts a category/reqType/platform outside the ecommerce example vocabulary (open classification, not a closed enum)', async () => {
    vi.mocked(mockModelProvider.chat).mockResolvedValue(
      JSON.stringify({
        requirements: [
          makeLLMRequirement({
            category: 'Conversational AI',
            reqType: 'Simulation Design',
            platforms: ['LLM Provider'],
          }),
        ],
      }),
    );

    const result = await runLibrarian('Checkout integration', taxonomy, libCtx);
    expect(result.requirements[0]?.category).toBe('Conversational AI');
    expect(result.requirements[0]?.reqType).toBe('Simulation Design');
    expect(result.requirements[0]?.platforms).toEqual(['LLM Provider']);
  });

  it('rejects a requirement with a blank category (still requires a real, non-empty label)', async () => {
    vi.mocked(mockModelProvider.chat).mockResolvedValue(
      JSON.stringify({
        requirements: [makeLLMRequirement({ category: '' })],
      }),
    );

    await expect(runLibrarian('Checkout integration', taxonomy, libCtx)).rejects.toThrow();
  });
});

// ─── WS9-03: Determinism check ───────────────────────────────────────────────

describe('WS9-03: Determinism — same SOW → identical requirement mapping across 3 runs', () => {
  const mockModelProvider: IModelProvider = {
    chat: vi.fn(),
    chatStream: vi.fn(),
    embed: vi.fn(),
  };

  const libCtx: LibrarianContext = {
    modelProvider: mockModelProvider,
    modelString: 'openrouter/anthropic/claude-3-haiku',
    instructions: 'You are the Librarian agent.',
  };

  const taxonomy: TaxonomyEntry[] = [
    { key: 'b2b.checkout', label: 'B2B Checkout Flow', keywords: ['checkout'] },
  ];

  const fixedResponse = JSON.stringify({ requirements: [makeLLMRequirement()] });

  it('produces identical mapping across 3 runs (temperature=0)', async () => {
    vi.mocked(mockModelProvider.chat).mockResolvedValue(fixedResponse);

    const sow = 'Build a B2B checkout flow with cart management and payment processing';
    const run1 = await runLibrarian(sow, taxonomy, libCtx);
    const run2 = await runLibrarian(sow, taxonomy, libCtx);
    const run3 = await runLibrarian(sow, taxonomy, libCtx);

    expect(run1).toEqual(run2);
    expect(run2).toEqual(run3);
  });
});
