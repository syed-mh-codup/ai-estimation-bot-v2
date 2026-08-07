import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from './generated/client/index.js';
import { getChangeLog } from './changelog.js';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const CL_PRESET_ID = 'CL_TEST_P01';
const CL_NODE_KEY = 'cl.test.node';

beforeAll(async () => {
  await db.$connect();

  // Preset version
  await db.preset.upsert({ where: { id: CL_PRESET_ID }, update: {}, create: { id: CL_PRESET_ID } });
  await db.presetVersion.create({
    data: {
      presetId: CL_PRESET_ID, version: 1, active: false,
      category: 'Test', name: 'CL Test', description: 'cl test',
      devHours: 2, touchesBackend: true, touchesFrontend: true, platforms: [], reqType: 'test', keywords: [],
      userStoryTags: [], projectSizeFit: [], integrationCount: 0,
      dataVolume: 'NONE', phase: 'CORE', requires: [], blocks: [],
      canParallel: false, aiAssist: 'LOW', risk: 'LOW', spikeNeeded: false,
      notes: 'cl test', changeReason: 'cl test', changeMotivation: 'OTHER',
    },
  });

  // Taxonomy version
  await db.taxonomyNode.upsert({ where: { key: CL_NODE_KEY }, update: {}, create: { key: CL_NODE_KEY, label: 'CL Test' } });
  await db.taxonomyNodeVersion.create({
    data: { nodeKey: CL_NODE_KEY, version: 1, label: 'CL', keywords: [], active: false, changeMotivation: 'OTHER' },
  });

  // Prompt version
  await db.prompt.upsert({ where: { kind: 'ARCHITECT' }, update: {}, create: { kind: 'ARCHITECT' } });
  await db.promptVersion.create({
    data: { kind: 'ARCHITECT', version: 9998, body: 'cl test', modelString: 'test/model', active: false, changeMotivation: 'OTHER' },
  });

  // Config version
  await db.estimationConfig.create({
    data: {
      version: 9998, active: false,
      complexityRules: {}, pmCommunicationTaxPct: 0, baCommunicationTaxPct: 0, qaRegressionBufferPct: 0,
      infraBaseline: {}, changeMotivation: 'OTHER',
    },
  });
});

afterAll(async () => {
  await db.$executeRaw`DELETE FROM "PresetVersion" WHERE "presetId" = ${CL_PRESET_ID}`;
  await db.$executeRaw`DELETE FROM "Preset" WHERE id = ${CL_PRESET_ID}`;
  await db.$executeRaw`DELETE FROM "TaxonomyNodeVersion" WHERE "nodeKey" = ${CL_NODE_KEY}`;
  await db.$executeRaw`DELETE FROM "TaxonomyNode" WHERE key = ${CL_NODE_KEY}`;
  await db.$executeRaw`DELETE FROM "PromptVersion" WHERE kind = 'ARCHITECT'::"AgentKind" AND version = 9998`;
  await db.$executeRaw`DELETE FROM "EstimationConfig" WHERE version = 9998`;
  await db.$disconnect();
});

describe('WS1-09: ChangeLog read model', () => {
  it('returns chronological (descending) feed with entity/version/motivation', async () => {
    const log = await getChangeLog(db, 100);
    expect(log.length).toBeGreaterThan(0);

    const entry = log[0]!;
    expect(entry).toHaveProperty('entity');
    expect(entry).toHaveProperty('entityKey');
    expect(entry).toHaveProperty('version');
    expect(entry).toHaveProperty('changeMotivation');
    expect(entry).toHaveProperty('createdAt');

    for (let i = 1; i < log.length; i++) {
      expect(new Date(log[i - 1]!.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(log[i]!.createdAt).getTime(),
      );
    }
  });

  it('includes all four entity types from seeded test rows', async () => {
    const log = await getChangeLog(db, 500);
    const entities = new Set(log.map((e) => e.entity));
    expect(entities.has('preset')).toBe(true);
    expect(entities.has('taxonomy')).toBe(true);
    expect(entities.has('prompt')).toBe(true);
    expect(entities.has('config')).toBe(true);
  });
});
