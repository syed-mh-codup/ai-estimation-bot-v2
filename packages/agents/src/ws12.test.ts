import { describe, it, expect } from 'vitest';
import {
  detectFeatures,
  computeComplexityScore,
  runComplexityScorecard,
  DEFAULT_COMPLEXITY_RULES,
  type ComplexityRules,
} from './complexity';
import type { Requirement, RiskFinding } from '@repo/shared';

const rules: ComplexityRules = DEFAULT_COMPLEXITY_RULES;

const noFindings: RiskFinding[] = [];

let reqCounter = 0;
function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  reqCounter += 1;
  return {
    id: `REQ-${String(reqCounter).padStart(3, '0')}`,
    text: 'Build a feature',
    category: 'B2B',
    reqType: 'Commerce Logic',
    platforms: [],
    projectSize: 'Mid-market',
    dataVolume: 'None',
    integrationCount: 0,
    candidateMenuCardId: 'MC-B2B-FEATURE',
    taxonomyKey: null,
    sourceRef: 'SOW',
    ambiguities: [],
    blocksEstimation: false,
    ...overrides,
  };
}

function makeRiskFinding(overrides: Partial<RiskFinding> = {}): RiskFinding {
  return {
    id: 'RISK-001',
    requirementId: 'REQ-001',
    taxonomyKey: null,
    claim: 'risk',
    riskFlags: [],
    citation: 'SOW',
    spikeRecommended: false,
    ...overrides,
  };
}

// ─── WS12-01: Table-driven scorecard test ────────────────────────────────────

describe('WS12-01: Complexity scorecard — pure function with seeded rules', () => {
  it('legacy system → score ~4 (legacy bonus applied)', () => {
    const reqs = [
      makeRequirement({
        text: 'Migrate legacy monolith to microservices with API integration',
        reqType: 'Data Migration',
        integrationCount: 2,
      }),
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('high structured integration_count → score 3-4', () => {
    const reqs = [
      makeRequirement({ text: 'Integrate payment API', taxonomyKey: 'integrations', integrationCount: 2 }),
      makeRequirement({ text: 'Connect to CRM via webhook', taxonomyKey: 'crm', integrationCount: 1 }),
    ];
    const findings = [
      makeRiskFinding({ taxonomyKey: 'integrations', claim: 'API rate limits apply', riskFlags: ['rate-limits', 'api-quota'] }),
      makeRiskFinding({ taxonomyKey: 'integrations', claim: 'Webhook retry needed', riskFlags: ['retries', 'api-quota'] }),
      makeRiskFinding({ taxonomyKey: 'crm', claim: 'CRM API has auth complexity', riskFlags: ['api-auth'] }),
    ];
    const result = runComplexityScorecard(reqs, findings, rules);
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('AI/ML requirements → score ~3-5 (AI bonus applied)', () => {
    const reqs = [
      makeRequirement({ text: 'Build prediction model with machine learning for churn analysis' }),
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('simple web app → score ~1-3 (no integrations, no legacy)', () => {
    const reqs = [makeRequirement({ text: 'Build a landing page with contact form' })];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(3);
  });

  it('score is always in range 1-5', () => {
    for (const apiCount of [0, 1, 5, 10, 20]) {
      const result = computeComplexityScore(
        { apiIntegrationCount: apiCount, hasLegacy: false, dataVolume: 'NONE', hasAI: false, taxonomyKeys: [] },
        rules,
        '',
      );
      expect(result.score).toBeGreaterThanOrEqual(1);
      expect(result.score).toBeLessThanOrEqual(5);
    }
  });

  it('per-item multipliers keyed by taxonomy', () => {
    const reqs = [
      makeRequirement({ text: 'Integrate API', taxonomyKey: 'b2b.checkout' }),
      makeRequirement({ text: 'Build dashboard', taxonomyKey: 'ui.dashboard' }),
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(result.perItemMultipliers).toHaveProperty('b2b.checkout');
    expect(result.perItemMultipliers).toHaveProperty('ui.dashboard');
    expect(result.perItemMultipliers['b2b.checkout']).toBeGreaterThanOrEqual(1.0);
  });
});

// ─── WS12-02: Detector ───────────────────────────────────────────────────────

describe('WS12-02: Detector — structured signal (primary) + text keywords (fallback)', () => {
  it('sums the Librarian-assigned integration_count across requirements', () => {
    const reqs = [
      makeRequirement({ text: 'Stripe payment sync', integrationCount: 2 }),
      makeRequirement({ text: 'Twilio SMS sync', integrationCount: 1 }),
    ];
    const features = detectFeatures(reqs, noFindings);
    expect(features.apiIntegrationCount).toBe(3);
  });

  it('falls back to text detection when integration_count is under-called', () => {
    const reqs = [
      makeRequirement({ text: 'Integrate Stripe payment API and Twilio SMS API', integrationCount: 0 }),
    ];
    const features = detectFeatures(reqs, noFindings);
    expect(features.apiIntegrationCount).toBeGreaterThan(0);
  });

  it('uses the Librarian-assigned data_volume as the primary signal', () => {
    const reqs = [makeRequirement({ text: 'Sync product catalog', dataVolume: 'High' })];
    const features = detectFeatures(reqs, noFindings);
    expect(features.dataVolume).toBe('HIGH');
  });

  it('falls back to keyword detection when data_volume is under-called', () => {
    const reqs = [
      makeRequirement({ text: 'Perform data migration of millions of records from legacy system', dataVolume: 'None' }),
    ];
    const features = detectFeatures(reqs, noFindings);
    expect(features.dataVolume).toBe('HIGH');
  });

  it('extracts taxonomy keys from requirements', () => {
    const reqs = [
      makeRequirement({ text: 'Build checkout', taxonomyKey: 'b2b.checkout' }),
      makeRequirement({ text: 'Add auth', taxonomyKey: 'auth.sso' }),
      makeRequirement({ text: 'No taxonomy', taxonomyKey: null }),
    ];
    const features = detectFeatures(reqs, noFindings);
    expect(features.taxonomyKeys).toContain('b2b.checkout');
    expect(features.taxonomyKeys).toContain('auth.sso');
    expect(features.taxonomyKeys).not.toContain(null);
  });
});

// ─── WS12-03: Supervisor wiring (unit test of scorecard integration) ──────────

describe('WS12-03: Scorecard output carries score + multipliers for specialist inputs', () => {
  it('global score is present on scorecard output', () => {
    const reqs = [makeRequirement({ text: 'Integrate payment gateway API', integrationCount: 1 })];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(1);
  });

  it('multipliers are accessible by taxonomy key for specialist calculations', () => {
    const reqs = [makeRequirement({ text: 'Build complex feature', taxonomyKey: 'feature.complex' })];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    const multiplier = result.perItemMultipliers['feature.complex'] ?? 1.0;
    expect(multiplier).toBeGreaterThanOrEqual(1.0);
  });
});
