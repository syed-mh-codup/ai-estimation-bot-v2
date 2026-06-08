import { describe, it, expect } from 'vitest';
import { SAMPLE_SOWS } from '@repo/shared';
import type { Requirement, SampleSow } from '@repo/shared';
import { runComplexityScorecard, DEFAULT_COMPLEXITY_RULES } from './complexity';

/**
 * WS26-01: the sample SOW fixtures land in their expected deterministic
 * complexity bands. This exercises the complexity engine (LLM-free) on realistic
 * SOWs — no credits needed — and pins each fixture's expected range.
 */
function sowToRequirements(sowText: string): Requirement[] {
  return sowText
    .split(/(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ text, taxonomyKey: null, confidence: 1 }));
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
