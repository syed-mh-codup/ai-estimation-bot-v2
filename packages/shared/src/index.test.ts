import { describe, it, expect } from 'vitest';
import {
  SupervisorInputSchema,
  SupervisorOutputSchema,
  LibrarianInputSchema,
  LibrarianOutputSchema,
  DetectiveInputSchema,
  DetectiveOutputSchema,
  ArchivistInputSchema,
  ArchivistOutputSchema,
  SpecialistInputSchema,
  SpecialistOutputSchema,
  ComplexityInputSchema,
  ComplexityOutputSchema,
  ArchitectOutputSchema,
  ValidationAuditOutputSchema,
  SearchResultSchema,
  RequirementSchema,
} from './schemas.js';

const sampleRequirement = {
  id: 'REQ-001',
  text: 'B2B contextual pricing tiers',
  category: 'B2B' as const,
  reqType: 'Pricing' as const,
  platforms: ['Shopify' as const],
  projectSize: 'Mid-market' as const,
  dataVolume: 'Low' as const,
  integrationCount: 1,
  candidateMenuCardId: 'MC-B2B-PRICING',
  taxonomyKey: 'b2b.checkout',
  sourceRef: 'SOW section 2.1',
  ambiguities: [],
  blocksEstimation: false,
};

describe('shared schemas — round-trip parse', () => {
  it('SupervisorInput', () => {
    const v = SupervisorInputSchema.parse({
      estimateId: 'e1',
      sowText: 'build a store',
      mode: 'full',
    });
    expect(v.mode).toBe('full');
  });

  it('SupervisorOutput', () => {
    const v = SupervisorOutputSchema.parse({ estimateId: 'e1', status: 'DRAFT' });
    expect(v.status).toBe('DRAFT');
  });

  it('Requirement', () => {
    const r = RequirementSchema.parse(sampleRequirement);
    expect(r.candidateMenuCardId).toBe('MC-B2B-PRICING');
  });

  it('LibrarianInput/Output', () => {
    LibrarianInputSchema.parse({ sowText: 'test' });
    const o = LibrarianOutputSchema.parse({ requirements: [sampleRequirement] });
    expect(o.requirements).toHaveLength(1);
  });

  it('DetectiveInput/Output', () => {
    DetectiveInputSchema.parse({
      requirements: [],
      enabledMcpTools: [],
      searchTool: 'tavily',
    });
    const o = DetectiveOutputSchema.parse({
      risks: [
        {
          id: 'RISK-001',
          requirementId: 'REQ-001',
          taxonomyKey: 'b2b.checkout',
          claim: 'P21 rate limit: 100/min',
          riskFlags: ['rate-limit'],
          citation: 'SOW section 2.1',
        },
      ],
      questions: [
        {
          id: 'Q-001',
          requirementId: 'REQ-001',
          question: 'Is P21 exposing a pricing endpoint?',
          blocksEstimation: true,
        },
      ],
    });
    expect(o.risks[0]?.riskFlags).toContain('rate-limit');
    expect(o.questions[0]?.blocksEstimation).toBe(true);
  });

  it('ArchivistInput/Output', () => {
    ArchivistInputSchema.parse({ requirements: [] });
    const o = ArchivistOutputSchema.parse({
      matches: [
        {
          requirementId: 'REQ-001',
          taxonomyKey: 'b2b.checkout',
          coverage: 'full',
          presetId: 'P01',
          presetVersion: 1,
          score: 0.85,
          beHours: 40,
          feHours: 20,
          adjustments: {
            projectSizeDelta: 'fits Mid-market',
            dataVolume: 'Low',
            integrationCount: 1,
            aiAssist: 'Medium',
            risk: 'Medium',
          },
          rationale: 'matches B2B contextual pricing via @inContext',
        },
      ],
    });
    expect(o.matches[0]?.score).toBe(0.85);
    expect(o.matches[0]?.sequencing.canParallel).toBe(true);
  });

  it('SpecialistInput/Output', () => {
    SpecialistInputSchema.parse({
      requirement: sampleRequirement,
      menuCardId: 'MC-B2B-PRICING',
      riskFindings: [],
      complexityScore: 3,
    });
    const o = SpecialistOutputSchema.parse({
      role: 'DEV',
      lineItems: [
        {
          id: 'DEV-REQ001-01',
          requirementId: 'REQ-001',
          menuCardId: 'MC-B2B-PRICING',
          description: 'Schema changes for volume tiers',
          hours: 3.5,
          complexity: 'elevated',
        },
      ],
      assumptions: ['Shopify Plus tier'],
    });
    expect(o.role).toBe('DEV');
    expect(o.lineItems[0]?.hours).toBeLessThanOrEqual(4);
  });

  it('SpecialistLineItem rejects hours over the four-hour cap', () => {
    const o = SpecialistOutputSchema.safeParse({
      role: 'DEV',
      lineItems: [
        {
          id: 'DEV-REQ001-01',
          requirementId: 'REQ-001',
          menuCardId: 'MC-B2B-PRICING',
          description: 'Too big',
          hours: 6,
          complexity: 'base',
        },
      ],
    });
    expect(o.success).toBe(false);
  });

  it('ComplexityInput/Output', () => {
    ComplexityInputSchema.parse({ requirements: [sampleRequirement], riskFindings: [] });
    const o = ComplexityOutputSchema.parse({
      score: 3,
      perItemMultipliers: { 'b2b.checkout': 1.2 },
    });
    expect(o.score).toBe(3);
  });

  it('ArchitectOutput', () => {
    const o = ArchitectOutputSchema.parse({
      narrative: ['We will implement B2B checkout using Shopify Functions.'],
      assumptions: ['Shopify Plus tier'],
      menuItems: [
        {
          id: 'MC-B2B-PRICING',
          taxonomyKey: 'b2b.checkout',
          title: 'B2B Pricing',
          enabled: true,
          lineItems: [
            { role: 'DEV', baseHours: 3.5, taxedHours: 3.5, edited: false },
            { role: 'DEV', baseHours: 2, taxedHours: 2, edited: false },
            { role: 'QA', baseHours: 2, taxedHours: 2.4, edited: false },
            { role: 'PM', baseHours: 1, taxedHours: 1.1, edited: false },
            { role: 'BA', baseHours: 1, taxedHours: 1.2, edited: false },
          ],
        },
      ],
    });
    expect(o.menuItems).toHaveLength(1);
    expect(o.menuItems[0]?.lineItems).toHaveLength(5);
  });

  it('ValidationAuditOutput', () => {
    const v = ValidationAuditOutputSchema.parse({
      passed: false,
      unreconciled: [{ riskFlag: 'rate-limit', taxonomyKey: 'b2b.checkout', reason: 'no buffer' }],
    });
    expect(v.passed).toBe(false);
  });

  it('SearchResult', () => {
    const r = SearchResultSchema.parse({
      title: 'Shopify API docs',
      url: 'https://shopify.dev',
      snippet: 'Rate limit: 2/s',
    });
    expect(r.title).toBeTruthy();
  });
});
