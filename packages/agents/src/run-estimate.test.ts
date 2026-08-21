import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import { runEstimate, type StepRunner } from './run-estimate';
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
    if (content.includes('Decompose this SOW')) {
      return JSON.stringify({
        requirements: [
          {
            text: 'Build a B2B checkout flow',
            category: 'B2B',
            reqType: 'Checkout',
            platforms: ['Shopify'],
            projectSize: 'Mid-market',
            dataVolume: 'Low',
            integrationCount: 1,
            candidateMenuCardId: 'MC-B2B-CHECKOUT',
            taxonomyKey: null,
            sourceRef: 'SOW',
            ambiguities: [],
            blocksEstimation: false,
          },
          {
            text: 'Implement SSO login',
            category: 'B2B',
            reqType: 'Authentication',
            platforms: ['Shopify'],
            projectSize: 'Mid-market',
            dataVolume: 'None',
            integrationCount: 1,
            candidateMenuCardId: 'MC-B2B-AUTH',
            taxonomyKey: null,
            sourceRef: 'SOW',
            ambiguities: [],
            blocksEstimation: false,
          },
        ],
      });
    }
    if (content.includes('Investigate the risky and unknown parts')) {
      return JSON.stringify({ risks: [], questions: [] });
    }
    if (content.includes('Estimate') && content.includes('effort for this requirement')) {
      return JSON.stringify({
        lineItems: [{ description: 'stub line item', hours: 2.5, complexity: 'base', aiAssistApplied: false, dependsOn: [] }],
        assumptions: ['Stub assumption'],
      });
    }
    if (content.includes('Synthesise the specialists')) {
      return JSON.stringify({
        narrative: Array.from({ length: 8 }, (_, i) => `Stub narrative sentence ${i + 1}.`),
        cards: [
          { menuCardId: 'MC-B2B-CHECKOUT', phase: 'Core', thinSlice: true },
          { menuCardId: 'MC-B2B-AUTH', phase: 'Core', thinSlice: false },
        ],
      });
    }
    return '{}';
  },
  async embed() {
    return [[0, 0, 0]];
  },
};

let userId = '';
let estimateId = '';
let configVersion = 0;

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
    'DETECTIVE',
    'ARCHIVIST',
    'ARCHITECT',
    'SPECIALIST_DEV',
    'SPECIALIST_QA',
    'SPECIALIST_PM',
    'SPECIALIST_BA',
  ] as const) {
    await db.prompt.upsert({ where: { kind }, update: {}, create: { kind } });
    // NOTE: deliberately no bulk `updateMany(active:false)` here — this file
    // runs in parallel with other test files against the same local DB and
    // sharing PromptVersion rows per kind; blanket-deactivating would create
    // a window where a concurrent runEstimate() finds zero active rows. Just
    // ensure THIS file's own row exists and is active; harmless if another
    // file's row for the same kind is simultaneously active too.
    await db.promptVersion.upsert({
      where: { kind_version: { kind, version: 1 } },
      update: { active: true, body: `Test ${kind} prompt`, modelString: 'stub/model' },
      create: { kind, version: 1, active: true, body: `Test ${kind} prompt`, modelString: 'stub/model' },
    });
  }

  configVersion = cfg.version;

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

describe('runEstimate refuses a trivially-empty SOW rather than fabricating one', () => {
  it('throws before calling the Librarian when sowText is empty (e.g. ingestion silently failed)', async () => {
    const est = await db.estimate.create({
      data: {
        title: 'Empty SOW Test',
        sowText: '',
        sowHash: '',
        status: 'DRAFT',
        taxonomyVersionsPinned: {},
        configVersion,
        promptVersionsPinned: {},
        modelConfig: {},
        narrative: [],
        assumptions: [],
        agentState: {},
        ownerId: userId,
      },
    });

    let librarianCalled = false;
    const spyingProvider: IModelProvider = {
      ...stubModelProvider,
      async chat(opts: Parameters<IModelProvider['chat']>[0]) {
        librarianCalled = true;
        return stubModelProvider.chat(opts);
      },
    };

    await expect(runEstimate(est.id, { db, modelProvider: spyingProvider })).rejects.toThrow(/too short|empty/i);
    expect(librarianCalled).toBe(false);

    await db.estimate.delete({ where: { id: est.id } });
  });
});

describe('durable step runner (Inngest) does not change the result', () => {
  it('survives every stage being JSON round-tripped, as Inngest memoises it', async () => {
    // Inngest persists each step.run() result as JSON and replays it on the
    // next invocation, so a stage returning anything non-JSON-serialisable
    // (Date, Map, undefined-valued key, class instance) would silently mutate
    // between stages in production while passing an inline test. Simulate that
    // exactly: serialise every checkpoint the way the real runner does.
    const seen: string[] = [];
    const jsonStep: StepRunner = async (id, fn) => {
      seen.push(id);
      return JSON.parse(JSON.stringify(await fn()));
    };

    const result = await runEstimate(estimateId, {
      db,
      modelProvider: stubModelProvider,
      step: jsonStep,
    });

    expect(result.status).toBe('REVIEW');
    expect(result.menuItemCount).toBe(2);

    // The expensive stages are each their own checkpoint — in particular one
    // per requirement, which is what keeps a step inside Vercel's ceiling.
    expect(seen).toContain('librarian');
    expect(seen).toContain('detective');
    expect(seen).toContain('architect');
    expect(seen).toContain('persist-menu-card');
    expect(seen.filter((id) => id.startsWith('specialists:'))).toHaveLength(2); // one per requirement

    // And the persisted card is identical to the inline path's.
    const items = await db.menuItem.findMany({
      where: { estimateId },
      include: { lineItems: true },
    });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.lineItems.map((li) => li.role).sort()).toEqual(['BA', 'DEV', 'PM', 'QA']);
      const qa = item.lineItems.find((li) => li.role === 'QA')!;
      expect(qa.taxedHours).toBeGreaterThan(qa.baseHours);
    }
  });
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
