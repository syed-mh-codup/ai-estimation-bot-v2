import { describe, it, expect, vi } from 'vitest';
import { runSpecialist } from './specialist';
import type { IModelProvider } from '@repo/providers';
import type { SpecialistInput } from '@repo/shared';

/**
 * DEV stays a SINGLE combined hours figure. `touchesFrontend`/`touchesBackend`
 * describe what that figure covers so a finalised estimate can map onto a
 * preset's beHours/feHours exactly — replacing the fabricated 40% frontend
 * markup in writeback. These tests pin the invariant that matters most: the
 * tag never changes the number.
 */

function providerReturning(payload: unknown): IModelProvider {
  return {
    chat: vi.fn().mockResolvedValue(JSON.stringify(payload)),
    embed: vi.fn(),
  } as unknown as IModelProvider;
}

const input: SpecialistInput = {
  requirement: {
    id: 'REQ-001',
    text: 'Company location selector with pricing lookup',
    category: 'Storefront',
    reqType: 'FEATURE',
    platforms: ['web'],
    projectSize: 'Mid-market',
    dataVolume: 'Low',
    integrationCount: 1,
    ambiguities: [],
    candidateMenuCardId: 'MC-STOREFRONT-LOCATION',
    blocksEstimation: false,
  },
  menuCardId: 'MC-STOREFRONT-LOCATION',
  riskFindings: [],
  complexityScore: 3,
} as unknown as SpecialistInput;

const ctx = (provider: IModelProvider) => ({
  modelProvider: provider,
  modelString: 'stub/model',
  instructions: { DEV: 'dev', QA: 'qa', PM: 'pm', BA: 'ba' },
});

describe('DEV line-item side tagging', () => {
  it('maps frontend / backend / both onto the two booleans', async () => {
    const provider = providerReturning({
      lineItems: [
        { description: 'Add company_location column + migration', hours: 2, complexity: 'base', side: 'backend' },
        { description: 'Location selector component', hours: 3, complexity: 'base', side: 'frontend' },
        { description: 'Inseparable end-to-end wiring', hours: 1.5, complexity: 'base', side: 'both' },
      ],
      assumptions: [],
    });

    const out = await runSpecialist('DEV', input, ctx(provider));

    expect(out.lineItems.map((l) => [l.touchesBackend, l.touchesFrontend])).toEqual([
      [true, false],
      [false, true],
      [true, true],
    ]);
  });

  it('leaves an untagged item as both-false, not as a guess', async () => {
    const provider = providerReturning({
      lineItems: [{ description: 'Something unlabelled', hours: 2, complexity: 'base' }],
      assumptions: [],
    });

    const out = await runSpecialist('DEV', input, ctx(provider));

    expect(out.lineItems[0]?.touchesFrontend).toBe(false);
    expect(out.lineItems[0]?.touchesBackend).toBe(false);
  });

  it('never divides the hours — the tag is a label, not a split', async () => {
    const provider = providerReturning({
      lineItems: [
        { description: 'Backend piece', hours: 3, complexity: 'base', side: 'backend' },
        { description: 'Full-stack piece', hours: 2, complexity: 'base', side: 'both' },
      ],
      assumptions: [],
    });

    const out = await runSpecialist('DEV', input, ctx(provider));

    // Each item keeps exactly the hours the model gave it. A 'both' item is
    // NOT halved — halving is a writeback concern, decided once, downstream.
    expect(out.lineItems.map((l) => l.hours)).toEqual([3, 2]);
    expect(out.lineItems.reduce((s, l) => s + l.hours, 0)).toBe(5);
  });

  it('carries the side onto every chunk when an oversized item is split', async () => {
    const provider = providerReturning({
      // 9h busts the 4h cap → splits into 3 chunks, all still backend.
      lineItems: [{ description: 'Large migration', hours: 9, complexity: 'high', side: 'backend' }],
      assumptions: [],
    });

    const out = await runSpecialist('DEV', input, ctx(provider));

    expect(out.lineItems.length).toBeGreaterThan(1);
    expect(out.lineItems.every((l) => l.touchesBackend && !l.touchesFrontend)).toBe(true);
    expect(out.lineItems.reduce((s, l) => s + l.hours, 0)).toBeCloseTo(9, 2);
  });

  it('does not tag QA/PM/BA work — it has no side', async () => {
    // Even if the model volunteers a side for a non-DEV role, it is ignored:
    // the prompt never offers the field and the data would be meaningless.
    const provider = providerReturning({
      lineItems: [{ description: 'Regression pass', hours: 2, complexity: 'base', side: 'frontend' }],
      assumptions: [],
    });

    const out = await runSpecialist('QA', input, ctx(provider));

    expect(out.lineItems[0]?.touchesFrontend).toBe(false);
    expect(out.lineItems[0]?.touchesBackend).toBe(false);
  });
});
