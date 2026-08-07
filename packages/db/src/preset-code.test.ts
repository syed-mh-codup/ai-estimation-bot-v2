import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from './generated/client/index.js';
import { allocatePresetCode, syncPresetCodeSequence } from './preset-code';

/**
 * Codes come from a Postgres sequence rather than `max(code) + 1`, because
 * allocation is genuinely concurrent — two estimates finalising at the same
 * moment, or Inngest retrying one promotion while another is mid-flight. With
 * max+1 both readers see the same number and one loses. These tests pin that.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const created: string[] = [];
let sequenceBefore = '';

beforeAll(async () => {
  await db.$connect();
  // A sequence is shared, mutable state that does NOT roll back with a
  // transaction or a row delete. These tests consume codes (and one deliberately
  // jumps to P99999), so without restoring it afterwards every run would leave
  // the environment allocating from a higher number than it should — a test
  // permanently changing the data it ran against.
  sequenceBefore = await peekNext();
});

afterAll(async () => {
  await db.preset.deleteMany({ where: { id: { in: created } } });
  await db.$executeRawUnsafe(`SELECT setval('preset_code_seq', ${sequenceBefore}, false)`);
  await db.$disconnect();
});

describe('allocatePresetCode', () => {
  it('hands out "P" + a bare number, with no zero padding', async () => {
    const code = await allocatePresetCode(db);
    expect(code).toMatch(/^P[1-9]\d*$/);
    expect(code).not.toMatch(/^P0/); // free-flowing, not P046
  });

  it('never repeats a code across concurrent callers', async () => {
    // The case max()+1 gets wrong: all of these read and write at once.
    const codes = await Promise.all(Array.from({ length: 25 }, () => allocatePresetCode(db)));
    expect(new Set(codes).size).toBe(25);
  });

  it('produces codes that survive a unique constraint under parallel inserts', async () => {
    const presets = await Promise.all(
      Array.from({ length: 10 }, async () => {
        const p = await db.preset.create({
          data: { code: await allocatePresetCode(db), origin: 'MANUAL' },
          select: { id: true, code: true },
        });
        created.push(p.id);
        return p;
      }),
    );
    expect(new Set(presets.map((p) => p.code)).size).toBe(10);
    // Ids are opaque cuids, not the code — the code is a display handle.
    for (const p of presets) expect(p.id).not.toBe(p.code);
  });
});

describe('syncPresetCodeSequence', () => {
  it('is idempotent — repeated calls do not advance the sequence', async () => {
    await syncPresetCodeSequence(db);
    const a = await peekNext();
    await syncPresetCodeSequence(db);
    await syncPresetCodeSequence(db);
    expect(await peekNext()).toBe(a);
  });

  it('moves past a code that arrived some other way (e.g. an xlsx import)', async () => {
    // Sits above anything the other tests allocate, but nowhere near a number a
    // real library would reach — the sequence is restored in afterAll either way.
    const IMPORTED = 4242;
    const p = await db.preset.create({
      data: { code: `P${IMPORTED}`, origin: 'SEEDED' },
      select: { id: true },
    });
    created.push(p.id);

    await syncPresetCodeSequence(db);

    // The next allocated code must clear the imported one, or the unique
    // constraint would reject it later.
    const next = await allocatePresetCode(db);
    expect(Number(next.slice(1))).toBeGreaterThan(IMPORTED);
  });
});

async function peekNext(): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ last_value: bigint }>>(
    `SELECT last_value FROM preset_code_seq`,
  );
  return String(rows[0]!.last_value);
}
