import { describe, expect, it, vi } from 'vitest';

import type { ChatResult, IModelProvider } from '@repo/providers';
import type { SpecialistInput } from '@repo/shared';

import { runSpecialist } from './specialist';

/**
 * The specialist's user message, byte for byte on an ordinary run. AEH-238.
 *
 * `buildRevisionBlocks` asserts in its own docstring that a plain run's message
 * is byte-identical to what it was before steering existed, and gives the
 * reason: the prompts are admin-authored and versioned, so a run whose message
 * silently changed would re-price differently for no recorded reason.
 *
 * Nothing checked that, and the gap is how a code review came to report the
 * seam as broken and how I came to "fix" it and briefly make it worse: the
 * template interpolates on its own line, so the newline after the insertion
 * point is already there, and returning '' is right where returning a newline
 * adds a third. The claim was correct all along; the evidence for it did not
 * exist.
 *
 * So this file pins the SHAPE from both sides — one blank line before the JSON
 * contract and not two — because an assertion for only the presence of a blank
 * line passes whatever the function returns.
 */

function capturingProvider(): { provider: IModelProvider; messageSent: () => string } {
  const chat = vi.fn().mockResolvedValue({
    text: JSON.stringify({
      lineItems: [{ description: 'a unit of work', hours: 2, complexity: 'base' }],
      assumptions: [],
    }),
    model: 'stub/model',
    usage: null,
  } satisfies ChatResult);

  return {
    provider: {
      chat,
      chatStream: async function* () {
        yield { type: 'done' as const, usage: null, model: 'stub/model' };
      },
      embed: vi.fn(),
    } as unknown as IModelProvider,
    messageSent: () => String(chat.mock.calls[0]?.[0]?.messages?.[1]?.content ?? ''),
  };
}

const BASE = {
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
  recorder: { record: vi.fn() },
});

describe('the specialist user message on an ordinary run', () => {
  it('keeps a BLANK LINE before "Respond with JSON only"', async () => {
    const { provider, messageSent } = capturingProvider();
    await runSpecialist('DEV', BASE, ctx(provider) as never);

    // BOTH halves, because either one alone passes whatever the function
    // returns and pins nothing. The template already carries the newline after
    // the interpolation, so '' gives exactly one blank line here and '\n'
    // gives two — and two is the drift, not one.
    const sent = messageSent();
    expect(sent).toContain('\n\nRespond with JSON only');
    expect(sent).not.toContain('\n\n\nRespond with JSON only');
  });

  it('carries no revision section at all', async () => {
    const { provider, messageSent } = capturingProvider();
    await runSpecialist('DEV', BASE, ctx(provider) as never);
    const sent = messageSent();

    // A run that gained empty headings would re-price differently for no
    // recorded reason — the failure the docstring is about. Asserted against
    // the real block openings rather than invented headings, so this fails if
    // a block starts leaking into plain runs.
    expect(sent).not.toContain('The rest of this estimate, for context');
    expect(sent).not.toContain("The estimator's instruction");
  });
});

describe('the specialist user message inside a steered edit', () => {
  it('inserts the blocks at the same seam, still ahead of the JSON contract', async () => {
    const { provider, messageSent } = capturingProvider();
    await runSpecialist(
      'DEV',
      {
        ...BASE,
        steer: 'the hours are too heavy, re-think the work',
        existing: [{ description: 'location selector', hours: 6, provenance: 'CREW' }],
        ledgerContext: '- Reporting — DEV 40h',
      } as unknown as SpecialistInput,
      ctx(provider) as never,
    );
    const sent = messageSent();

    expect(sent).toContain('the hours are too heavy, re-think the work');
    expect(sent).toContain('location selector');
    expect(sent).toContain('Reporting');
    // Still last, because the JSON contract has to be the final instruction
    // whatever precedes it.
    expect(sent.indexOf('the hours are too heavy')).toBeLessThan(
      sent.indexOf('Respond with JSON only'),
    );
  });
});
