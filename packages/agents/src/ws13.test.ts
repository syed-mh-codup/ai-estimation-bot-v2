import { describe, it, expect, vi } from 'vitest';
import { runSpecialist, runSpecialistCouncil, type SpecialistContext } from './specialist';
import type { IModelProvider } from '@repo/providers';
import type { SpecialistInput, ArchivistMatch, Requirement } from '@repo/shared';

const mockModel: IModelProvider = { chat: vi.fn(), chatStream: vi.fn(), embed: vi.fn() };

const INSTRUCTIONS = {
  DEV: 'You are SPECIALIST_DEV. Decompose into <=4h line items.',
  QA: 'You are SPECIALIST_QA. Decompose into <=4h line items.',
  PM: 'You are SPECIALIST_PM. Decompose into <=4h line items.',
  BA: 'You are SPECIALIST_BA. Decompose into <=4h line items.',
};

const ctx: SpecialistContext = {
  modelProvider: mockModel,
  modelString: 'openrouter/anthropic/claude-3-haiku',
  instructions: INSTRUCTIONS,
};

const sampleRequirement: Requirement = {
  id: 'REQ-001',
  text: 'B2B checkout flow with cart management',
  category: 'B2B',
  reqType: 'Checkout',
  platforms: ['Shopify'],
  projectSize: 'Mid-market',
  dataVolume: 'Low',
  integrationCount: 1,
  candidateMenuCardId: 'MC-B2B-CHECKOUT',
  taxonomyKey: 'b2b.checkout',
  sourceRef: 'SOW section 1',
  ambiguities: [],
  blocksEstimation: false,
};

const sampleMatch: ArchivistMatch = {
  requirementId: 'REQ-001',
  taxonomyKey: 'b2b.checkout',
  coverage: 'full',
  presetId: 'preset-123',
  presetVersion: 1,
  score: 0.9,
  devHours: 60,
  touchesBackend: true,
  touchesFrontend: true,
  adjustments: {
    projectSizeDelta: 'fits Mid-market',
    dataVolume: 'Low',
    integrationCount: 1,
    aiAssist: 'Low',
    risk: 'Medium',
  },
  rationale: 'matches B2B checkout preset',
  sequencing: { requires: [], blocks: [], canParallel: true },
  presetCaveats: [],
};

const sampleInput: SpecialistInput = {
  requirement: sampleRequirement,
  menuCardId: 'MC-B2B-CHECKOUT',
  archivistMatch: sampleMatch,
  riskFindings: [
    {
      id: 'RISK-001',
      requirementId: 'REQ-001',
      taxonomyKey: 'b2b.checkout',
      claim: 'API rate limits apply',
      riskFlags: ['rate-limits', 'retries'],
      citation: 'docs.stripe.com',
      spikeRecommended: false,
    },
  ],
  complexityScore: 3,
};

function mockLLMResponse(
  lineItems: Array<{ description: string; hours: number; complexity?: 'base' | 'elevated' | 'high'; dependsOn?: number[] }>,
  assumptions: string[] = [],
) {
  vi.mocked(mockModel.chat).mockResolvedValueOnce(
    JSON.stringify({
      lineItems: lineItems.map((li) => ({
        complexity: 'base',
        dependsOn: [],
        aiAssistApplied: false,
        ...li,
      })),
      assumptions,
    }),
  );
}

// ─── WS13-01: Dev specialist ──────────────────────────────────────────────────

describe('WS13-01: Dev specialist — decomposes into <=4h line items', () => {
  it('produces line items, each <=4h, with an id/requirementId/description', async () => {
    mockLLMResponse([
      { description: 'Scaffolding + cart schema', hours: 3.5 },
      { description: 'Checkout happy path', hours: 4 },
      { description: 'Edge cases & error handling', hours: 2.25 },
    ]);

    const result = await runSpecialist('DEV', sampleInput, ctx);

    expect(result.role).toBe('DEV');
    expect(result.lineItems.length).toBeGreaterThan(1);
    for (const li of result.lineItems) {
      expect(li.hours).toBeLessThanOrEqual(4);
      expect(li.hours).toBeGreaterThan(0);
      expect(li.requirementId).toBe('REQ-001');
      expect(li.id.startsWith('DEV-REQ-001-')).toBe(true);
    }
  });

  it('splits (does not throw or silently drop) a line item whose hours exceed the four-hour cap into <=4h chunks that chain via dependsOn', async () => {
    mockLLMResponse([{ description: 'Too big a chunk', hours: 9 }]);

    const result = await runSpecialist('DEV', sampleInput, ctx);

    expect(result.lineItems).toHaveLength(3);
    for (const li of result.lineItems) {
      expect(li.hours).toBeLessThanOrEqual(4);
      expect(li.hours).toBeGreaterThanOrEqual(0.25);
    }
    expect(result.lineItems.reduce((s, li) => s + li.hours, 0)).toBeCloseTo(9, 5);
    expect(result.lineItems[0]?.dependsOn).toEqual([]);
    expect(result.lineItems[1]?.dependsOn).toEqual([result.lineItems[0]?.id]);
    expect(result.lineItems[2]?.dependsOn).toEqual([result.lineItems[1]?.id]);
  });
});

// ─── WS13-02: QA specialist ───────────────────────────────────────────────────

describe('WS13-02: QA specialist — independent of Dev hours', () => {
  it('produces its own QA line items', async () => {
    mockLLMResponse([{ description: 'Functional test design', hours: 2 }], ['Test env setup needed']);

    const result = await runSpecialist('QA', sampleInput, ctx);

    expect(result.role).toBe('QA');
    expect(result.lineItems).toHaveLength(1);
    expect(result.assumptions).toContain('Test env setup needed');
  });
});

// ─── WS13-03: PM specialist ───────────────────────────────────────────────────

describe('WS13-03: PM specialist — coordination effort decomposed into line items', () => {
  it('produces PM line items', async () => {
    mockLLMResponse([{ description: 'Sprint ceremonies', hours: 1.5 }], ['Weekly sync required']);

    const result = await runSpecialist('PM', sampleInput, ctx);

    expect(result.role).toBe('PM');
    expect(result.lineItems[0]?.description).toBeTruthy();
  });
});

// ─── WS13-04: BA specialist ───────────────────────────────────────────────────

describe('WS13-04: BA specialist — analysis effort decomposed into line items', () => {
  it('produces BA line items', async () => {
    mockLLMResponse([{ description: 'Acceptance criteria authoring', hours: 2 }], ['AC review needed']);

    const result = await runSpecialist('BA', sampleInput, ctx);

    expect(result.role).toBe('BA');
    expect(result.lineItems[0]?.description).toBeTruthy();
  });
});

// ─── WS13-05: Specialist Council — 4 roles per requirement ───────────────────

describe('WS13-05: Assemble 4 independent role outputs per requirement', () => {
  it('runSpecialistCouncil returns exactly DEV/QA/PM/BA outputs', async () => {
    mockLLMResponse([{ description: 'Dev work', hours: 3 }]);
    mockLLMResponse([{ description: 'QA work', hours: 2 }]);
    mockLLMResponse([{ description: 'PM work', hours: 1 }]);
    mockLLMResponse([{ description: 'BA work', hours: 1.5 }]);

    const results = await runSpecialistCouncil(sampleInput, ctx);

    expect(results).toHaveLength(4);
    const roles = results.map((r) => r.role);
    expect(roles).toContain('DEV');
    expect(roles).toContain('QA');
    expect(roles).toContain('PM');
    expect(roles).toContain('BA');
  });

  it('each role has independent hours (QA total != DEV total)', async () => {
    mockLLMResponse([{ description: 'Dev A', hours: 4 }, { description: 'Dev B', hours: 4 }]);
    mockLLMResponse([{ description: 'QA A', hours: 2.5 }]);
    mockLLMResponse([{ description: 'PM A', hours: 1 }]);
    mockLLMResponse([{ description: 'BA A', hours: 1 }]);

    const results = await runSpecialistCouncil(sampleInput, ctx);

    const devTotal = results.find((r) => r.role === 'DEV')?.lineItems.reduce((s, li) => s + li.hours, 0);
    const qaTotal = results.find((r) => r.role === 'QA')?.lineItems.reduce((s, li) => s + li.hours, 0);

    expect(devTotal).toBe(8);
    expect(qaTotal).toBe(2.5);
    expect(devTotal).not.toBe(qaTotal);
  });

  it('resolves dependsOn indices to real line_item_ids', async () => {
    mockLLMResponse([
      { description: 'Schema', hours: 2 },
      { description: 'Happy path (depends on schema)', hours: 3, dependsOn: [0] },
    ]);

    const result = await runSpecialist('DEV', sampleInput, ctx);
    expect(result.lineItems[1]?.dependsOn).toEqual([result.lineItems[0]?.id]);
  });

  it('drops 0-hour "not needed" placeholder items instead of throwing, and remaps dependsOn around the gap', async () => {
    mockLLMResponse([
      { description: 'Schema', hours: 2 },
      { description: 'Integration testing (not required, integration count 0)', hours: 0 },
      { description: 'Happy path (depends on schema)', hours: 3, dependsOn: [0] },
    ]);

    const result = await runSpecialist('DEV', sampleInput, ctx);

    expect(result.lineItems).toHaveLength(2);
    expect(result.lineItems.every((li) => li.hours >= 0.25)).toBe(true);
    expect(result.lineItems[1]?.dependsOn).toEqual([result.lineItems[0]?.id]);
  });
});
