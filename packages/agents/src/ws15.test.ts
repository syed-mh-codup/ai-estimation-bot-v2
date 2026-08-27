import { describe, it, expect } from 'vitest';
import {
  detectHiddenWork,
  claimedRiskFlags,
  buildInjectedMenuItem,
  taxonomyKeyForRiskFlag,
} from './audit';
import {
  SpecialistOutputSchema,
  type RiskFinding,
  type SpecialistOutput,
} from '@repo/shared';

function risk(overrides: Partial<RiskFinding> & { riskFlags: string[] }): RiskFinding {
  return {
    id: 'RISK-001',
    requirementId: 'REQ-001',
    taxonomyKey: 'payments.api',
    claim: 'Stripe API has rate limits',
    citation: 'docs.stripe.com',
    spikeRecommended: false,
    ...overrides,
  };
}

/** Parsed through the schema so a new field with a default cannot be silently missed. */
function specialist(
  role: 'DEV' | 'QA' | 'PM' | 'BA',
  hours: number,
  coversRiskFlags: string[] = [],
): SpecialistOutput {
  return SpecialistOutputSchema.parse({
    role,
    coversRiskFlags,
    assumptions: [],
    lineItems: [
      {
        id: `${role}-REQ001-01`,
        requirementId: 'REQ-001',
        menuCardId: 'MC-INFRA-RATE',
        description: `${role} work`,
        hours,
        complexity: 'base',
      },
    ],
  });
}

// ─── WS15-01: detection ──────────────────────────────────────────────────────

describe('WS15-01: Hidden-Work Audit — detection', () => {
  it('reports a known flag no specialist claimed', () => {
    const found = detectHiddenWork([risk({ riskFlags: ['rate-limits'] })], []);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      riskFlag: 'rate-limits',
      known: true,
      taxonomyKey: 'infra.rate-limit',
      claim: 'Stripe API has rate limits',
      citation: 'docs.stripe.com',
    });
  });

  it('stays silent when a specialist claimed the flag', () => {
    const found = detectHiddenWork([risk({ riskFlags: ['rate-limits'] })], ['rate-limits']);
    expect(found).toEqual([]);
  });

  /**
   * The regression this whole ticket exists for. The old branch read
   * `if (!config) return true; // unknown flag = not our concern`, so any flag
   * outside the table was treated as already handled and disappeared. The
   * Detective's own prompt teaches it to invent flags, so that was the common
   * case, not the edge case.
   */
  it('surfaces an off-list flag instead of silently dropping it', () => {
    const found = detectHiddenWork([risk({ riskFlags: ['soc2-audit'] })], []);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ riskFlag: 'soc2-audit', known: false, taxonomyKey: null });
  });

  it('deduplicates a flag raised by two requirements, keeping the first argument for it', () => {
    const found = detectHiddenWork(
      [
        risk({ riskFlags: ['retries'], claim: 'first claim' }),
        risk({ id: 'RISK-002', requirementId: 'REQ-002', riskFlags: ['retries'], claim: 'second claim' }),
      ],
      [],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.claim).toBe('first claim');
  });

  it('every known flag resolves to a seeded taxonomy key', () => {
    // api-quota is the one the prompt taught for months with no mapping at all.
    expect(taxonomyKeyForRiskFlag('api-quota')).toBe('infra.api-quota');
    expect(taxonomyKeyForRiskFlag('webhook-reliability')).toBe('infra.webhook');
    expect(taxonomyKeyForRiskFlag('soc2-audit')).toBeNull();
  });
});

// ─── WS15-02: claims ─────────────────────────────────────────────────────────

describe('WS15-02: coverage is a claim, not a string match', () => {
  it('unions what every role claimed', () => {
    const claimed = claimedRiskFlags([
      specialist('DEV', 3, ['rate-limits']),
      specialist('QA', 1, ['retries']),
      specialist('PM', 1),
    ]);
    expect([...claimed].sort()).toEqual(['rate-limits', 'retries']);
  });

  it('claiming nothing is the default, so an unclaimed risk still surfaces', () => {
    const outputs = [specialist('DEV', 3)];
    const found = detectHiddenWork([risk({ riskFlags: ['rate-limits'] })], claimedRiskFlags(outputs));
    expect(found).toHaveLength(1);
  });
});

// ─── WS15-03: costed cards carry the council's hours ─────────────────────────

describe('WS15-03: injected cards are costed, never fabricated', () => {
  const detection = {
    riskFlag: 'rate-limits',
    known: true,
    title: 'Rate Limit Management & Throttling',
    taxonomyKey: 'infra.rate-limit',
    claim: 'Stripe API has rate limits',
    citation: 'docs.stripe.com',
    requirementId: 'REQ-001',
  };

  it('builds a card from the council hours and marks it injected', () => {
    const card = buildInjectedMenuItem(detection, [
      specialist('DEV', 3.5),
      specialist('QA', 1.25),
    ]);
    expect(card).not.toBeNull();
    expect(card?.injected).toBe(true);
    expect(card?.taxonomyKey).toBe('infra.rate-limit');
    expect(card?.requirementIds).toEqual(['REQ-001']);
    expect(card?.lineItems.map((li) => li.baseHours)).toEqual([3.5, 1.25]);
  });

  /**
   * Teeth for the decision that placeholders are gone. The deleted default was
   * DEV 8 / QA 4 / PM 2 / BA 2 regardless of project size — if any of those
   * numbers can reappear from a table rather than the council, this fails.
   */
  it('carries no default hours of its own', () => {
    const card = buildInjectedMenuItem(detection, [specialist('DEV', 3.5)]);
    expect(card?.lineItems).toHaveLength(1);
    expect(card?.lineItems[0]?.baseHours).toBe(3.5);
  });

  it('returns null when the council produced nothing, so the caller records a question', () => {
    expect(buildInjectedMenuItem(detection, [])).toBeNull();
  });

  it('returns null for an off-list flag — there is nowhere to put the work', () => {
    const card = buildInjectedMenuItem(
      { ...detection, riskFlag: 'soc2-audit', known: false, title: null, taxonomyKey: null },
      [specialist('DEV', 3.5)],
    );
    expect(card).toBeNull();
  });
});
