import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import {
  createPresetVersion,
  createTaxonomyVersion,
  createPromptVersion,
  pinVersions,
  diffVersions,
} from './versioning';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const PRESET_ID = 'VER_TEST_P01';
const NODE_KEY = 'ver.test.node';

beforeAll(() => db.$connect());

afterAll(async () => {
  await db.$executeRaw`DELETE FROM "RoleLineItem" WHERE "menuItemId" IN (SELECT id FROM "MenuItem" WHERE "estimateId" IN (SELECT id FROM "Estimate" WHERE "sowHash" = 'ver-test-hash'))`;
  await db.$executeRaw`DELETE FROM "MenuItem" WHERE "estimateId" IN (SELECT id FROM "Estimate" WHERE "sowHash" = 'ver-test-hash')`;
  await db.$executeRaw`DELETE FROM "Estimate" WHERE "sowHash" = 'ver-test-hash'`;
  await db.$executeRaw`DELETE FROM "User" WHERE "email" = 'ver-test@example.com'`;
  await db.$executeRaw`DELETE FROM "PresetVersion" WHERE "presetId" = ${PRESET_ID}`;
  await db.$executeRaw`DELETE FROM "Preset" WHERE id = ${PRESET_ID}`;
  await db.$executeRaw`DELETE FROM "TaxonomyNodeVersion" WHERE "nodeKey" = ${NODE_KEY}`;
  await db.$executeRaw`DELETE FROM "TaxonomyNode" WHERE key = ${NODE_KEY}`;
  await db.$disconnect();
});

const PRESET_PAYLOAD = {
  category: 'Test',
  name: 'Version Test Preset',
  description: 'desc',
  devHours: 15,
  touchesBackend: true,
  touchesFrontend: true,
  platforms: [],
  reqType: 'functional',
  keywords: [],
  userStoryTags: [],
  projectSizeFit: [],
  integrationCount: 0,
  dataVolume: 'NONE' as const,
  phase: 'CORE' as const,
  requires: [],
  blocks: [],
  canParallel: false,
  aiAssist: 'LOW' as const,
  risk: 'LOW' as const,
  spikeNeeded: false,
  notes: 'test',
};

describe('WS6-01: versionedCreate — increment, single active, immutable priors', () => {
  it('creates first preset version (v1)', async () => {
    await db.preset.upsert({ where: { id: PRESET_ID }, update: {}, create: { id: PRESET_ID } });
    const v = await createPresetVersion(db, PRESET_ID, PRESET_PAYLOAD, { reason: 'initial' });
    expect(v).toBe(1);

    const active = await db.presetVersion.findMany({ where: { presetId: PRESET_ID, active: true } });
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(1);
  });

  it('creates second version (v2) and deactivates v1', async () => {
    const v = await createPresetVersion(db, PRESET_ID, { ...PRESET_PAYLOAD, name: 'Version 2' }, {
      reason: 'update', motivation: 'CORRECTION',
    });
    expect(v).toBe(2);

    const allVersions = await db.presetVersion.findMany({ where: { presetId: PRESET_ID }, orderBy: { version: 'asc' } });
    expect(allVersions).toHaveLength(2);

    const v1 = allVersions.find((x) => x.version === 1);
    const v2 = allVersions.find((x) => x.version === 2);
    expect(v1?.active).toBe(false);
    expect(v2?.active).toBe(true);
    expect(v1?.name).toBe('Version Test Preset');
  });

  it('creates taxonomy version with single-active invariant', async () => {
    await db.taxonomyNode.upsert({ where: { key: NODE_KEY }, update: {}, create: { key: NODE_KEY, label: 'Test' } });

    const v1 = await createTaxonomyVersion(db, NODE_KEY, { label: 'Test v1', keywords: [] });
    const v2 = await createTaxonomyVersion(db, NODE_KEY, { label: 'Test v2', keywords: ['checkout'] });

    const active = await db.taxonomyNodeVersion.findMany({ where: { nodeKey: NODE_KEY, active: true } });
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(v2);
    expect(v2).toBeGreaterThan(v1);
  });

  it('creates prompt version with single-active invariant', async () => {
    await db.prompt.upsert({ where: { kind: 'LIBRARIAN' }, update: {}, create: { kind: 'LIBRARIAN' } });

    await createPromptVersion(db, {
      kind: 'LIBRARIAN', body: 'v1 prompt', modelString: 'test/model',
    });
    const v2 = await createPromptVersion(db, {
      kind: 'LIBRARIAN', body: 'v2 prompt updated', modelString: 'test/model',
    });

    const active = await db.promptVersion.findMany({ where: { kind: 'LIBRARIAN', active: true } });
    expect(active).toHaveLength(1);
    expect(active[0]?.version).toBe(v2);
  });
});

describe('WS6-02: resolveActiveVersions + pinVersions', () => {
  it('pins active versions to an estimate and later changes do not affect the pin', async () => {
    // Create a user and estimate
    const user = await db.user.create({
      data: { email: 'ver-test@example.com', hash: 'hash', role: 'ESTIMATOR' },
    });
    const est = await db.estimate.create({
      data: {
        title: 'Pin Test', sowText: 'test', sowHash: 'ver-test-hash', status: 'DRAFT',
        taxonomyVersionsPinned: {}, configVersion: 0, promptVersionsPinned: {},
        modelConfig: {}, narrative: [], assumptions: [], agentState: {}, ownerId: user.id,
      },
    });

    const pinned = await pinVersions(db, est.id);
    expect(typeof pinned.configVersion).toBe('number');
    expect(typeof pinned.taxonomyVersion).toBe('number');

    const saved = await db.estimate.findUnique({ where: { id: est.id } });
    expect(saved?.configVersion).toBe(pinned.configVersion);
  });
});

describe('WS6-03: diffVersions', () => {
  it('returns changed fields between two versions', () => {
    const before = { name: 'Old Name', beHours: 40, category: 'A' };
    const after = { name: 'New Name', beHours: 60, category: 'A' };
    const diffs = diffVersions(before, after);
    expect(diffs).toHaveLength(2);
    const nameChange = diffs.find((d) => d.field === 'name');
    expect(nameChange?.before).toBe('Old Name');
    expect(nameChange?.after).toBe('New Name');
  });

  it('returns empty array when nothing changed', () => {
    const v = { name: 'Same', beHours: 40 };
    expect(diffVersions(v, v)).toHaveLength(0);
  });

  it('detects new fields added in after', () => {
    const before = { name: 'Test' };
    const after = { name: 'Test', newField: 'value' };
    const diffs = diffVersions(before, after);
    expect(diffs.some((d) => d.field === 'newField')).toBe(true);
  });
});
