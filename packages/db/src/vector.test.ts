import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from './generated/client/index.js';
import { findNearestPresets } from './vector.js';

/** pgvector literal. Local to the fixture: `findNearestPresets` inlines the
 *  same expression, and a one-line exported helper with no production caller
 *  is exactly what the AEH-228 export gate exists to catch. */
const vectorToSql = (v: number[]): string => `[${v.join(',')}]`;

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const PRESET_ID = 'VEC_TEST_P01';
const EMBEDDING_DIM = 1536;

function makeVec(first: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = first;
  return v;
}

beforeAll(async () => {
  await db.$connect();
  await db.preset.upsert({
    where: { id: PRESET_ID },
    update: {},
    create: { id: PRESET_ID },
  });

  // PresetVersion (versioning shell) + PresetAnchor (anchor) + PresetRetrieval
  // (retrieval surface) using raw SQL because PresetRetrieval.embedding is an
  // Unsupported vector column the typed client cannot write.
  const versionId = 'VEC_TEST_VERSION';
  await db.$executeRaw`
    INSERT INTO "PresetVersion" (
      id, "presetId", version, active,
      "changeMotivation", "createdAt"
    ) VALUES (
      ${versionId}, ${PRESET_ID}, 1, true,
      'OTHER'::"ChangeMotivation", now()
    )
  `;
  await db.$executeRaw`
    INSERT INTO "PresetAnchor" (
      id, "presetVersionId", "devHours",
      "touchesFrontend", "touchesBackend", "beHours", "feHours",
      risk, "aiAssist", "dataVolume", "integrationCount",
      "projectSizeFit", phase, "spikeNeeded",
      category, "reqType", platforms, "taxonomyKey"
    ) VALUES (
      gen_random_uuid(), ${versionId}, 15,
      false, false, NULL, NULL,
      'LOW'::"Level", 'LOW'::"Level", 'NONE'::"DataVolume", 1,
      ARRAY[]::text[], 'CORE'::"PresetPhase", false,
      'Test', 'functional', ARRAY[]::text[], NULL
    )
  `;
  await db.$executeRaw`
    INSERT INTO "PresetRetrieval" (
      id, "presetVersionId", name, description, keywords,
      "userStoryTags", notes,
      "embeddingText", embedding, "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid(), ${versionId}, 'Vector Test Preset', 'desc', ARRAY['vector'],
      ARRAY[]::text[], 'test',
      'Vector Test Preset desc vector',
      ${vectorToSql(makeVec(1))}::vector(1536), now(), now()
    )
  `;
});

afterAll(async () => {
  await db.$executeRaw`DELETE FROM "PresetRetrieval" WHERE "presetVersionId" = 'VEC_TEST_VERSION'`;
  await db.$executeRaw`DELETE FROM "PresetAnchor" WHERE "presetVersionId" = 'VEC_TEST_VERSION'`;
  await db.$executeRaw`DELETE FROM "PresetVersion" WHERE "presetId" = ${PRESET_ID}`;
  await db.$executeRaw`DELETE FROM "Preset" WHERE id = ${PRESET_ID}`;
  await db.$disconnect();
});

describe('WS1-08: pgvector ANN nearest-neighbour query', () => {
  it('inserts a vector and retrieves ordered nearest neighbours', async () => {
    const query = makeVec(1);
    const results = await findNearestPresets(db, query, 5);

    expect(results.length).toBeGreaterThan(0);
    const match = results[0]!;
    expect(match.presetId).toBe(PRESET_ID);
    expect(typeof match.distance).toBe('number');
    expect(match.distance).toBeCloseTo(0, 4);
  });
});
