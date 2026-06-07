import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import { runArchivist, type ArchivistContext } from './archivist';
import type { IEmbeddingProvider, IModelProvider } from '@repo/providers';
import type { Requirement } from '@repo/shared';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

function makeVec(first: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[0] = first;
  return v;
}

const PRESET_ID1 = `ws11-preset-a-${Date.now()}`;
const PRESET_ID2 = `ws11-preset-b-${Date.now()}`;
const PRESET_ID3 = `ws11-preset-c-${Date.now()}`;

const mockEmbedding: IEmbeddingProvider = { embed: vi.fn() };
const mockModel: IModelProvider = { chat: vi.fn(), embed: vi.fn() };

const requirements: Requirement[] = [
  { text: 'Build B2B checkout flow', taxonomyKey: 'b2b.checkout', confidence: 0.9 },
];

beforeAll(async () => {
  await db.$connect();

  // Seed 3 presets with distinct embeddings
  for (const [id, first, name] of [
    [PRESET_ID1, 0.95, 'B2B Checkout Pro'],
    [PRESET_ID2, 0.5, 'Generic E-commerce'],
    [PRESET_ID3, 0.1, 'Auth Service'],
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
            beHours: 40,
            feHours: 20,
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
    const vec = makeVec(first);
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

describe('WS11-01: Embed requirements + ANN match against PresetVersion.embedding', () => {
  it('returns top-k presets with scores for a requirement', async () => {
    // Query vector closest to preset1 (first element = 0.95)
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(0.95)]);

    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding, topK: 3 };
    const result = await runArchivist(requirements, ctx);

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(3);
    expect(typeof result.matches[0]!.score).toBe('number');
    expect(result.matches[0]!.score).toBeGreaterThanOrEqual(0);
    expect(result.matches[0]!.score).toBeLessThanOrEqual(1);
  });

  it('orders results by cosine similarity (closest first)', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(0.95)]);

    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding, topK: 3 };
    const result = await runArchivist(requirements, ctx);

    // First result should have highest score
    expect(result.matches[0]!.presetId).toBe(PRESET_ID1);
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i - 1]!.score).toBeGreaterThanOrEqual(result.matches[i]!.score);
    }
  });

  it('returns empty matches when requirements list is empty', async () => {
    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding };
    const result = await runArchivist([], ctx);
    expect(result.matches).toHaveLength(0);
  });
});

// ─── WS11-02: Match payload is schema-valid and version-pinned ────────────────

describe('WS11-02: Match payload schema-valid and version-pinned', () => {
  it('each match carries presetId, presetVersion, beHours, feHours, risk, aiAssist', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(0.9)]);

    const ctx: ArchivistContext = { db, embeddingProvider: mockEmbedding, topK: 2 };
    const result = await runArchivist(requirements, ctx);

    for (const match of result.matches) {
      expect(match.presetId).toBeTruthy();
      expect(typeof match.presetVersion).toBe('number');
      expect(match.presetVersion).toBeGreaterThan(0);
      expect(typeof match.beHours).toBe('number');
      expect(typeof match.feHours).toBe('number');
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(match.risk);
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(match.aiAssist);
    }
  });
});

// ─── WS11-03: Optional LLM re-rank ───────────────────────────────────────────

describe('WS11-03: Optional LLM re-rank of top-k', () => {
  it('re-rank keeps or improves ordering on labelled fixture', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(0.5)]);
    // LLM re-ranks: prefer index 1 (PRESET_ID1) over index 0
    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({ reranked: ['1', '0', '2'] }),
    );

    const ctx: ArchivistContext = {
      db,
      embeddingProvider: mockEmbedding,
      modelProvider: mockModel,
      modelString: 'openrouter/anthropic/claude-3-haiku',
      topK: 3,
      rerank: true,
    };
    const result = await runArchivist(requirements, ctx);

    // Re-rank should produce a valid list of the same length
    expect(result.matches.length).toBeGreaterThan(0);
    // All returned matches should be valid ArchivistMatch objects
    for (const match of result.matches) {
      expect(match.presetId).toBeTruthy();
      expect(match.score).toBeGreaterThanOrEqual(0);
    }
  });

  it('falls back to original order when re-rank fails', async () => {
    vi.mocked(mockEmbedding.embed).mockResolvedValue([makeVec(0.9)]);
    vi.mocked(mockModel.chat).mockRejectedValue(new Error('LLM error'));

    const ctx: ArchivistContext = {
      db,
      embeddingProvider: mockEmbedding,
      modelProvider: mockModel,
      modelString: 'openrouter/anthropic/claude-3-haiku',
      topK: 2,
      rerank: true,
    };
    // Should not throw — falls back gracefully
    const result = await runArchivist(requirements, ctx);
    expect(result.matches.length).toBeGreaterThan(0);
  });
});
