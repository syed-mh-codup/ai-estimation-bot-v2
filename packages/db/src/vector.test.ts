import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from './generated/client/index.js';
import { findNearestPresets, vectorToSql } from './vector.js';

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
  // Insert a PresetVersion with a known embedding using raw SQL (Unsupported type)
  await db.$executeRaw`
    INSERT INTO "PresetVersion" (
      id, "presetId", version, active,
      category, name, description,
      "beHours", "feHours",
      platforms, "reqType", keywords,
      "userStoryTags", "projectSizeFit",
      "integrationCount", "dataVolume", phase,
      requires, blocks, "canParallel",
      "aiAssist", risk, "spikeNeeded", notes,
      embedding, "changeMotivation", "createdAt"
    ) VALUES (
      gen_random_uuid(), ${PRESET_ID}, 1, true,
      'Test', 'Vector Test Preset', 'desc',
      10, 5,
      ARRAY[]::text[], 'functional', ARRAY['vector'],
      ARRAY[]::text[], ARRAY[]::text[],
      1, 'NONE'::"DataVolume", 'CORE'::"PresetPhase",
      ARRAY[]::text[], ARRAY[]::text[], false,
      'LOW'::"Level", 'LOW'::"Level", false, 'test',
      ${vectorToSql(makeVec(1))}::vector(1536), 'OTHER'::"ChangeMotivation", now()
    )
  `;
});

afterAll(async () => {
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

  it('vectorToSql formats array correctly', () => {
    expect(vectorToSql([1, 2, 3])).toBe('[1,2,3]');
  });
});
