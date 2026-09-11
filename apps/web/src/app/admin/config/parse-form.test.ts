import { describe, it, expect } from 'vitest';
import { parseConfigForm } from './parse-form';

/**
 * AEH-348: reading the config form back out of a FormData.
 *
 * The two rule lists reach the server as one flat sequence per column, so a row
 * is a position agreed on by six independent lists. Nothing throws when that
 * agreement breaks — the save just writes an overhead card that charges the
 * wrong role, or a complexity band with somebody else's score. These are the
 * ways it can break.
 */

/** The scalar half of a valid submission, so each test can vary one thing. */
function baseFields(): [string, string][] {
  return [
    ['pmCommunicationTaxPct', '15'],
    ['baCommunicationTaxPct', '10'],
    ['qaRegressionBufferPct', '20'],
    ['legacyScoreBonus', '1.5'],
    ['aiScoreBonus', '1.3'],
    ['dataVolumeMultiplierNone', '1'],
    ['dataVolumeMultiplierLow', '1.1'],
    ['dataVolumeMultiplierHigh', '1.5'],
    ['changeReason', 'because the QA buffer was under-calling regression'],
    ['changeMotivation', 'CORRECTION'],
  ];
}

function formOf(pairs: [string, string][]): FormData {
  const fd = new FormData();
  for (const [k, v] of pairs) fd.append(k, v);
  return fd;
}

/** One overhead row, appended column by column exactly as the markup renders it. */
function overheadRow(
  title: string,
  key: string,
  pcts: { dev?: string; qa?: string; pm?: string; ba?: string } = {},
): [string, string][] {
  return [
    ['overheadTitle', title],
    ['overheadKey', key],
    ['overheadDevPct', pcts.dev ?? ''],
    ['overheadQaPct', pcts.qa ?? ''],
    ['overheadPmPct', pcts.pm ?? ''],
    ['overheadBaPct', pcts.ba ?? ''],
  ];
}

function thresholdRow(min: string, max: string, score: string): [string, string][] {
  return [
    ['thresholdMin', min],
    ['thresholdMax', max],
    ['thresholdScore', score],
  ];
}

describe('parseConfigForm', () => {
  it('accepts a submission with no rule rows at all', () => {
    // What e2e's global setup seeds, and a legitimate state: no bands, no
    // overhead. It must not be mistaken for a malformed submission.
    const parsed = parseConfigForm(formOf(baseFields()));
    expect(parsed).not.toBeNull();
    expect(parsed!.apiThresholds).toEqual([]);
    expect(parsed!.overheadItems).toEqual([]);
    expect(parsed!.legacyKeywords).toEqual([]);
  });

  it('keeps each row together and numbers positions in document order', () => {
    const parsed = parseConfigForm(
      formOf([
        ...baseFields(),
        ...thresholdRow('0', '1', '1'),
        ...thresholdRow('2', '3', '3'),
        ...thresholdRow('4', '999', '5'),
      ]),
    );
    expect(parsed!.apiThresholds).toEqual([
      { position: 0, minCount: 0, maxCount: 1, score: 1 },
      { position: 1, minCount: 2, maxCount: 3, score: 3 },
      { position: 2, minCount: 4, maxCount: 999, score: 5 },
    ]);
  });

  it('reassembles overhead rows column by column without crossing them', () => {
    const parsed = parseConfigForm(
      formOf([
        ...baseFields(),
        ...overheadRow('Code Review', 'process.code-review', { dev: '8' }),
        ...overheadRow('Manual E2E', 'process.manual-e2e', { qa: '15' }),
        ...overheadRow('Meetings', 'process.meetings', { dev: '5', qa: '5' }),
      ]),
    );
    expect(parsed!.overheadItems).toEqual([
      {
        position: 0,
        title: 'Code Review',
        taxonomyKey: 'process.code-review',
        devPct: 8,
        qaPct: null,
        pmPct: null,
        baPct: null,
      },
      {
        position: 1,
        title: 'Manual E2E',
        taxonomyKey: 'process.manual-e2e',
        devPct: null,
        qaPct: 15,
        pmPct: null,
        baPct: null,
      },
      {
        position: 2,
        title: 'Meetings',
        taxonomyKey: 'process.meetings',
        devPct: 5,
        qaPct: 5,
        pmPct: null,
        baPct: null,
      },
    ]);
  });

  it('keeps a blank percentage distinct from a zero one', () => {
    // The whole reason the empty string is checked before coercion: `Number('')`
    // is 0, so a blank box run through Number() would turn "charge QA nothing"
    // into "charge QA zero percent", which is a card on a client's estimate for
    // no hours rather than no card at all.
    const parsed = parseConfigForm(
      formOf([...baseFields(), ...overheadRow('Mixed', 'process.meetings', { dev: '0', qa: '' })]),
    );
    expect(parsed!.overheadItems[0]!.devPct).toBe(0);
    expect(parsed!.overheadItems[0]!.qaPct).toBeNull();
  });

  it('renumbers positions after a removed row rather than leaving a hole', () => {
    // Removing the middle row unmounts its inputs, so the server sees two rows
    // and must call them 0 and 1 — a gap at position 1 would break the unique
    // (configId, position) constraint on the next save.
    const parsed = parseConfigForm(
      formOf([
        ...baseFields(),
        ...overheadRow('First', 'process.code-review', { dev: '8' }),
        ...overheadRow('Third', 'process.meetings', { pm: '3' }),
      ]),
    );
    expect(parsed!.overheadItems.map((i) => i.position)).toEqual([0, 1]);
    expect(parsed!.overheadItems.map((i) => i.title)).toEqual(['First', 'Third']);
  });

  it('refuses a submission whose row columns do not line up', () => {
    // The failure this function exists to catch. A title with no matching key
    // column would otherwise zip against the NEXT row's key and file an overhead
    // card under a taxonomy node that has nothing to do with it.
    const fd = formOf([
      ...baseFields(),
      ...overheadRow('Code Review', 'process.code-review', { dev: '8' }),
    ]);
    fd.append('overheadTitle', 'Orphaned title with no other columns');
    expect(parseConfigForm(fd)).toBeNull();
  });

  it('refuses a threshold row that is missing its score', () => {
    // Not pedantry. `Number('')` is 0, so a blank box read with the obvious
    // one-liner saves a score of 0 — and ApiThresholdSchema (min 1) then THROWS
    // inside computeComplexityScore, failing the next estimate run rather than
    // this save. A blank required number has to be NaN here.
    const fd = formOf([...baseFields(), ...thresholdRow('0', '1', '')]);
    expect(parseConfigForm(fd)).toBeNull();
  });

  it('refuses a score outside the 1-5 the engine will parse', () => {
    expect(parseConfigForm(formOf([...baseFields(), ...thresholdRow('0', '1', '0')]))).toBeNull();
    expect(parseConfigForm(formOf([...baseFields(), ...thresholdRow('0', '1', '6')]))).toBeNull();
    expect(parseConfigForm(formOf([...baseFields(), ...thresholdRow('0', '1', '5')]))).not.toBeNull();
  });

  it('refuses a band whose range runs backwards, or starts below zero', () => {
    // A band that can never match is not an error the engine reports; it just
    // silently never fires, and the score falls through to a later band.
    expect(parseConfigForm(formOf([...baseFields(), ...thresholdRow('7', '4', '3')]))).toBeNull();
    expect(parseConfigForm(formOf([...baseFields(), ...thresholdRow('-1', '4', '3')]))).toBeNull();
  });

  it('refuses an overhead percentage outside 0-100', () => {
    expect(
      parseConfigForm(
        formOf([...baseFields(), ...overheadRow('Too much', 'process.meetings', { dev: '150' })]),
      ),
    ).toBeNull();
    expect(
      parseConfigForm(
        formOf([...baseFields(), ...overheadRow('Negative', 'process.meetings', { qa: '-5' })]),
      ),
    ).toBeNull();
  });

  it('refuses a blank required multiplier rather than reading it as zero', () => {
    // Same trap as the score, with a worse blast radius: a 0 data-volume
    // multiplier would flatten every complexity score it touched.
    const blanked = baseFields().map(
      ([k, v]) => [k, k === 'dataVolumeMultiplierLow' ? '' : v] as [string, string],
    );
    expect(parseConfigForm(formOf(blanked))).toBeNull();
  });

  it('refuses an overhead row with no title or no taxonomy key', () => {
    expect(
      parseConfigForm(formOf([...baseFields(), ...overheadRow('', 'process.meetings', { dev: '5' })])),
    ).toBeNull();
    expect(
      parseConfigForm(formOf([...baseFields(), ...overheadRow('Nameless key', '', { dev: '5' })])),
    ).toBeNull();
  });

  it('refuses a missing change reason, and a non-numeric buffer', () => {
    const noReason = baseFields().filter(([k]) => k !== 'changeReason');
    expect(parseConfigForm(formOf(noReason))).toBeNull();
    expect(parseConfigForm(formOf([...noReason, ['changeReason', '   ']]))).toBeNull();

    const badPct = baseFields().map(
      ([k, v]) => [k, k === 'qaRegressionBufferPct' ? 'twenty' : v] as [string, string],
    );
    expect(parseConfigForm(formOf(badPct))).toBeNull();
  });

  it('splits keywords on commas and drops the empties', () => {
    const parsed = parseConfigForm(
      formOf([
        ...baseFields(),
        ['legacyKeywords', 'legacy, mainframe ,, cobol '],
        ['aiKeywords', ''],
      ]),
    );
    expect(parsed!.legacyKeywords).toEqual(['legacy', 'mainframe', 'cobol']);
    expect(parsed!.aiKeywords).toEqual([]);
  });

  it('reads the hidden-work gate from a checkbox that is absent when unticked', () => {
    expect(parseConfigForm(formOf(baseFields()))!.hiddenWorkBlocksFinalise).toBe(false);
    expect(
      parseConfigForm(formOf([...baseFields(), ['hiddenWorkBlocksFinalise', 'on']]))!
        .hiddenWorkBlocksFinalise,
    ).toBe(true);
  });

  it('falls back to OTHER for a motivation that is not one of the six', () => {
    const tampered = baseFields().map(
      ([k, v]) => [k, k === 'changeMotivation' ? 'DROP TABLE' : v] as [string, string],
    );
    expect(parseConfigForm(formOf(tampered))!.changeMotivation).toBe('OTHER');
  });
});
