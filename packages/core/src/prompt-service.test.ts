import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import { loadActivePrompt, activateNewPromptVersion, listPromptVersions, PromptNotFoundError } from './prompt-service';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const TEST_KIND = 'DETECTIVE' as const;

beforeAll(async () => {
  await db.$connect();
  await db.prompt.upsert({ where: { kind: TEST_KIND }, update: {}, create: { kind: TEST_KIND } });
  // Clean up any existing test versions
  await db.promptVersion.deleteMany({ where: { kind: TEST_KIND } });
});

afterAll(async () => {
  await db.promptVersion.deleteMany({ where: { kind: TEST_KIND } });
  await db.$disconnect();
});

describe('WS7-01: loadActivePrompt', () => {
  it('throws PromptNotFoundError when no active prompt exists', async () => {
    await expect(loadActivePrompt(db, TEST_KIND)).rejects.toBeInstanceOf(PromptNotFoundError);
  });

  it('returns active prompt after creation', async () => {
    await activateNewPromptVersion(db, TEST_KIND, 'For each requirement...', 'openrouter/test/model');
    const prompt = await loadActivePrompt(db, TEST_KIND);
    expect(prompt.body).toContain('For each requirement');
    expect(prompt.modelString).toBe('openrouter/test/model');
    expect(prompt.kind).toBe(TEST_KIND);
  });
});

describe('WS7-02: activateNewPromptVersion — create/activate/reflect', () => {
  it('activating a new version deactivates previous and reflects in loadActivePrompt', async () => {
    const v1 = await loadActivePrompt(db, TEST_KIND);

    const v2Num = await activateNewPromptVersion(
      db, TEST_KIND,
      'Updated prompt body v2',
      'openrouter/anthropic/claude-3-haiku',
      { reason: 'improved quality', motivation: 'UPSKILL', by: 'admin@codup.co' },
    );

    const current = await loadActivePrompt(db, TEST_KIND);
    expect(current.body).toBe('Updated prompt body v2');
    expect(current.version).toBe(v2Num);
    expect(current.version).toBeGreaterThan(v1.version);

    // Only one active version for this kind
    const activeVersions = await db.promptVersion.findMany({
      where: { kind: TEST_KIND, active: true },
    });
    expect(activeVersions).toHaveLength(1);
  });

  it('lists all versions in descending order', async () => {
    const versions = await listPromptVersions(db, TEST_KIND);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i - 1]!.version).toBeGreaterThanOrEqual(versions[i]!.version);
    }
  });
});
