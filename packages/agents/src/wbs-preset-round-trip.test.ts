import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@repo/db';
import type { IEmbeddingProvider } from '@repo/providers';
import type { Requirement, SpecialistInput } from '@repo/shared';
import { promoteEstimate, backfillPresetEmbeddings, PROMOTION_MATCH_THRESHOLD } from './writeback';
import { runArchivist } from './archivist';
import { describeCoverage } from './specialist';
import { createUsageRecorder } from './usage-recorder';

/**
 * The WBS ⇄ preset library round trip, closed end to end.
 *
 * Promotion had tests. Retrieval had tests. The round trip did not — and that is
 * the gap `beHours = Σ DEV; feHours = round(beHours * 0.4)` lived in for months:
 * a 1.4× inflation on every promoted preset, compounding through the library
 * (100 → 140 → 196 → 274) because promoted presets anchor the next estimate.
 * Nothing caught it because it was perfectly type-correct — two Int columns, no
 * mismatch anywhere. Types check shape, not meaning. Only reading the number
 * back out notices that what came out is 1.4× what went in.
 *
 * So this test refuses to assert on either half in isolation. It starts from
 * persisted `MenuItem`/`RoleLineItem` rows, promotes through the real
 * production entry point, indexes with the same routine the Inngest function
 * calls, retrieves through real pgvector SQL, and asserts the anchor handed to
 * the estimating prompt is the number that was estimated.
 *
 * Where it deliberately stops: `describeCoverage` renders the anchor into the
 * specialist prompt and tells the model "Treat this as an anchor, not a final
 * answer". Past that an LLM re-derives every figure, so the rendered string is
 * the last honestly assertable point in the loop — and it is the whole span the
 * 1.4× bug lived in.
 *
 * No LLM is involved: the embedding provider is a mock returning a one-hot
 * vector, so cosine similarity through real pgvector is exactly 1.0 and the
 * match is deterministic.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

/**
 * One-hot query/document vectors make the cosine exact instead of approximate.
 * Axes 0, 1, 7, 11, 100, 200 and 400 are already claimed by ws9, ws11, ws20 and
 * preset-embedding; test files share one database, so a reused axis would tie
 * two rows at score 1.0 and make top-1 arbitrary. 777/778 are unclaimed.
 */
function makeVec(dim: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[dim] = 1.0;
  return v;
}
const AXIS_MINTED = 777;
const AXIS_VERSIONED = 778;

const ANCHOR_PRESET = 'TEST-ROUNDTRIP-ANCHOR';

/**
 * DEV quarter-hours that sum to a whole number, so `Math.round` in
 * `devEffortOf` is a genuine no-op and the round trip can be asserted with
 * strict equality rather than a tolerance that would hide a small drift.
 */
const DEV_HOURS = [20.5, 9.5];
const EXPECTED_DEV = 30;
/** QA/PM/BA hours that must never reach `devHours`. */
const OTHER_ROLE_HOURS = { QA: 8.25, PM: 5.5, BA: 4.25 };
const ALL_ROLES_TOTAL = 48;

const mockEmbedding: IEmbeddingProvider = { embed: vi.fn(), dimension: 1536 };

let userId = '';
let estimateId = '';
const mintedPresetIds = new Set<string>();

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-001',
    text: 'B2B checkout with volume pricing tiers',
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

/**
 * Persist a real card, not an in-memory DTO. The Prisma-row → `MenuItem`
 * mapping inside `promoteEstimate` is hand-written, so entering the loop below
 * it would skip the one step the compiler does not protect.
 */
async function seedCard(opts: { sourcePresetId?: string; matchScore?: number } = {}) {
  return db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: 'b2b.checkout',
      title: 'B2B checkout with volume pricing',
      enabled: true,
      sourcePresetId: opts.sourcePresetId ?? null,
      matchScore: opts.matchScore ?? null,
      lineItems: {
        create: [
          { role: 'DEV', baseHours: DEV_HOURS[0]!, taxedHours: DEV_HOURS[0]!, touchesBackend: true },
          { role: 'DEV', baseHours: DEV_HOURS[1]!, taxedHours: DEV_HOURS[1]!, touchesFrontend: true },
          { role: 'QA', baseHours: OTHER_ROLE_HOURS.QA, taxedHours: OTHER_ROLE_HOURS.QA },
          { role: 'PM', baseHours: OTHER_ROLE_HOURS.PM, taxedHours: OTHER_ROLE_HOURS.PM },
          { role: 'BA', baseHours: OTHER_ROLE_HOURS.BA, taxedHours: OTHER_ROLE_HOURS.BA },
        ],
      },
    },
  });
}

/**
 * Pin this case's axis for BOTH halves of the trip. The preset's stored vector
 * and the requirement's query vector have to sit on the same axis to give a
 * cosine of 1.0 — set it before indexing, not just before retrieval.
 */
function useAxis(axis: number) {
  vi.mocked(mockEmbedding.embed).mockResolvedValue({ vectors: [makeVec(axis)], model: 'stub/model', usage: null });
}

/** Retrieve the way the pipeline does: embed the requirement, search, match. */
async function retrieveAnchor() {
  const out = await runArchivist([makeRequirement()], {
    db,
    embeddingProvider: mockEmbedding,
    recorder: createUsageRecorder({ db, estimateId: null }),
    topK: 5,
  });
  return out.matches[0]!;
}

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `roundtrip-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
});

afterAll(async () => {
  const ids = [...mintedPresetIds, ANCHOR_PRESET];
  await db.presetRetrieval.deleteMany({ where: { presetVersion: { presetId: { in: ids } } } });
  await db.presetComposition.deleteMany({ where: { presetVersion: { presetId: { in: ids } } } });
  await db.$executeRaw`DELETE FROM "PresetAnchor" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = ANY(${ids}))`;
  await db.presetVersion.deleteMany({ where: { presetId: { in: ids } } });
  await db.preset.deleteMany({ where: { id: { in: ids } } });
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  vi.clearAllMocks();
  useAxis(AXIS_MINTED);

  // Clear presets this file has written, so a preset promoted by an earlier case
  // can't sit in the index competing with the one under test.
  const ids = [...mintedPresetIds, ANCHOR_PRESET];
  await db.presetRetrieval.deleteMany({ where: { presetVersion: { presetId: { in: ids } } } });
  await db.presetComposition.deleteMany({ where: { presetVersion: { presetId: { in: ids } } } });
  await db.$executeRaw`DELETE FROM "PresetAnchor" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = ANY(${ids}))`;
  await db.presetVersion.deleteMany({ where: { presetId: { in: ids } } });
  await db.preset.deleteMany({ where: { id: { in: ids } } });
  mintedPresetIds.clear();

  // Fresh estimate per case: promotion is idempotent on
  // (sourceEstimateId, sourceMenuItemId), so a shared estimate would couple them.
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  const est = await db.estimate.create({
    data: {
      title: 'Round-trip guard',
      sowText: 'B2B checkout with volume pricing tiers',
      status: 'REVIEW',
      configVersion: 1,
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
  });
  estimateId = est.id;
});

describe('WBS ⇄ preset library round trip', () => {
  it('hands back exactly the DEV hours that were estimated, all the way to the prompt', async () => {
    useAxis(AXIS_MINTED);
    await seedCard();

    // ── Out: WBS rows → promote → preset library ────────────────────────────
    const promoted = await promoteEstimate(db, estimateId);
    expect(promoted.created).toHaveLength(1);
    const presetId = promoted.created[0]!;
    mintedPresetIds.add(presetId);

    // A preset with no vector never matches and never errors, so indexing is
    // part of promoting — same routine the Inngest promote function calls.
    const backfill = await backfillPresetEmbeddings(db, mockEmbedding, { presetIds: [presetId] });
    expect(backfill).toMatchObject({ embedded: 1, failed: [] });

    // ── Back: retrieve as an anchor ─────────────────────────────────────────
    const match = await retrieveAnchor();

    // Assert the identity too: if a concurrent test file collided on this axis,
    // this fails loudly instead of silently asserting against the wrong row.
    expect(match.presetId).toBe(presetId);
    expect(match.coverage).toBe('full');

    // The whole point. Not the all-roles total, and not 1.4× anything.
    expect(match.devHours).toBe(EXPECTED_DEV);
    expect(match.devHours).not.toBe(ALL_ROLES_TOTAL);
    expect(match.devHours).not.toBe(Math.round(EXPECTED_DEV * 1.4));

    // Side flags ride the same path and are just as droppable.
    expect(match.touchesBackend).toBe(true);
    expect(match.touchesFrontend).toBe(true);

    // ── The last point at which the anchor is still a number ────────────────
    const input: SpecialistInput = {
      requirement: makeRequirement(),
      menuCardId: 'MC-B2B-CHECKOUT',
      archivistMatch: match,
      riskFindings: [],
      complexityScore: 3,
    };
    const rendered = describeCoverage(input);
    expect(rendered).toContain(`DEV=${EXPECTED_DEV}h`);
    expect(rendered).toContain('historically backend + frontend');
  });

  it('carries a recalibrated preset all the way back to the reader', async () => {
    useAxis(AXIS_VERSIONED);

    // An established anchor with a different figure. Promotion onto it is the
    // path where a scaling bug compounds: the library becomes the next
    // estimate's starting point, so an inflated write is read back and inflated
    // again.
    await db.preset.create({ data: { id: ANCHOR_PRESET } });
    await db.presetVersion.create({
      data: {
        presetId: ANCHOR_PRESET,
        version: 1,
        active: true,
        anchor: {
          create: {
            category: 'B2B',
            reqType: 'FEATURE',
            devHours: 58,
            touchesBackend: true,
            touchesFrontend: false,
            platforms: ['shopify'],
            projectSizeFit: ['Mid-market'],
            integrationCount: 2,
            dataVolume: 'HIGH',
            phase: 'CORE',
            aiAssist: 'MEDIUM',
            risk: 'HIGH',
            spikeNeeded: true,
            taxonomyKey: 'b2b.checkout',
          },
        },
        retrieval: {
          create: {
            name: 'Established B2B checkout',
            description: 'Seeded by the round-trip guard.',
            keywords: ['checkout', 'b2b'],
            userStoryTags: [],
            notes: '',
          },
        },
        composition: { create: { requires: [], blocks: [], canParallel: true } },
      },
    });

    await seedCard({
      sourcePresetId: ANCHOR_PRESET,
      matchScore: PROMOTION_MATCH_THRESHOLD + 0.05,
    });

    const promoted = await promoteEstimate(db, estimateId);
    expect(promoted.versioned).toEqual([ANCHOR_PRESET]);
    expect(promoted.created).toEqual([]);

    await backfillPresetEmbeddings(db, mockEmbedding, { presetIds: [ANCHOR_PRESET] });
    const match = await retrieveAnchor();

    // v1's 58h is out of the running by construction — promotion deactivated it
    // and it was never embedded. What this proves is the other half: the
    // recalibrated figure travels the whole way to the reader rather than
    // stopping at the write.
    expect(match.presetId).toBe(ANCHOR_PRESET);
    expect(match.presetVersion).toBe(2);
    expect(match.devHours).toBe(EXPECTED_DEV);

    const v1 = await db.presetVersion.findFirst({
      where: { presetId: ANCHOR_PRESET, version: 1 },
      select: { active: true, anchor: { select: { devHours: true } } },
    });
    expect(v1).toMatchObject({ active: false, anchor: { devHours: 58 } });
  });
});
