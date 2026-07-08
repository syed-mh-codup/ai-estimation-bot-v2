import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import { StubSheetsProvider } from '@repo/providers';
import { SAMPLE_SOWS } from '@repo/shared';
import { runEstimate } from './run-estimate';
import { exportToSheets } from './sheets-export';
import { DEFAULT_COMPLEXITY_RULES } from './complexity';

/**
 * Offline (stub-LLM) versions of the eval workstreams. The CREDIT-gated parts —
 * eval against REAL model output / through the live UI — still need credits;
 * these prove the deterministic pipeline behaviour the evals assert.
 *  - WS26-02: fixture SOW → run → Menu Card → export model (non-empty per-role WBS + totals).
 *  - WS27-01: identical inputs → byte-identical totals across N runs (determinism).
 *  - WS27-03: changing config version changes output predictably (regression).
 */
const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const stub: IModelProvider = {
  async chat({ messages }) {
    const c = messages.map((m: { content: string }) => m.content).join('\n');
    if (c.includes('Decompose this SOW'))
      return JSON.stringify({
        requirements: [
          {
            text: 'Build the core flow',
            category: 'B2B',
            reqType: 'Commerce Logic',
            platforms: ['Shopify'],
            projectSize: 'Mid-market',
            dataVolume: 'Low',
            integrationCount: 1,
            candidateMenuCardId: 'MC-CORE-FLOW',
            taxonomyKey: null,
            sourceRef: 'SOW',
            ambiguities: [],
            blocksEstimation: false,
          },
          {
            text: 'Add an integration',
            category: 'Integration / Celigo',
            reqType: 'Integration',
            platforms: ['Celigo'],
            projectSize: 'Mid-market',
            dataVolume: 'Low',
            integrationCount: 2,
            candidateMenuCardId: 'MC-INTEGRATION',
            taxonomyKey: null,
            sourceRef: 'SOW',
            ambiguities: [],
            blocksEstimation: false,
          },
        ],
      });
    if (c.includes('Investigate the risky and unknown parts')) return JSON.stringify({ risks: [], questions: [] });
    if (c.includes('Estimate') && c.includes('effort for this requirement'))
      return JSON.stringify({
        lineItems: [{ description: 'stub item', hours: 3, complexity: 'base', aiAssistApplied: false, dependsOn: [] }],
        assumptions: [],
      });
    if (c.includes('Synthesise the specialists'))
      return JSON.stringify({
        narrative: Array.from({ length: 8 }, (_, i) => `Sentence ${i + 1}.`),
        cards: [
          { menuCardId: 'MC-CORE-FLOW', phase: 'Core', thinSlice: true },
          { menuCardId: 'MC-INTEGRATION', phase: 'Core', thinSlice: false },
        ],
      });
    return '{}';
  },
  async embed() {
    return [[0, 0, 0]];
  },
};

let ownerId = '';
let configVersion = 0;
const estimateIds: string[] = [];

async function seedConfig(taxPct: number): Promise<number> {
  const last = await db.estimationConfig.findFirst({ orderBy: { version: 'desc' }, select: { version: true } });
  const version = (last?.version ?? 0) + 1;
  await db.estimationConfig.updateMany({ where: { active: true }, data: { active: false } });
  await db.estimationConfig.create({
    data: {
      version,
      active: true,
      complexityRules: DEFAULT_COMPLEXITY_RULES,
      pmCommunicationTaxPct: taxPct,
      baCommunicationTaxPct: taxPct,
      qaRegressionBufferPct: taxPct,
      infraBaseline: {},
      changeReason: 'eval',
    },
  });
  return version;
}

async function makeEstimate(sowText: string): Promise<string> {
  const est = await db.estimate.create({
    data: {
      title: 'eval',
      sowText,
      sowHash: '',
      status: 'DRAFT',
      configVersion,
      taxonomyVersionsPinned: {},
      promptVersionsPinned: {},
      modelConfig: {},
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId,
    },
  });
  estimateIds.push(est.id);
  return est.id;
}

async function totals(estimateId: string): Promise<Record<string, number>> {
  const items = await db.menuItem.findMany({ where: { estimateId }, include: { lineItems: true } });
  const t: Record<string, number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };
  for (const m of items) for (const li of m.lineItems) t[li.role] = (t[li.role] ?? 0) + li.taxedHours;
  return t;
}

beforeAll(async () => {
  await db.$connect();
  const u = await db.user.create({ data: { email: `eval-${Date.now()}@example.com`, hash: 'h', role: 'ESTIMATOR' } });
  ownerId = u.id;
  configVersion = await seedConfig(20);
  for (const kind of ['LIBRARIAN', 'DETECTIVE', 'ARCHIVIST', 'ARCHITECT', 'SPECIALIST_DEV', 'SPECIALIST_QA', 'SPECIALIST_PM', 'SPECIALIST_BA'] as const) {
    await db.prompt.upsert({ where: { kind }, update: {}, create: { kind } });
    await db.promptVersion.updateMany({ where: { kind, active: true }, data: { active: false } });
    await db.promptVersion.upsert({
      where: { kind_version: { kind, version: 1 } },
      update: { active: true, body: `Eval ${kind}`, modelString: 'stub/model' },
      create: { kind, version: 1, active: true, body: `Eval ${kind}`, modelString: 'stub/model' },
    });
  }
});

afterAll(async () => {
  for (const id of estimateIds) {
    const items = await db.menuItem.findMany({ where: { estimateId: id }, select: { id: true } });
    await db.roleLineItem.deleteMany({ where: { menuItemId: { in: items.map((i) => i.id) } } });
    await db.menuItem.deleteMany({ where: { estimateId: id } });
    await db.estimate.delete({ where: { id } });
  }
  await db.user.delete({ where: { id: ownerId } });
  await db.$disconnect();
});

describe('WS26-02: full pipeline → Menu Card → export (stub LLM)', () => {
  it('produces a non-empty per-role WBS and an exportable model', async () => {
    const id = await makeEstimate(SAMPLE_SOWS[1]!.sowText);
    await runEstimate(id, { db, modelProvider: stub });
    const items = await db.menuItem.findMany({ where: { estimateId: id }, include: { lineItems: true } });
    expect(items.length).toBeGreaterThan(0);
    const dto = items.map((m) => ({
      id: m.id,
      taxonomyKey: m.taxonomyKey,
      title: m.title,
      enabled: m.enabled,
      lineItems: m.lineItems.map((li) => ({ role: li.role, baseHours: li.baseHours, taxedHours: li.taxedHours, edited: li.edited })),
    }));
    const result = await exportToSheets(id, 'Eval', dto, new StubSheetsProvider());
    expect(result.tabCount).toBeGreaterThan(0);
    expect(result.url).toContain('docs.google.com');
  });
});

describe('WS27-01: determinism', () => {
  it('identical inputs yield identical totals across 3 runs', async () => {
    const runOnce = async () => {
      const id = await makeEstimate(SAMPLE_SOWS[0]!.sowText);
      await runEstimate(id, { db, modelProvider: stub });
      return totals(id);
    };
    const [a, b, c] = await Promise.all([runOnce(), runOnce(), runOnce()]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});

describe('WS27-03: regression — config change moves output predictably', () => {
  it('raising the tax %s increases taxed hours', async () => {
    const id1 = await makeEstimate(SAMPLE_SOWS[0]!.sowText);
    await runEstimate(id1, { db, modelProvider: stub });
    const before = await totals(id1);

    configVersion = await seedConfig(50); // higher tax than the initial 20
    const id2 = await makeEstimate(SAMPLE_SOWS[0]!.sowText);
    await runEstimate(id2, { db, modelProvider: stub });
    const after = await totals(id2);

    // QA carries the regression buffer; higher % → strictly more taxed QA hours.
    expect(after.QA).toBeGreaterThan(before.QA!);
  });
});
