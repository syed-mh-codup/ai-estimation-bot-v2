import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from './generated/client/index.js';

const db = new PrismaClient({
  datasources: {
    db: { url: process.env['DATABASE_URL'] ?? 'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public' },
  },
});

beforeAll(async () => {
  await db.$connect();
});

afterAll(async () => {
  await db.$executeRaw`DELETE FROM "PresetRetrieval" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = 'TEST_P01')`;
  await db.$executeRaw`DELETE FROM "PresetComposition" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = 'TEST_P01')`;
  await db.$executeRaw`DELETE FROM "PresetAnchor" WHERE "presetVersionId" IN (SELECT id FROM "PresetVersion" WHERE "presetId" = 'TEST_P01')`;
  await db.$executeRaw`DELETE FROM "PresetVersion" WHERE "presetId" = 'TEST_P01'`;
  await db.$executeRaw`DELETE FROM "Preset" WHERE "id" = 'TEST_P01'`;
  await db.$disconnect();
});

describe('WS1-01: Prisma client importable', () => {
  it('connects to the database', async () => {
    const result = await db.$queryRaw<[{ one: number }]>`SELECT 1 AS one`;
    expect(result[0]?.one).toBe(1);
  });
});

describe('WS1-02: Preset + PresetVersion CRUD', () => {
  it('creates a Preset and PresetVersion and reads it back', async () => {
    await db.preset.create({ data: { id: 'TEST_P01' } });

    const pv = await db.presetVersion.create({
      data: {
        presetId: 'TEST_P01',
        version: 1,
        active: true,
        anchor: {
          create: {
            category: 'Shopify/Ecommerce',
            reqType: 'functional',
            devHours: 60,
            touchesBackend: true,
            touchesFrontend: true,
            platforms: ['Shopify'],
            projectSizeFit: ['SMB'],
            integrationCount: 1,
            dataVolume: 'NONE',
            phase: 'CORE',
            aiAssist: 'LOW',
            risk: 'MEDIUM',
            spikeNeeded: false,
          },
        },
        retrieval: {
          create: {
            name: 'Test Preset',
            description: 'A test preset',
            keywords: ['checkout'],
            userStoryTags: [],
            notes: 'test',
          },
        },
        composition: {
          create: { requires: [], blocks: [], canParallel: true },
        },
      },
    });

    expect(pv.presetId).toBe('TEST_P01');
    expect(pv.version).toBe(1);
    expect(pv.active).toBe(true);

    const read = await db.presetVersion.findFirst({
      where: { presetId: 'TEST_P01' },
      include: { anchor: true, retrieval: true },
    });
    expect(read?.retrieval?.name).toBe('Test Preset');
    expect(read?.anchor?.devHours).toBe(60);
  });
});
