import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { normaliseSOW, hashSOW } from './sow-utils';
import { computeCacheKey, memCacheGet, memCachePut, memCacheClear, type CacheKey } from './cache';
import { bootAgents, AGENT_KINDS, type AgentPromptConfig } from './agent-factory';
import { runSupervisor, type SupervisorDeps } from './supervisor';
import { StepError, withRetry } from './step-error';
import { PrismaClient } from '@repo/db';
import {
  ArchitectOutputSchema,
  RequirementSchema,
  type LibrarianOutput,
  type ArchivistOutput,
  type ArchitectOutput,
  type Requirement,
} from '@repo/shared';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let estimateId = '';

beforeAll(async () => {
  await db.$connect();
  memCacheClear();
  const user = await db.user.create({
    data: { email: `ws8-test-${Date.now()}@example.com`, hash: 'hash', role: 'ESTIMATOR' },
  });
  userId = user.id;
  const est = await db.estimate.create({
    data: {
      title: 'WS8 Test', sowText: 'Build a B2B checkout', sowHash: '',
      status: 'DRAFT', taxonomyVersionsPinned: {}, configVersion: 1,
      promptVersionsPinned: {}, modelConfig: {}, narrative: [], assumptions: [],
      agentState: {}, ownerId: userId,
    },
  });
  estimateId = est.id;
});

afterAll(async () => {
  memCacheClear();
  await db.menuItem.deleteMany({ where: { estimateId } });
  await db.estimate.delete({ where: { id: estimateId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

// ─── WS8-01: Agent instantiation ─────────────────────────────────────────────

describe('WS8-01: Agent instantiation from prompt config', () => {
  it('bootAgents creates one agent per AgentKind', () => {
    const configs: AgentPromptConfig[] = AGENT_KINDS.map((kind) => ({
      kind,
      instructions: `You are the ${kind} agent.`,
      modelString: 'openrouter/anthropic/claude-3-haiku',
    }));

    const agents = bootAgents(configs);
    expect(agents.size).toBe(AGENT_KINDS.length);
    for (const kind of AGENT_KINDS) {
      expect(agents.has(kind)).toBe(true);
    }
  });
});

// ─── WS8-02: SOW normalisation + sha256 ──────────────────────────────────────

describe('WS8-02: SOW normalisation + sha256 hashing', () => {
  const SOW = '  Build a B2B  checkout   flow\n  with Shopify  ';

  it('same input → same hash', () => {
    expect(hashSOW(SOW)).toBe(hashSOW(SOW));
  });

  it('whitespace and case normalised', () => {
    expect(hashSOW(SOW)).toBe(hashSOW(SOW.toUpperCase()));
    expect(hashSOW(SOW)).toBe(hashSOW('build a b2b checkout flow with shopify'));
  });

  it('different input → different hash', () => {
    expect(hashSOW('sow 1')).not.toBe(hashSOW('sow 2'));
  });

  it('normaliseSOW collapses whitespace', () => {
    expect(normaliseSOW('  hello   world  ')).toBe('hello world');
  });
});

// ─── WS8-03: Cache layer ─────────────────────────────────────────────────────

describe('WS8-03: Cache keyed by sowHash + pinnedVersions + modelConfig', () => {
  const baseKey: CacheKey = {
    sowHash: 'abc123',
    taxonomyVersionsPinned: { v: 1 },
    configVersion: 1,
    promptVersionsPinned: { LIBRARIAN: 1 },
    modelConfig: { model: 'claude-3-haiku' },
  };

  it('memCache: identical inputs return same cache entry', () => {
    memCacheClear();
    memCachePut(baseKey, 'est-1');
    expect(memCacheGet(baseKey)).toBe('est-1');
  });

  it('memCache: changed pin busts cache', () => {
    const changedKey: CacheKey = { ...baseKey, configVersion: 2 };
    expect(memCacheGet(changedKey)).toBeUndefined();
  });

  it('computeCacheKey: different inputs → different keys', () => {
    const key1 = computeCacheKey(baseKey);
    const key2 = computeCacheKey({ ...baseKey, sowHash: 'xyz789' });
    expect(key1).not.toBe(key2);
  });

  it('computeCacheKey: deterministic for same inputs', () => {
    expect(computeCacheKey(baseKey)).toBe(computeCacheKey(baseKey));
  });
});


/** A schema-valid Requirement. Only the fields a test varies are worth naming. */
function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return RequirementSchema.parse({
    id: 'REQ-001',
    text: 'Build B2B checkout flow',
    category: 'B2B',
    reqType: 'Checkout',
    projectSize: 'Mid-market',
    dataVolume: 'Low',
    integrationCount: 1,
    candidateMenuCardId: 'MC-B2B-CHECKOUT',
    taxonomyKey: 'b2b.checkout',
    sourceRef: 'SOW',
    ...overrides,
  });
}

// ─── WS8-04: Supervisor skeleton ─────────────────────────────────────────────

describe('WS8-04: Supervisor lifecycle + state write', () => {
  const stubLibrarian = vi.fn<SupervisorDeps['librarian']>();
  const stubArchivist = vi.fn<SupervisorDeps['archivist']>();
  const stubArchitect = vi.fn<SupervisorDeps['architect']>();

  const libOut: LibrarianOutput = {
    requirements: [makeRequirement({ text: 'checkout', taxonomyKey: 'b2b.checkout' })],
  };
  const archOut: ArchivistOutput = { matches: [] };
  const arcOut: ArchitectOutput = ArchitectOutputSchema.parse({
    narrative: ['Build B2B checkout'],
    assumptions: ['Shopify Plus'],
    menuItems: [],
  });

  it('runs Librarian→Archivist→Architect stubs end-to-end and writes state', async () => {
    stubLibrarian.mockResolvedValue(libOut);
    stubArchivist.mockResolvedValue(archOut);
    stubArchitect.mockResolvedValue(arcOut);
    memCacheClear();

    const result = await runSupervisor(
      { estimateId, sowText: 'Build a B2B checkout', mode: 'full' },
      { db, librarian: stubLibrarian, archivist: stubArchivist, architect: stubArchitect },
    );

    expect(result.status).toBe('REVIEW');
    expect(result.estimateId).toBe(estimateId);
    expect(stubLibrarian).toHaveBeenCalledOnce();
    expect(stubArchivist).toHaveBeenCalledOnce();
    expect(stubArchitect).toHaveBeenCalledOnce();

    const saved = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(saved.status).toBe('REVIEW');
    expect(saved.narrative).toEqual(['Build B2B checkout']);
  });

  it('returns cached result without agent calls on identical input', async () => {
    stubLibrarian.mockClear();
    stubArchivist.mockClear();
    stubArchitect.mockClear();

    const result = await runSupervisor(
      { estimateId, sowText: 'Build a B2B checkout', mode: 'full' },
      { db, librarian: stubLibrarian, archivist: stubArchivist, architect: stubArchitect },
    );

    expect(result.status).toBe('REVIEW');
    expect(stubLibrarian).not.toHaveBeenCalled();
  });
});

// ─── WS8-04: StepError + retry ───────────────────────────────────────────────

describe('WS8-04: StepError typed error + single retry', () => {
  it('withRetry succeeds on second attempt', async () => {
    let calls = 0;
    const result = await withRetry('LIBRARIAN', async () => {
      calls++;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('throws StepError after maxRetries exhausted', async () => {
    await expect(
      withRetry('ARCHIVIST', async () => { throw new Error('always fails'); }, 1),
    ).rejects.toBeInstanceOf(StepError);
  });
});
