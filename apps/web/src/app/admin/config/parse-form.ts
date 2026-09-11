import type { ChangeMotivation } from '@repo/db';

/**
 * Reading the config form back out of a `FormData`.
 *
 * Its own module, and pure, because this is the one part of the config screen
 * with a way to be quietly wrong. Two of these settings are LISTS, and a list in
 * an HTML form arrives as one flat sequence per column — the rows exist only in
 * so far as this function reconstructs them. Getting that wrong does not throw;
 * it writes a config version whose overhead card charges the wrong role.
 *
 * A server action cannot be called from a test, so leaving this inside one would
 * mean the riskiest code on the screen was the only code with no way to check
 * it. AEH-348.
 */

/** Also what the form's Motivation select offers, so the two cannot disagree. */
export const MOTIVATIONS: ChangeMotivation[] = [
  'CORRECTION',
  'NEW_PROCESS',
  'POST_DELIVERY_VALIDATION',
  'TECH_ADVANCEMENT',
  'UPSKILL',
  'OTHER',
];

function isMotivation(v: string): v is ChangeMotivation {
  return (MOTIVATIONS as string[]).includes(v);
}

/** Comma-separated keywords in, trimmed list out. Same idiom as the presets admin. */
const csv = (v: FormDataEntryValue | null): string[] =>
  typeof v === 'string'
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];

/**
 * A required number. Blank is NaN, not zero.
 *
 * `Number('')` is 0, so the obvious one-liner accepts an empty box as a real
 * answer — and an empty complexity score would save as 0, which
 * `ApiThresholdSchema` (min 1, max 5) rejects with a THROW the next time an
 * estimate runs. The whole point of moving these out of a JSON textarea was to
 * stop a bad value being someone else's runtime problem.
 */
const num = (v: FormDataEntryValue | null): number =>
  typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : NaN;

/** Bounds the engine's own schemas enforce, applied here so a save cannot break a run. */
const inRange = (n: number, min: number, max: number): boolean => n >= min && n <= max;

const text = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v.trim() : '');

/** Distinguishes "this box was left blank" from "this box held nonsense". */
const INVALID = Symbol('invalid');

/**
 * A role's overhead percentage, where blank is a meaningful answer.
 *
 * Blank means the role is charged nothing and gets no card; 0 would mean a card
 * costing nothing, which is a line on a client's estimate for no hours. The
 * empty string is therefore checked BEFORE any numeric coercion — `Number('')`
 * is 0, not NaN, so a cleared box run through `Number()` would quietly turn
 * "don't charge QA" into "charge QA zero".
 */
function optionalPct(v: FormDataEntryValue | null): number | null | typeof INVALID {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : INVALID;
}

export interface ParsedThreshold {
  position: number;
  minCount: number;
  maxCount: number;
  score: number;
}

export interface ParsedOverheadItem {
  position: number;
  title: string;
  taxonomyKey: string;
  devPct: number | null;
  qaPct: number | null;
  pmPct: number | null;
  baPct: number | null;
}

export interface ParsedConfig {
  pmCommunicationTaxPct: number;
  baCommunicationTaxPct: number;
  qaRegressionBufferPct: number;
  legacyKeywords: string[];
  legacyScoreBonus: number;
  aiKeywords: string[];
  aiScoreBonus: number;
  dataVolumeMultiplierNone: number;
  dataVolumeMultiplierLow: number;
  dataVolumeMultiplierHigh: number;
  hiddenWorkBlocksFinalise: boolean;
  changeReason: string;
  changeMotivation: ChangeMotivation;
  apiThresholds: ParsedThreshold[];
  overheadItems: ParsedOverheadItem[];
}

/**
 * `null` means "do not write a version from this". The caller returns without
 * saving rather than persisting something half-read.
 */
export function parseConfigForm(formData: FormData): ParsedConfig | null {
  const pmCommunicationTaxPct = num(formData.get('pmCommunicationTaxPct'));
  const baCommunicationTaxPct = num(formData.get('baCommunicationTaxPct'));
  const qaRegressionBufferPct = num(formData.get('qaRegressionBufferPct'));
  const legacyScoreBonus = num(formData.get('legacyScoreBonus'));
  const aiScoreBonus = num(formData.get('aiScoreBonus'));
  const dataVolumeMultiplierNone = num(formData.get('dataVolumeMultiplierNone'));
  const dataVolumeMultiplierLow = num(formData.get('dataVolumeMultiplierLow'));
  const dataVolumeMultiplierHigh = num(formData.get('dataVolumeMultiplierHigh'));
  const changeReason = text(formData.get('changeReason'));
  const motivationRaw = formData.get('changeMotivation');

  // The repeating rows arrive as one list per column, in document order, so a
  // row is the i-th entry of each. No index travels through the form, which is
  // what stops a removed row from renumbering the ones after it.
  const thresholdMins = formData.getAll('thresholdMin');
  const thresholdMaxes = formData.getAll('thresholdMax');
  const thresholdScores = formData.getAll('thresholdScore');
  const apiThresholds = thresholdMins.map((_, i) => ({
    position: i,
    minCount: Math.trunc(num(thresholdMins[i] ?? null)),
    maxCount: Math.trunc(num(thresholdMaxes[i] ?? null)),
    score: num(thresholdScores[i] ?? null),
  }));

  const overheadTitles = formData.getAll('overheadTitle');
  const overheadKeys = formData.getAll('overheadKey');
  const overheadDev = formData.getAll('overheadDevPct');
  const overheadQa = formData.getAll('overheadQaPct');
  const overheadPm = formData.getAll('overheadPmPct');
  const overheadBa = formData.getAll('overheadBaPct');
  const rawOverhead = overheadTitles.map((_, i) => ({
    position: i,
    title: text(overheadTitles[i] ?? null),
    taxonomyKey: text(overheadKeys[i] ?? null),
    devPct: optionalPct(overheadDev[i] ?? null),
    qaPct: optionalPct(overheadQa[i] ?? null),
    pmPct: optionalPct(overheadPm[i] ?? null),
    baPct: optionalPct(overheadBa[i] ?? null),
  }));

  // Reject invalid input rather than persisting a broken config version. The
  // column shapes made a malformed RULE SET unrepresentable; what is still worth
  // checking is what a person can type, and that the columns of a repeating row
  // arrived at the same length — zipping by position assumes they did.
  const scalarsOk = [
    pmCommunicationTaxPct,
    baCommunicationTaxPct,
    qaRegressionBufferPct,
    legacyScoreBonus,
    aiScoreBonus,
    dataVolumeMultiplierNone,
    dataVolumeMultiplierLow,
    dataVolumeMultiplierHigh,
  ].every((n) => Number.isFinite(n));
  const rowsAligned =
    thresholdMaxes.length === thresholdMins.length &&
    thresholdScores.length === thresholdMins.length &&
    [overheadKeys, overheadDev, overheadQa, overheadPm, overheadBa].every(
      (column) => column.length === overheadTitles.length,
    );
  // A band's score is bounded here, and the role buffers above deliberately are
  // not. The asymmetry follows the engine: an out-of-range score makes
  // `ComplexityRulesSchema.parse` THROW mid-run, so letting one save would move
  // the failure to a screen nobody is watching — which is the habit this ticket
  // exists to break. A buffer percentage has no such schema, and the note in
  // packages/shared/src/tax-rates.ts records that leaving it unbounded for an
  // admin editing behind a mandatory change reason was a decision, not an
  // oversight. Overhead percentages sit between: `ProcessOverheadItemSchema`
  // bounds them 0–100, but only warns, so bounding them here loses nothing.
  const thresholdsOk = apiThresholds.every(
    (band) =>
      Number.isFinite(band.minCount) &&
      Number.isFinite(band.maxCount) &&
      Number.isFinite(band.score) &&
      inRange(band.score, 1, 5) &&
      band.minCount >= 0 &&
      band.maxCount >= band.minCount,
  );
  const overheadOk = rawOverhead.every(
    (item) =>
      item.title !== '' &&
      item.taxonomyKey !== '' &&
      // null is "charge this role nothing"; a number must be in range. INVALID
      // is neither, so it fails this test without needing a separate one.
      [item.devPct, item.qaPct, item.pmPct, item.baPct].every(
        (pct) => pct === null || (typeof pct === 'number' && inRange(pct, 0, 100)),
      ),
  );

  if (!scalarsOk || !rowsAligned || !thresholdsOk || !overheadOk || !changeReason) {
    return null;
  }

  return {
    pmCommunicationTaxPct,
    baCommunicationTaxPct,
    qaRegressionBufferPct,
    legacyKeywords: csv(formData.get('legacyKeywords')),
    legacyScoreBonus,
    aiKeywords: csv(formData.get('aiKeywords')),
    aiScoreBonus,
    dataVolumeMultiplierNone,
    dataVolumeMultiplierLow,
    dataVolumeMultiplierHigh,
    hiddenWorkBlocksFinalise: formData.get('hiddenWorkBlocksFinalise') === 'on',
    changeReason,
    changeMotivation:
      typeof motivationRaw === 'string' && isMotivation(motivationRaw) ? motivationRaw : 'OTHER',
    apiThresholds,
    // Narrowed by `overheadOk`: INVALID cannot reach here.
    overheadItems: rawOverhead.map((item) => ({
      position: item.position,
      title: item.title,
      taxonomyKey: item.taxonomyKey,
      devPct: item.devPct as number | null,
      qaPct: item.qaPct as number | null,
      pmPct: item.pmPct as number | null,
      baPct: item.baPct as number | null,
    })),
  };
}
