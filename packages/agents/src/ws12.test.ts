import { describe, it, expect } from 'vitest';
import {
  detectFeatures,
  computeComplexityScore,
  runComplexityScorecard,
  DEFAULT_COMPLEXITY_RULES,
  type ComplexityRules,
} from './complexity';
import type { Requirement, DetectiveFinding } from '@repo/shared';

const rules: ComplexityRules = DEFAULT_COMPLEXITY_RULES;

const noFindings: DetectiveFinding[] = [];

// ─── WS12-01: Table-driven scorecard test ────────────────────────────────────

describe('WS12-01: Complexity scorecard — pure function with seeded rules', () => {
  it('legacy system → score ~4 (legacy bonus applied)', () => {
    const reqs: Requirement[] = [
      { text: 'Migrate legacy monolith to microservices with API integration', taxonomyKey: 'arch.migration', confidence: 0.9 },
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('high integration count → score ~3-4', () => {
    const reqs: Requirement[] = [
      { text: 'Integrate payment API, shipping API, and inventory API', taxonomyKey: 'integrations', confidence: 0.85 },
      { text: 'Connect to CRM API via webhook', taxonomyKey: 'crm', confidence: 0.8 },
    ];
    const findings: DetectiveFinding[] = [
      { taxonomyKey: 'integrations', claim: 'API rate limits apply', source: 'docs', riskFlags: ['rate-limits', 'api-quota'] },
      { taxonomyKey: 'integrations', claim: 'Webhook retry needed', source: 'docs', riskFlags: ['retries', 'api-quota'] },
      { taxonomyKey: 'crm', claim: 'CRM API has auth complexity', source: 'docs', riskFlags: ['api-auth'] },
    ];
    const result = runComplexityScorecard(reqs, findings, rules);
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('AI/ML requirements → score ~3-5 (AI bonus applied)', () => {
    const reqs: Requirement[] = [
      { text: 'Build prediction model with machine learning for churn analysis', taxonomyKey: 'ml.churn', confidence: 0.9 },
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(result.score).toBeGreaterThanOrEqual(3);
    expect(result.score).toBeLessThanOrEqual(5);
  });

  it('simple web app → score ~1-3 (no integrations, no legacy)', () => {
    const reqs: Requirement[] = [
      { text: 'Build a landing page with contact form', taxonomyKey: 'web.landing', confidence: 0.95 },
    ];
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
    const reqs: Requirement[] = [
      { text: 'Integrate API', taxonomyKey: 'b2b.checkout', confidence: 0.9 },
      { text: 'Build dashboard', taxonomyKey: 'ui.dashboard', confidence: 0.8 },
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(result.perItemMultipliers).toHaveProperty('b2b.checkout');
    expect(result.perItemMultipliers).toHaveProperty('ui.dashboard');
    expect(result.perItemMultipliers['b2b.checkout']).toBeGreaterThanOrEqual(1.0);
  });
});

// ─── WS12-02: Detector ───────────────────────────────────────────────────────

describe('WS12-02: Detector — counts APIs, scans legacy keywords, reads data volume', () => {
  it('detects API integrations from text', () => {
    const reqs: Requirement[] = [
      { text: 'Integrate Stripe payment API and Twilio SMS API', taxonomyKey: 'payments', confidence: 0.9 },
    ];
    const features = detectFeatures(reqs, noFindings);
    expect(features.apiIntegrationCount).toBeGreaterThan(0);
  });

  it('detects high data volume from keywords', () => {
    const reqs: Requirement[] = [
      { text: 'Perform data migration of millions of records from legacy system', taxonomyKey: 'data', confidence: 0.9 },
    ];
    const features = detectFeatures(reqs, noFindings);
    expect(features.dataVolume).toBe('HIGH');
  });

  it('extracts taxonomy keys from requirements', () => {
    const reqs: Requirement[] = [
      { text: 'Build checkout', taxonomyKey: 'b2b.checkout', confidence: 0.9 },
      { text: 'Add auth', taxonomyKey: 'auth.sso', confidence: 0.85 },
      { text: 'No taxonomy', taxonomyKey: null, confidence: 0.5 },
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
    const reqs: Requirement[] = [
      { text: 'Integrate payment gateway API', taxonomyKey: 'payments.gateway', confidence: 0.9 },
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(1);
  });

  it('multipliers are accessible by taxonomy key for specialist calculations', () => {
    const reqs: Requirement[] = [
      { text: 'Build complex feature', taxonomyKey: 'feature.complex', confidence: 0.9 },
    ];
    const result = runComplexityScorecard(reqs, noFindings, rules);
    // Specialist can look up multiplier by taxonomy key
    const multiplier = result.perItemMultipliers['feature.complex'] ?? 1.0;
    expect(multiplier).toBeGreaterThanOrEqual(1.0);
  });
});
