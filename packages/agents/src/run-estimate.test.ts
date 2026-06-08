import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import { runEstimate } from './run-estimate';
import { DEFAULT_COMPLEXITY_RULES } from './complexity';

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

// A stub LLM: returns valid JSON per agent based on the prompt content. Proves
// the full pipeline WIRING offline — not the quality of real prompts/responses.
const stubModelProvider: IModelProvider = {
  async chat({ messages }) {
    const content = messages.map((m) => m.content).join('\n');
    if (content.includes('Decompose') || content.includes('"requirements"')) {
      return JSON.stringify({
        requirements: [
          { text: 'Build a B2B checkout flow', taxonomyKey: null, confidence: 0.9 },
          { text: 'Implement SSO login', taxonomyKey: null, confidence: 0.8 },
        ],
      });
    }
    if (content.includes('Estimate hours for role') || content.includes('"baseHours"')) {
      return JSON.stringify({ baseHours: 10, rationale: 'stub', assumptions: ['Stub assumption'] });
    }
    if (content.includes('narrative')) {
      return JSON.stringify({ narrative: ['Implement the requested scope.'] });
    }
    return '{}';
  },
  async embed() {
    return [[0, 0, 0]];
  },
};

let userId = '';
let estimateId = '';

beforeAll(async () => {
  await db.$connect();

  // Active config with rules in the shape the complexity engine expects.
  await db.estimationConfig.updateMany({ where: { active: true }, data: { active: false } });
  const cfg = await db.estimationConfig.create({
    data: {
      version: 9000 + Math.floor(Math.random() * 1000),
      active: true,
      complexityRules: DEFAULT_COMPLEXITY_RULES,
      pmCommunicationTaxPct: 15,
      baCommunicationTaxPct: 10,
      qaRegressionBufferPct: 20,
      infraBaseline: {},
      changeReason: 'run-estimate test',
    },
  });

  // Active prompt per agent kind the pipeline loads.
  for (const kind of [
    'LIBRARIAN',
    'ARCHITECT',
    'SPECIALIST_DEV',
    'SPECIALIST_QA',
    'SPECIALIST_PM',
    'SPECIALIST_BA',
  ] as const) {
    await db.prompt.upsert({ where: { kind }, update: {}, create: { kind } });
    await db.promptVersion.updateMany({ where: { kind, active: true }, data: { active: false } });
    await db.promptVersion.upsert({
      where: { kind_version: { kind, version: 1 } },
      update: { active: true, body: `Test ${kind} prompt`, modelString: 'stub/model' },
      create: { kind, version: 1, active: true, body: `Test ${kind} prompt`, modelString: 'stub/model' },
    });
  }

  const user = await db.user.create({
    data: { email: `runest-${Date.now()}@example.com`, hash: 'hash', role: 'ESTIMATOR' },
  });
  userId = user.id;
  const est = await db.estimate.create({
    data: {
      title: 'Run Estimate Test',
      sowText: 'Build a B2B checkout flow with SSO login and an admin dashboard.',
      sowHash: '',
      status: 'DRAFT',
      taxonomyVersionsPinned: {},
      configVersion: cfg.version,
      promptVersionsPinned: {},
      modelConfig: {},
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
  });
  estimateId = est.id;
});

afterAll(async () => {
  const items = await db.menuItem.findMany({ where: { estimateId }, select: { id: true } });
  await db.roleLineItem.deleteMany({ where: { menuItemId: { in: items.map((i) => i.id) } } });
  await db.menuItem.deleteMany({ where: { estimateId } });
  await db.estimate.delete({ where: { id: estimateId } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('WS22-02: runEstimate full pipeline (stub LLM)', () => {
  it('produces and persists a costed Menu Card with taxed role hours', async () => {
    const result = await runEstimate(estimateId, { db, modelProvider: stubModelProvider });

    expect(result.status).toBe('REVIEW');
    expect(result.menuItemCount).toBe(2); // one per requirement
    expect(result.complexityScore).toBeGreaterThanOrEqual(1);
    expect(result.complexityScore).toBeLessThanOrEqual(5);

    // Estimate moved to REVIEW with narrative + complexity persisted.
    const est = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    expect(est.status).toBe('REVIEW');
    expect(est.narrative.length).toBeGreaterThan(0);
    expect(est.complexityScore).not.toBeNull();

    // Costed Menu Card persisted: 2 items, each with 4 role line items.
    const items = await db.menuItem.findMany({
      where: { estimateId },
      include: { lineItems: true },
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      const roles = item.lineItems.map((li) => li.role).sort();
      expect(roles).toEqual(['BA', 'DEV', 'PM', 'QA']);
      // QA carries the 20% regression buffer → taxed > base.
      const qa = item.lineItems.find((li) => li.role === 'QA')!;
      expect(qa.taxedHours).toBeGreaterThan(qa.baseHours);
      // DEV has no communication tax → taxed == base.
      const dev = item.lineItems.find((li) => li.role === 'DEV')!;
      expect(dev.taxedHours).toBe(dev.baseHours);
    }
  });
});
