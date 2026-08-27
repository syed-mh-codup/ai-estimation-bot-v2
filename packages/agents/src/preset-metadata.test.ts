import { describe, it, expect } from 'vitest';
import { ArchivistMatchSchema, type ArchivistMatch, type SpecialistOutput } from '@repo/shared';
import { collateAssumptions } from './architect';
import { presetEmbeddingText } from './writeback';

/**
 * Seven PresetVersion columns carried real workbook data on all 45 seeded
 * presets and were read by nothing: notes, userStoryTags, projectSizeFit,
 * blocks, canParallel, phase, spikeNeeded. AEH-228 flagged them; this pins the
 * consumers AEH-253 gave them, so a future refactor that quietly drops one
 * fails here rather than in the audit six weeks later.
 */

function match(over: Partial<ArchivistMatch> = {}): ArchivistMatch {
  return ArchivistMatchSchema.parse({
    requirementId: 'REQ-001',
    taxonomyKey: 'b2b.checkout',
    coverage: 'full',
    presetId: 'P17',
    presetVersion: 1,
    score: 0.9,
    adjustments: {
      projectSizeDelta: 'proven at Enterprise',
      dataVolume: 'Low',
      integrationCount: 1,
      aiAssist: 'Low',
      risk: 'Medium',
    },
    rationale: 'matches',
    sequencing: { requires: [], blocks: [], canParallel: true },
    ...over,
  });
}

function specialist(assumptions: string[]): SpecialistOutput {
  return {
    role: 'DEV',
    lineItems: [],
    assumptions,
    coversRiskFlags: [],
  };
}

describe('presetEmbeddingText — what a preset MEANS to the matcher', () => {
  const base = {
    name: 'B2B account dashboard',
    description: 'P21 order history and documents',
    keywords: ['b2b', 'dashboard'],
    notes: 'P21 order history API endpoint must be available and accessible.',
    userStoryTags: ['B2B buyer'],
  };

  it('carries the admin-typed notes into the embedded text', () => {
    expect(presetEmbeddingText(base)).toContain('P21 order history API endpoint');
  });

  it('carries the user story tags', () => {
    expect(presetEmbeddingText(base)).toContain('B2B buyer');
  });

  it('still leads with name and description, so the vector is not reshaped', () => {
    expect(presetEmbeddingText(base).startsWith('B2B account dashboard P21 order history')).toBe(true);
  });

  /**
   * `backfillPresetEmbeddings` decides staleness by comparing the stored
   * `embeddingText` against a freshly computed one, so widening this function
   * is what marks every existing row stale and gets it re-embedded. If notes
   * stopped contributing, that mechanism would silently stop noticing.
   */
  it('changes when only the notes change, so staleness is detectable', () => {
    const edited = { ...base, notes: 'Admin-level access required within 2 business days.' };
    expect(presetEmbeddingText(edited)).not.toBe(presetEmbeddingText(base));
  });

  it('is stable for an unchanged preset', () => {
    expect(presetEmbeddingText(base)).toBe(presetEmbeddingText({ ...base }));
  });
});

describe('collateAssumptions — the matched preset’s caveats reach the estimate', () => {
  it('folds preset caveats in alongside the council’s own assumptions', () => {
    const assumptions = collateAssumptions(
      [specialist(['Standard timeline assumed'])],
      [match({ presetCaveats: ['P17: formal external audit is excluded.'] })],
    );
    expect(assumptions).toContain('P17: formal external audit is excluded.');
    expect(assumptions).toContain('Standard timeline assumed');
  });

  it('deduplicates a caveat a specialist already stated', () => {
    const shared = 'P17: formal external audit is excluded.';
    const assumptions = collateAssumptions([specialist([shared])], [match({ presetCaveats: [shared] })]);
    expect(assumptions.filter((a) => a === shared)).toHaveLength(1);
  });

  it('drops blank caveats rather than emitting an empty bullet', () => {
    const assumptions = collateAssumptions([specialist([])], [match({ presetCaveats: ['', '   '] })]);
    expect(assumptions).toHaveLength(0);
  });

  it('stays backwards compatible when no matches are passed', () => {
    expect(collateAssumptions([specialist(['A'])])).toEqual(['A']);
  });

  it('keeps the sort stable across several matches', () => {
    const matches = [
      match({ presetCaveats: ['P17 blocks P18 — schedule it ahead of them.'] }),
      match({ requirementId: 'REQ-002', presetCaveats: ['P02 has historically needed a discovery spike.'] }),
    ];
    const once = collateAssumptions([specialist([])], matches);
    expect(once).toEqual(collateAssumptions([specialist([])], matches));
    expect(once).toEqual([...once].sort());
  });
});

describe('ArchivistMatch carries the preset’s delivery record', () => {
  it('defaults presetCaveats to empty rather than undefined', () => {
    expect(match().presetCaveats).toEqual([]);
  });

  it('accepts a phase prior in the menu-card vocabulary', () => {
    expect(match({ presetPhase: 'Foundation' }).presetPhase).toBe('Foundation');
  });

  it('rejects the DB casing, which would silently mislabel every card', () => {
    expect(() => match({ presetPhase: 'FOUNDATION' as never })).toThrow();
  });
});
