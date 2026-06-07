import { describe, it, expect, vi } from 'vitest';
import {
  generateNarrative,
  collateAssumptions,
  assembleMenuCard,
  getAffectedChildren,
  runArchitect,
  type ArchitectContext,
  type ArchitectDeps,
} from './architect';
import type { IModelProvider } from '@repo/providers';
import type { MenuItem, SpecialistOutput, Requirement, RoleLineItem, ArchivistMatch } from '@repo/shared';

const mockModel: IModelProvider = { chat: vi.fn(), embed: vi.fn() };

const ctx: ArchitectContext = {
  modelProvider: mockModel,
  modelString: 'openrouter/anthropic/claude-3-haiku',
  instructions: 'You are the Architect agent.',
};

function makeMenuItem(id: string, taxonomyKey: string, enabled = true): MenuItem {
  const lineItems: RoleLineItem[] = [
    { role: 'DEV', baseHours: 20, taxedHours: 20, edited: false },
  ];
  return { id, taxonomyKey, title: id, enabled, lineItems };
}

function makeSpecialistOutput(role: 'DEV' | 'QA' | 'PM' | 'BA', assumptions: string[]): SpecialistOutput {
  return { role, baseHours: 20, rationale: 'Test', assumptions };
}

const requirements: Requirement[] = [
  { text: 'Build B2B checkout', taxonomyKey: 'b2b.checkout', confidence: 0.9 },
];

// ─── WS16-01: Narrative array generation ─────────────────────────────────────

describe('WS16-01: Narrative array — one sentence per enabled menu item', () => {
  it('narrative length matches enabled menu item count', async () => {
    const items = [
      makeMenuItem('item-1', 'b2b.checkout', true),
      makeMenuItem('item-2', 'auth.sso', true),
      makeMenuItem('item-3', 'infra.setup', false), // disabled
    ];
    const enabled = items.filter((m) => m.enabled);

    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({ narrative: ['Implement B2B checkout flow.', 'Implement SSO authentication.'] }),
    );

    const narrative = await generateNarrative(enabled, requirements, ctx);
    expect(narrative.length).toBe(enabled.length);
  });

  it('narrative sentences reference real item titles/taxonomy', async () => {
    const items = [makeMenuItem('B2B Checkout Flow', 'b2b.checkout', true)];

    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({ narrative: ['We will implement the B2B Checkout Flow using a multi-step checkout pattern.'] }),
    );

    const narrative = await generateNarrative(items, requirements, ctx);
    expect(narrative[0]).toContain('B2B Checkout Flow');
  });

  it('returns empty array for no enabled items', async () => {
    const narrative = await generateNarrative([], requirements, ctx);
    expect(narrative).toHaveLength(0);
  });

  it('falls back gracefully when LLM returns bad JSON', async () => {
    vi.mocked(mockModel.chat).mockResolvedValue('not json at all');

    const items = [makeMenuItem('Item A', 'feature.a', true)];
    const narrative = await generateNarrative(items, requirements, ctx);
    expect(narrative.length).toBe(1);
    expect(narrative[0]).toContain('Item A');
  });
});

// ─── WS16-02: Deterministic Assumption Set ───────────────────────────────────

describe('WS16-02: Deterministic Assumption Set — dedupe + stable ordering', () => {
  it('duplicate assumptions are merged into one', () => {
    const outputs: SpecialistOutput[] = [
      makeSpecialistOutput('DEV', ['Standard timeline assumed', 'No custom auth']),
      makeSpecialistOutput('QA', ['Standard timeline assumed', 'Automated testing environment']),
      makeSpecialistOutput('PM', ['No custom auth', 'Weekly sync meetings']),
    ];

    const assumptions = collateAssumptions(outputs);

    // Should have 4 unique assumptions
    expect(assumptions.length).toBe(4);
    // No duplicates
    const unique = new Set(assumptions.map((a) => a.toLowerCase().trim()));
    expect(unique.size).toBe(assumptions.length);
  });

  it('produces same ordering for identical inputs (stable)', () => {
    const outputs: SpecialistOutput[] = [
      makeSpecialistOutput('DEV', ['B assumption', 'A assumption']),
      makeSpecialistOutput('QA', ['C assumption']),
    ];

    const run1 = collateAssumptions(outputs);
    const run2 = collateAssumptions(outputs);

    expect(run1).toEqual(run2);
  });

  it('returns empty array when no assumptions', () => {
    const assumptions = collateAssumptions([
      makeSpecialistOutput('DEV', []),
      makeSpecialistOutput('QA', []),
    ]);
    expect(assumptions).toHaveLength(0);
  });
});

// ─── WS16-03: Menu Card assembly with parent/child mapping ────────────────────

describe('WS16-03: Menu Card assembly — parent/child linking', () => {
  it('child items link to parents via parentItemId', () => {
    const items = [
      makeMenuItem('parent-1', 'b2b'),
      makeMenuItem('child-1', 'b2b.checkout'),
      makeMenuItem('child-2', 'b2b.cart'),
    ];

    const assembled = assembleMenuCard(items, []);

    const checkout = assembled.find((m) => m.taxonomyKey === 'b2b.checkout');
    const cart = assembled.find((m) => m.taxonomyKey === 'b2b.cart');

    expect(checkout?.parentItemId).toBe('parent-1');
    expect(cart?.parentItemId).toBe('parent-1');
  });

  it('getAffectedChildren returns children of a disabled parent', () => {
    const items = [
      makeMenuItem('parent-1', 'b2b'),
      { ...makeMenuItem('child-1', 'b2b.checkout'), parentItemId: 'parent-1' },
      { ...makeMenuItem('child-2', 'b2b.cart'), parentItemId: 'parent-1' },
      makeMenuItem('unrelated', 'auth.sso'),
    ];

    const children = getAffectedChildren(items, 'parent-1');
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.parentItemId === 'parent-1')).toBe(true);
  });

  it('items without parent prefix have no parentItemId', () => {
    const items = [
      makeMenuItem('item-a', 'auth.sso'),
      makeMenuItem('item-b', 'payments.gateway'),
    ];

    const assembled = assembleMenuCard(items, []);
    for (const item of assembled) {
      expect(item.parentItemId).toBeUndefined();
    }
  });
});
