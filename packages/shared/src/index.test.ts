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
} from './schemas.js';

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

  it('LibrarianInput/Output', () => {
    LibrarianInputSchema.parse({ sowText: 'test' });
    const o = LibrarianOutputSchema.parse({
      requirements: [{ text: 'checkout', taxonomyKey: 'b2b.checkout', confidence: 0.9 }],
    });
    expect(o.requirements).toHaveLength(1);
  });

  it('DetectiveInput/Output', () => {
    DetectiveInputSchema.parse({
      requirements: [],
      enabledMcpTools: [],
      searchTool: 'tavily',
    });
    const o = DetectiveOutputSchema.parse({
      findings: [
        {
          taxonomyKey: 'b2b.checkout',
          claim: 'rate limit: 100/min',
          source: 'https://example.com',
          riskFlags: ['rate-limit'],
        },
      ],
    });
    expect(o.findings[0]?.riskFlags).toContain('rate-limit');
  });

  it('ArchivistInput/Output', () => {
    ArchivistInputSchema.parse({ requirements: [] });
    const o = ArchivistOutputSchema.parse({
      matches: [
        {
          taxonomyKey: 'b2b.checkout',
          presetId: 'P01',
          presetVersion: 1,
          score: 0.85,
          beHours: 40,
          feHours: 20,
          risk: 'MEDIUM',
          aiAssist: 'LOW',
        },
      ],
    });
    expect(o.matches[0]?.score).toBe(0.85);
  });

  it('SpecialistInput/Output', () => {
    SpecialistInputSchema.parse({
      menuItem: { id: 'm1', taxonomyKey: 'b2b.checkout', title: 'B2B Checkout' },
      detectiveFindings: [],
      complexityScore: 3,
    });
    const o = SpecialistOutputSchema.parse({
      role: 'DEV',
      baseHours: 80,
      rationale: 'Anchored on preset P01',
      assumptions: ['Shopify Plus tier'],
    });
    expect(o.role).toBe('DEV');
  });

  it('ComplexityInput/Output', () => {
    ComplexityInputSchema.parse({ requirements: [], detectiveFindings: [] });
    const o = ComplexityOutputSchema.parse({
      score: 3,
      perItemMultipliers: { 'b2b.checkout': 1.2 },
    });
    expect(o.score).toBe(3);
  });

  it('ArchitectOutput', () => {
    const o = ArchitectOutputSchema.parse({
      narrative: ['We will implement B2B checkout using Shopify Functions'],
      assumptions: ['Shopify Plus tier'],
      menuItems: [
        {
          id: 'm1',
          taxonomyKey: 'b2b.checkout',
          title: 'B2B Checkout',
          enabled: true,
          lineItems: [
            { role: 'DEV', baseHours: 80, taxedHours: 88, edited: false },
            { role: 'QA', baseHours: 20, taxedHours: 24, edited: false },
            { role: 'PM', baseHours: 8, taxedHours: 9, edited: false },
            { role: 'BA', baseHours: 6, taxedHours: 7, edited: false },
          ],
        },
      ],
    });
    expect(o.menuItems).toHaveLength(1);
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
