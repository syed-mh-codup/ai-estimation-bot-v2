import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import { runArchivist, type ArchivistContext } from './archivist';
import type { IEmbeddingProvider, IModelProvider } from '@repo/providers';
import type { Requirement } from '@repo/shared';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

// Orthogonal unit vectors: each preset uses a unique dimension so cosine ordering is deterministic
function makeVec(dim: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[dim] = 1.0;
  return v;
}

const PRESET_ID1 = `ws11-preset-a-${Date.now()}`;
const PRESET_ID2 = `ws11-preset-b-${Date.now()}`;
const PRESET_ID3 = `ws11-preset-c-${Date.now()}`;

const mockEmbedding: IEmbeddingProvider = { embed: vi.fn() };
const mockModel: IModelProvider = { chat: vi.fn(), embed: vi.fn() };

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-001',
    text: 'Build B2B checkout flow',
    category: 'B2B',
    reqType: 'Checkout',
    platforms: [],
    projectSize: 'Mid-market',
    dataVolume: 'Low',
    integrationCount: 1,
    candidateMenuCardId: 'MC-B2B-CHECKOUT',
    taxonomyKey: 'b2b.checkout',
    sourceRef: 'SOW',
    ambiguities: [],
    blocksEstimation: false,
    ...overrides,
  };
}

beforeAll(async () => {
  await db.$connect();

  // Seed 3 presets with orthogonal embeddings (dims 100/200/300 to avoid WS9 overlap)
  for (const [id, dim, name] of [
    [PRESET_ID1, 100, 'B2B Checkout Pro'],
    [PRESET_ID2, 200, 'Generic E-commerce'],
    [PRESET_ID3, 300, 'Auth Service'],
  ] as [string, number, string][]) {
    const p = await db.preset.create({
      data: {
        id,
        versions: {
          create: {
            version: 1,
            active: true,
            category: 'ecommerce',
            name,
            description: `${name} description`,
            devHours: 60,
            touchesBackend: true,
            touchesFrontend: true,
            platforms: [],
            reqType: 'FEATURE',
            keywords: [],
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
            taxonomyKey: 'b2b.checkout',
          },
        },
      },
      include: { versions: true },
    });
    const vec = makeVec(dim);
    await db.$executeRawUnsafe(
      `UPDATE "PresetVersion" SET embedding = $1::vector WHERE id = $2`,
      `[${vec.join(',')}]`,
      p.versions[0]!.id,
    );
  }
});

afterAll(async () => {
  await db.presetVersion.deleteMany({ where: { presetId: { in: [PRESET_ID1, PRESET_ID2, PRESET_ID3] } } });
  await db.preset.deleteMany({ where: { id: { in: [PRESET_ID1, PRESET_ID2, PRESET_ID3] } } });
  await db.$disconnect();
});

// ─── WS11-01: Embed requirements + ANN match ──────────────────────────────────

describe('WS11-01: Embed each requirement + ANN match against PresetVersion.embedding', () => {
  it('returns one match per requirement, with a real coverage + score', async () => {
    // Query with dim=100 → PRESET_ID1 has cosine=1.0 (exact match)
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(100)]);

    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding, topK: 3 };
    const result = await runArchivist([makeRequirement()], ctx);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.presetId).toBe(PRESET_ID1);
    expect(result.matches[0]!.coverage).toBe('full');
    expect(typeof result.matches[0]!.score).toBe('number');
    expect(result.matches[0]!.score).toBeGreaterThanOrEqual(0);
    expect(result.matches[0]!.score).toBeLessThanOrEqual(1);
  });

  it('picks the nearest preset per requirement independently', async () => {
    vi.mocked(mockEmbedding.embed)
      .mockResolvedValueOnce([makeVec(100)]) // req A → preset 1
      .mockResolvedValueOnce([makeVec(200)]); // req B → preset 2

    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding, topK: 3 };
    const result = await runArchivist(
      [makeRequirement({ id: 'REQ-001' }), makeRequirement({ id: 'REQ-002', text: 'Generic e-commerce' })],
      ctx,
    );

    expect(result.matches).toHaveLength(2);
    expect(result.matches.find((m) => m.requirementId === 'REQ-001')?.presetId).toBe(PRESET_ID1);
    expect(result.matches.find((m) => m.requirementId === 'REQ-002')?.presetId).toBe(PRESET_ID2);
  });

  it('returns empty matches when requirements list is empty', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(100)]);
    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding };
    const result = await runArchivist([], ctx);
    expect(result.matches).toHaveLength(0);
  });

  it('returns coverage:none (never fabricating a preset) when nothing embeds', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([]);
    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding };
    const result = await runArchivist([makeRequirement()], ctx);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.coverage).toBe('none');
    expect(result.matches[0]!.presetId).toBeUndefined();
  });
});

// ─── WS11-02: Match payload is schema-valid and version-pinned ────────────────

describe('WS11-02: Match payload schema-valid, version-pinned, carries adjustment signals', () => {
  it('a full-coverage match carries presetId, presetVersion, devHours, and adjustments', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(100)]);

    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding, topK: 2 };
    const result = await runArchivist([makeRequirement()], ctx);

    const match = result.matches[0]!;
    expect(match.presetId).toBeTruthy();
    expect(typeof match.presetVersion).toBe('number');
    expect(match.presetVersion).toBeGreaterThan(0);
    expect(typeof match.devHours).toBe('number');
    expect(['Low', 'Medium', 'High']).toContain(match.adjustments.risk);
    expect(['Low', 'Medium', 'High']).toContain(match.adjustments.aiAssist);
    expect(match.sequencing).toBeDefined();
  });
});

// ─── WS11-03: Optional LLM re-rank ───────────────────────────────────────────

describe('WS11-03: Optional LLM re-rank of top-k candidates per requirement', () => {
  it('re-rank can promote a different candidate to the top', async () => {
    // A blended query (nonzero on both dim=100 and dim=200) gives both
    // PRESET_ID1 and PRESET_ID2 moderate, nonzero similarity — so promoting
    // PRESET_ID2 via rerank still lands on a real (non-"none") coverage.
    const blended = makeVec(100).map((v, i) => (i === 200 ? 0.6 : v));
    vi.mocked(mockEmbedding.embed).mockResolvedValue([blended]);
    // PRESET_ID1 is the vector-nearest (index 0); force the LLM to prefer index 1 instead.
    vi.mocked(mockModel.chat).mockResolvedValue(JSON.stringify({ reranked: ['1', '0', '2'] }));

    const ctx: ArchivistContext = {
      db,
      embeddingProvider: mockEmbedding,
      modelProvider: mockModel,
      modelString: 'openrouter/anthropic/claude-3-haiku',
      topK: 3,
      rerank: true,
    };
    const result = await runArchivist([makeRequirement()], ctx);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.presetId).toBe(PRESET_ID2);
  });

  it('falls back to vector order when re-rank fails', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(100)]);
    vi.mocked(mockModel.chat).mockRejectedValue(new Error('LLM error'));

    const ctx: ArchivistContext = {
      db,
      embeddingProvider: mockEmbedding,
      modelProvider: mockModel,
      modelString: 'openrouter/anthropic/claude-3-haiku',
      topK: 2,
      rerank: true,
    };
    const result = await runArchivist([makeRequirement()], ctx);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.presetId).toBe(PRESET_ID1);
  });
});
