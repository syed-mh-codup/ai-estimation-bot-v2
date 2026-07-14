import { describe, it, expect } from 'vitest';
import { SAMPLE_SOWS } from '@repo/shared';
import type { Requirement, SampleSow } from '@repo/shared';
import { runComplexityScorecard, DEFAULT_COMPLEXITY_RULES } from './complexity';

/**
 * WS26-01: the sample SOW fixtures land in their expected deterministic
 * complexity bands. This exercises the complexity engine (LLM-free) on realistic
 * SOWs — no credits needed — and pins each fixture's expected range.
 *
 * Stands in for the Librarian (which would normally assign integrationCount/
 * dataVolume per requirement): derives them heuristically per sentence so this
 * test still exercises the complexity engine's structured-signal path, not
 * just its text-keyword fallback.
 */
const INTEGRATION_KEYWORD = /\bapi\b|\bintegrat|\bwebhook|\bsdk\b|\bthird.party/gi;
const HIGH_VOLUME_KEYWORD = /millions of records|large dataset|big data|bulk import|data migration/i;

function sowToRequirements(sowText: string): Requirement[] {
  return sowText
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text, i) => ({
      id: `REQ-${String(i + 1).padStart(3, '0')}`,
      text,
      category: 'Dev Environment' as const,
      reqType: 'Infrastructure' as const,
      platforms: [],
      projectSize: 'Mid-market' as const,
      dataVolume: HIGH_VOLUME_KEYWORD.test(text) ? ('High' as const) : ('None' as const),
      integrationCount: (text.match(INTEGRATION_KEYWORD) ?? []).length,
      candidateMenuCardId: 'MC-TEST-FIXTURE',
      taxonomyKey: null,
      sourceRef: 'fixture',
      ambiguities: [],
      blocksEstimation: false,
    }));
}

describe('WS26-01: sample SOW fixtures hit expected complexity bands', () => {
  for (const sow of SAMPLE_SOWS) {
    it(`${sow.id} scores within [${sow.expectedComplexity.min}, ${sow.expectedComplexity.max}]`, () => {
      const requirements = sowToRequirements(sow.sowText);
      const { score } = runComplexityScorecard(requirements, [], DEFAULT_COMPLEXITY_RULES);
      expect(score).toBeGreaterThanOrEqual(sow.expectedComplexity.min);
      expect(score).toBeLessThanOrEqual(sow.expectedComplexity.max);
    });
  }

  it('integration-heavy scores strictly higher than simple', () => {
    const score = (id: string) => {
      const sow = SAMPLE_SOWS.find((s: SampleSow) => s.id === id)!;
      return runComplexityScorecard(sowToRequirements(sow.sowText), [], DEFAULT_COMPLEXITY_RULES).score;
    };
    expect(score('sow-integration')).toBeGreaterThan(score('sow-simple'));
  });
});
