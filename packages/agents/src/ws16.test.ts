import { describe, it, expect, vi } from 'vitest';
import {
  assembleCardsFromSpecialists,
  collateAssumptions,
  getAffectedChildren,
  runArchitect,
  type ArchitectContext,
  type ArchitectDeps,
} from './architect';
import type { IModelProvider } from '@repo/providers';
import type { MenuItem, SpecialistOutput, Requirement, SpecialistLineItem } from '@repo/shared';

const mockModel: IModelProvider = { chat: vi.fn(), embed: vi.fn() };

const ctx: ArchitectContext = {
  modelProvider: mockModel,
  modelString: 'openrouter/anthropic/claude-3-haiku',
  instructions: 'You are the Architect agent.',
};

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-001',
    text: 'Build B2B checkout',
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
    ...overrides,
  };
}

function makeLineItem(overrides: Partial<SpecialistLineItem> = {}): SpecialistLineItem {
  return {
    id: 'DEV-REQ-001-01',
    requirementId: 'REQ-001',
    menuCardId: 'MC-B2B-CHECKOUT',
    description: 'Checkout happy path',
    hours: 3,
    complexity: 'base',
    aiAssistApplied: false,
    dependsOn: [],
    anchorPresetIds: [],
    ...overrides,
  };
}

function makeSpecialistOutput(
  role: 'DEV' | 'QA' | 'PM' | 'BA',
  lineItems: SpecialistLineItem[],
  assumptions: string[] = [],
): SpecialistOutput {
  return { role, lineItems, assumptions };
}

// ─── Menu-card assembly from specialist line items ───────────────────────────

describe('assembleCardsFromSpecialists — groups line items by candidate_menu_card_id', () => {
  it('groups line items from multiple roles/requirements into their menu cards', () => {
    const requirements = [
      makeRequirement(),
      makeRequirement({ id: 'REQ-002', text: 'SSO login', candidateMenuCardId: 'MC-B2B-AUTH', category: 'B2B' }),
    ];
    const outputs = [
      makeSpecialistOutput('DEV', [
        makeLineItem({ id: 'DEV-REQ-001-01', hours: 3 }),
        makeLineItem({ id: 'DEV-REQ-001-02', hours: 2 }),
      ]),
      makeSpecialistOutput('QA', [makeLineItem({ id: 'QA-REQ-001-01', hours: 1.5 })]),
      makeSpecialistOutput('DEV', [
        makeLineItem({ id: 'DEV-REQ-002-01', requirementId: 'REQ-002', menuCardId: 'MC-B2B-AUTH', hours: 4 }),
      ]),
    ];

    const cards = assembleCardsFromSpecialists(requirements, outputs);

    expect(cards).toHaveLength(2);
    const checkoutCard = cards.find((c) => c.id === 'MC-B2B-CHECKOUT');
    expect(checkoutCard?.lineItems).toHaveLength(3);
    expect(checkoutCard?.requirementIds).toEqual(['REQ-001']);
    const authCard = cards.find((c) => c.id === 'MC-B2B-AUTH');
    expect(authCard?.lineItems).toHaveLength(1);
  });

  it('produces no cards when there are no line items', () => {
    expect(assembleCardsFromSpecialists([], [])).toHaveLength(0);
  });
});

// ─── Deterministic Assumption Set ─────────────────────────────────────────────

describe('collateAssumptions — dedupe + stable ordering', () => {
  it('duplicate assumptions are merged into one', () => {
    const outputs: SpecialistOutput[] = [
      makeSpecialistOutput('DEV', [makeLineItem()], ['Standard timeline assumed', 'No custom auth']),
      makeSpecialistOutput('QA', [makeLineItem()], ['Standard timeline assumed', 'Automated testing environment']),
      makeSpecialistOutput('PM', [makeLineItem()], ['No custom auth', 'Weekly sync meetings']),
    ];

    const assumptions = collateAssumptions(outputs);

    expect(assumptions.length).toBe(4);
    const unique = new Set(assumptions.map((a) => a.toLowerCase().trim()));
    expect(unique.size).toBe(assumptions.length);
  });

  it('produces same ordering for identical inputs (stable)', () => {
    const outputs: SpecialistOutput[] = [
      makeSpecialistOutput('DEV', [makeLineItem()], ['B assumption', 'A assumption']),
      makeSpecialistOutput('QA', [makeLineItem()], ['C assumption']),
    ];

    expect(collateAssumptions(outputs)).toEqual(collateAssumptions(outputs));
  });

  it('returns empty array when no assumptions', () => {
    const assumptions = collateAssumptions([
      makeSpecialistOutput('DEV', [makeLineItem()], []),
      makeSpecialistOutput('QA', [makeLineItem()], []),
    ]);
    expect(assumptions).toHaveLength(0);
  });
});

// ─── getAffectedChildren (unchanged UI helper) ────────────────────────────────

describe('getAffectedChildren', () => {
  function makeMenuItem(id: string, parentItemId?: string): MenuItem {
    return { id, taxonomyKey: id, title: id, enabled: true, parentItemId, lineItems: [] };
  }

  it('returns children of a given parent', () => {
    const items = [
      makeMenuItem('parent-1'),
      makeMenuItem('child-1', 'parent-1'),
      makeMenuItem('child-2', 'parent-1'),
      makeMenuItem('unrelated'),
    ];

    const children = getAffectedChildren(items, 'parent-1');
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parentItemId === 'parent-1')).toBe(true);
  });
});

// ─── Full Architect pipeline ──────────────────────────────────────────────────

describe('runArchitect — narrative + card assembly', () => {
  const requirements = [makeRequirement()];
  const specialistOutputs = [
    makeSpecialistOutput('DEV', [makeLineItem({ hours: 3 }), makeLineItem({ id: 'DEV-REQ-001-02', hours: 2 })]),
    makeSpecialistOutput('QA', [makeLineItem({ id: 'QA-REQ-001-01', hours: 1.5 })]),
  ];

  function mockArchitectResponse(narrative: string[], cards: Array<{ menuCardId: string; phase: string; thinSlice?: boolean }>) {
    vi.mocked(mockModel.chat).mockResolvedValueOnce(JSON.stringify({ narrative, cards }));
  }

  it('produces a single cohesive narrative and one menu card per candidate_menu_card_id', async () => {
    mockArchitectResponse(
      Array.from({ length: 8 }, (_, i) => `Sentence ${i + 1} about the B2B checkout build.`),
      [{ menuCardId: 'MC-B2B-CHECKOUT', phase: 'Core', thinSlice: true }],
    );

    const deps: ArchitectDeps = { ctx, requirements, archivistMatches: [], specialistOutputs };
    const result = await runArchitect(deps);

    expect(result.narrative).toHaveLength(8);
    expect(result.menuItems).toHaveLength(1);
    expect(result.menuItems[0]?.id).toBe('MC-B2B-CHECKOUT');
    expect(result.menuItems[0]?.title).toBe('B2B Checkout');
    expect(result.menuItems[0]?.phase).toBe('Core');
    expect(result.menuItems[0]?.thinSlice).toBe(true);
    expect(result.menuItems[0]?.lineItems).toHaveLength(3);
    expect(result.consistencyFlags).toHaveLength(0);
  });

  it('marks a card notSafelyRemovable when another requirement requires one of its requirements', async () => {
    mockArchitectResponse(['Sentence.'], [{ menuCardId: 'MC-B2B-CHECKOUT', phase: 'Foundation' }]);

    const archivistMatches = [
      {
        requirementId: 'REQ-002',
        taxonomyKey: null,
        coverage: 'none' as const,
        adjustments: { projectSizeDelta: '', dataVolume: 'Low' as const, integrationCount: 0, aiAssist: 'Low' as const, risk: 'Low' as const },
        rationale: 'n/a',
        sequencing: { requires: ['REQ-001'], blocks: [], canParallel: true },
      },
    ];

    const result = await runArchitect({ ctx, requirements, archivistMatches, specialistOutputs });
    expect(result.menuItems[0]?.notSafelyRemovable).toBe(true);
    expect(result.menuItems[0]?.toggleable).toBe(false);
  });

  it('flags (does not silently clamp) a line item found over the four-hour cap', async () => {
    mockArchitectResponse(['Sentence.'], [{ menuCardId: 'MC-B2B-CHECKOUT', phase: 'Core' }]);

    const badOutputs = [makeSpecialistOutput('DEV', [{ ...makeLineItem(), hours: 4 }])];
    // Bypass the Specialist schema (which would normally reject >4h) to prove
    // the Architect independently checks the invariant on whatever it's given.
    (badOutputs[0]!.lineItems[0] as { hours: number }).hours = 9;

    const result = await runArchitect({ ctx, requirements, archivistMatches: [], specialistOutputs: badOutputs });
    expect(result.consistencyFlags.length).toBeGreaterThan(0);
  });

  it('surfaces the strongest non-none Archivist match as the card sourcePresetId/matchScore', async () => {
    mockArchitectResponse(['Sentence.'], [{ menuCardId: 'MC-B2B-CHECKOUT', phase: 'Core' }]);

    const archivistMatches = [
      {
        requirementId: 'REQ-001',
        taxonomyKey: 'b2b.checkout',
        coverage: 'full' as const,
        presetId: 'P32',
        presetVersion: 1,
        score: 0.82,
        beHours: 20,
        feHours: 10,
        adjustments: { projectSizeDelta: '', dataVolume: 'Low' as const, integrationCount: 0, aiAssist: 'Low' as const, risk: 'Low' as const },
        rationale: 'Closely matches preset "B2B cart logic" (P32).',
        sequencing: { requires: [], blocks: [], canParallel: true },
      },
    ];

    const result = await runArchitect({ ctx, requirements, archivistMatches, specialistOutputs });
    expect(result.menuItems[0]?.sourcePresetId).toBe('P32');
    expect(result.menuItems[0]?.matchScore).toBe(0.82);
  });

  it('leaves sourcePresetId/matchScore unset when every requirement on the card is coverage:none', async () => {
    mockArchitectResponse(['Sentence.'], [{ menuCardId: 'MC-B2B-CHECKOUT', phase: 'Core' }]);

    const archivistMatches = [
      {
        requirementId: 'REQ-001',
        taxonomyKey: null,
        coverage: 'none' as const,
        adjustments: { projectSizeDelta: '', dataVolume: 'Low' as const, integrationCount: 0, aiAssist: 'Low' as const, risk: 'Low' as const },
        rationale: 'No historical analogue found.',
        sequencing: { requires: [], blocks: [], canParallel: true },
      },
    ];

    const result = await runArchitect({ ctx, requirements, archivistMatches, specialistOutputs });
    expect(result.menuItems[0]?.sourcePresetId).toBeUndefined();
    expect(result.menuItems[0]?.matchScore).toBeUndefined();
  });

  it('produces no menu cards (and skips the LLM call) when there are no line items', async () => {
    const result = await runArchitect({ ctx, requirements, archivistMatches: [], specialistOutputs: [] });
    expect(result.menuItems).toHaveLength(0);
    expect(result.narrative).toHaveLength(0);
  });
});
