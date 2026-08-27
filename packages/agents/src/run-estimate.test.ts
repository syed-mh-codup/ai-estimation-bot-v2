import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import { runEstimate, type StepRunner, type RunDiagnostics } from './run-estimate';
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
      status: 'DRAFT',
      configVersion: cfg.version,
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
        status: 'DRAFT',
        configVersion,
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

  /**
   * The declared type and the payload drifted apart once already:
   * `AgentStateSnapshot` described librarianOutput / archivistOutput /
   * architectOutput while the pipeline wrote seven entirely different keys, and
   * nobody noticed because nothing read the column.
   *
   * `satisfies RunDiagnostics` on the write would be the obvious guard and is
   * the wrong one — it hides the object literal from the field audit's Json-key
   * discovery, which then audits `agentState` as one opaque column and reports
   * green with all seven keys unaudited. So the guard lives here, against what
   * is actually persisted, which is the stronger check anyway.
   */
  it('persists exactly the diagnostics keys RunDiagnostics declares', async () => {
    await runEstimate(estimateId, { db, modelProvider: stubModelProvider });

    const est = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    const state = est.agentState as Record<string, unknown>;

    const declared: Array<keyof RunDiagnostics> = [
      'archivistMatchCount',
      'complexity',
      'detectiveQuestionCount',
      'detectiveRiskCount',
      'gateWarnings',
      'librarianOutput',
      'ranAt',
    ];
    expect(Object.keys(state).sort()).toEqual([...declared].sort());

    // And the shapes the diagnostics panel actually renders.
    expect(typeof state['ranAt']).toBe('string');
    expect(Array.isArray(state['gateWarnings'])).toBe(true);
    expect(typeof state['archivistMatchCount']).toBe('number');
    expect((state['librarianOutput'] as { requirements: unknown[] }).requirements.length).toBeGreaterThan(0);
  });
});

// ─── WS15-04: the hidden-work stage, running inside the real pipeline ─────────

/**
 * The stage had tests from the day it was written and none of them proved the
 * thing that actually mattered: that it runs. Every export was reachable only
 * from ws15.test.ts, so the unit tests passed for years while no estimate ever
 * went through the stage. That is the failure this describe exists to catch, so
 * it deliberately goes through `runEstimate` rather than calling the audit
 * directly.
 *
 * Its own stub and its own estimate: the shared stub's Detective returns no
 * risks at all, and the two suites above assert on exactly two menu items, so a
 * third injected card would break them. That coupling is the point — it is what
 * makes this a genuine addition rather than a variant of the same assertion.
 */
const riskyStubModelProvider: IModelProvider = {
  async chat({ messages }) {
    const content = messages.map((m) => m.content).join('\n');
    if (content.includes('Decompose this SOW')) {
      return JSON.stringify({
        requirements: [
          {
            text: 'Sync orders from Shopify',
            category: 'Integration / Celigo',
            reqType: 'Data Sync',
            platforms: ['Shopify'],
            projectSize: 'Mid-market',
            dataVolume: 'High',
            integrationCount: 2,
            candidateMenuCardId: 'MC-INT-ORDER-SYNC',
            taxonomyKey: null,
            sourceRef: 'SOW §3.2',
            ambiguities: [],
            blocksEstimation: false,
          },
        ],
      });
    }
    if (content.includes('Investigate the risky and unknown parts')) {
      return JSON.stringify({
        risks: [
          {
            requirementId: 'REQ-001',
            claim: 'Shopify throttles the Admin API at 2 requests per second',
            riskFlags: ['rate-limits'],
            citation: 'SOW §3.2',
            spikeRecommended: false,
          },
          {
            requirementId: 'REQ-001',
            claim: 'Client requires SOC2 evidence for the integration',
            riskFlags: ['soc2-audit'],
            citation: 'SOW §9.1',
            spikeRecommended: false,
          },
        ],
        questions: [],
      });
    }
    if (content.includes('Estimate') && content.includes('effort for this requirement')) {
      // Claims nothing, so both flags stay uncovered. 3.5h is deliberately not
      // 8 — the flat DEV default this ticket deleted — so the injected card's
      // hours prove the council actually ran.
      return JSON.stringify({
        lineItems: [{ description: 'stub line item', hours: 3.5, complexity: 'base', aiAssistApplied: false, dependsOn: [] }],
        assumptions: [],
        coversRiskFlags: [],
      });
    }
    if (content.includes('Synthesise the specialists')) {
      return JSON.stringify({
        narrative: Array.from({ length: 8 }, (_, i) => `Stub narrative sentence ${i + 1}.`),
        cards: [{ menuCardId: 'MC-INT-ORDER-SYNC', phase: 'Core', thinSlice: false }],
      });
    }
    return '{}';
  },
  async embed() {
    return [[0, 0, 0]];
  },
};

describe('WS15-04: hidden-work audit runs inside the pipeline', () => {
  let riskyEstimateId = '';

  beforeAll(async () => {
    // Give this estimate real overhead config. The file-level fixture uses `{}`
    // deliberately (the suites above count menu items exactly), and this describe
    // runs last, so switching it on here exercises the injector end-to-end
    // without disturbing them.
    await db.estimationConfig.updateMany({
      where: { active: true },
      data: {
        infraBaseline: {
          items: [
            { title: 'Code Review', taxonomyKey: 'process.code-review', pct: { DEV: 10 } },
            { title: 'Manual End-to-End Passes', taxonomyKey: 'process.manual-e2e', pct: { QA: 20 } },
          ],
        },
      },
    });

    const est = await db.estimate.create({
      data: {
        title: 'Hidden Work Test',
        sowText: 'Sync orders from Shopify into the warehouse system every fifteen minutes.',
        status: 'DRAFT',
        configVersion,
        narrative: [],
        assumptions: [],
        agentState: {},
        ownerId: userId,
      },
    });
    riskyEstimateId = est.id;
    await runEstimate(riskyEstimateId, { db, modelProvider: riskyStubModelProvider });
  });

  afterAll(async () => {
    const items = await db.menuItem.findMany({ where: { estimateId: riskyEstimateId }, select: { id: true } });
    await db.roleLineItem.deleteMany({ where: { menuItemId: { in: items.map((i) => i.id) } } });
    await db.menuItem.deleteMany({ where: { estimateId: riskyEstimateId } });
    await db.estimate.delete({ where: { id: riskyEstimateId } });
  });

  it('costs an unclaimed known flag into a card marked injected', async () => {
    const injected = await db.menuItem.findMany({
      where: { estimateId: riskyEstimateId, injected: true, taxonomyKey: { startsWith: 'infra.' } },
      include: { lineItems: true },
    });
    expect(injected).toHaveLength(1);
    expect(injected[0]!.taxonomyKey).toBe('infra.rate-limit');
  });

  it('injects delivery overhead as a percentage of the asked-for work', async () => {
    const overhead = await db.menuItem.findMany({
      where: { estimateId: riskyEstimateId, taxonomyKey: { startsWith: 'process.' } },
      include: { lineItems: true },
      orderBy: { taxonomyKey: 'asc' },
    });
    expect(overhead.map((m) => m.taxonomyKey)).toEqual([
      'process.code-review',
      'process.manual-e2e',
    ]);
    for (const card of overhead) expect(card.injected).toBe(true);

    // Sized off the ASKED-FOR card only. The stub gives one requirement 3.5h per
    // role; DEV is untaxed, so 10% of 3.5 rounds to 0.25h at quarter-hour
    // granularity. The inferred rate-limit card's own 3.5h DEV must NOT count,
    // or overhead would be compounding on overhead.
    const review = overhead.find((m) => m.taxonomyKey === 'process.code-review')!;
    const dev = review.lineItems.find((li) => li.role === 'DEV')!;
    expect(dev.baseHours).toBe(0.25);
    // Percentages were taken over taxed hours, so these are not taxed again.
    expect(dev.taxedHours).toBe(dev.baseHours);
  });

  it('gives the injected card the council hours, not a flat default', async () => {
    const card = await db.menuItem.findFirstOrThrow({
      where: { estimateId: riskyEstimateId, injected: true },
      include: { lineItems: true },
    });
    const dev = card.lineItems.find((li) => li.role === 'DEV')!;
    // The deleted default was DEV 8 regardless of anything. 3.5 is the stub's.
    expect(dev.baseHours).toBe(3.5);
    expect(dev.baseHours).not.toBe(8);
  });

  it('taxes injected hours like any other card', async () => {
    const card = await db.menuItem.findFirstOrThrow({
      where: { estimateId: riskyEstimateId, injected: true },
      include: { lineItems: true },
    });
    // Injection runs BEFORE taxation precisely so this holds. The old injectors
    // set taxedHours = baseHours and skipped tax entirely.
    const qa = card.lineItems.find((li) => li.role === 'QA')!;
    expect(qa.taxedHours).toBeGreaterThan(qa.baseHours);
  });

  it('raises the off-list flag for a human instead of dropping it', async () => {
    const findings = await db.hiddenWorkFinding.findMany({
      where: { estimateId: riskyEstimateId },
      orderBy: { riskFlag: 'asc' },
    });
    expect(findings.map((f) => f.riskFlag)).toEqual(['rate-limits', 'soc2-audit']);

    const soc2 = findings.find((f) => f.riskFlag === 'soc2-audit')!;
    expect(soc2.known).toBe(false);
    expect(soc2.outcome).toBe('OPEN');
    // The argument travels with it, or a human cannot decide anything.
    expect(soc2.claim).toContain('SOC2');
    expect(soc2.citation).toBe('SOW §9.1');

    const rate = findings.find((f) => f.riskFlag === 'rate-limits')!;
    expect(rate.outcome).toBe('AUTO_COST');
    expect(rate.menuItemId).not.toBeNull();
  });

  it('does not re-raise or overwrite findings when the estimate is re-run', async () => {
    await db.hiddenWorkFinding.updateMany({
      where: { estimateId: riskyEstimateId, riskFlag: 'soc2-audit' },
      data: { outcome: 'DISMISSED', dismissReason: 'Client already SOC2 certified' },
    });

    await runEstimate(riskyEstimateId, { db, modelProvider: riskyStubModelProvider });

    const findings = await db.hiddenWorkFinding.findMany({
      where: { estimateId: riskyEstimateId },
    });
    expect(findings).toHaveLength(2);
    const soc2 = findings.find((f) => f.riskFlag === 'soc2-audit')!;
    // A re-run re-detects the risk. It must not un-decide it.
    expect(soc2.outcome).toBe('DISMISSED');
    expect(soc2.dismissReason).toBe('Client already SOC2 certified');
  });
});
