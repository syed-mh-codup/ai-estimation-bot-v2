import { describe, expect, it } from 'vitest';
import {
  isValidBufferPct,
  resolveTaxPercents,
  snapToQuarterHour,
  taxedHoursFor,
  type HouseRates,
  type RateOverrides,
} from './tax-rates.js';

const HOUSE: HouseRates = {
  pmCommunicationTaxPct: 12,
  baCommunicationTaxPct: 8,
  qaRegressionBufferPct: 20,
};

const NO_OVERRIDES: RateOverrides = {
  pmCommunicationTaxPctOverride: null,
  baCommunicationTaxPctOverride: null,
  qaRegressionBufferPctOverride: null,
};

describe('resolveTaxPercents', () => {
  it('inherits every house rate when nothing is overridden', () => {
    expect(resolveTaxPercents(HOUSE, NO_OVERRIDES)).toEqual({
      DEV: 0,
      QA: 20,
      PM: 12,
      BA: 8,
    });
  });

  it('takes the override for the role that has one and inherits the rest', () => {
    const rates = resolveTaxPercents(HOUSE, {
      ...NO_OVERRIDES,
      qaRegressionBufferPctOverride: 35,
    });
    expect(rates.QA).toBe(35);
    expect(rates.PM).toBe(12);
    expect(rates.BA).toBe(8);
  });

  /**
   * The distinction the nullable columns exist for. A client with no BA
   * involvement is the case this feature was asked for, so zero has to mean
   * "charge nothing" and not "fall back to the house 8%".
   */
  it('treats a zero override as a real rate, not as absent', () => {
    const rates = resolveTaxPercents(HOUSE, {
      ...NO_OVERRIDES,
      baCommunicationTaxPctOverride: 0,
    });
    expect(rates.BA).toBe(0);
  });

  it('reports DEV as zero even when every other role is overridden', () => {
    const rates = resolveTaxPercents(HOUSE, {
      pmCommunicationTaxPctOverride: 50,
      baCommunicationTaxPctOverride: 50,
      qaRegressionBufferPctOverride: 50,
    });
    expect(rates.DEV).toBe(0);
  });

  /**
   * A missing config row means the pinned `configVersion` could not be read.
   * An override is a fact about the estimate and must survive that; an
   * un-overridden role has no rate to fall back to, and zero is what the code
   * this replaced already produced when no config existed.
   */
  it('honours overrides but charges nothing for inherited roles when the pinned config is missing', () => {
    const rates = resolveTaxPercents(null, {
      ...NO_OVERRIDES,
      qaRegressionBufferPctOverride: 30,
    });
    expect(rates).toEqual({ DEV: 0, QA: 30, PM: 0, BA: 0 });
  });
});

describe('isValidBufferPct', () => {
  it('accepts the bounds and a value between them', () => {
    expect(isValidBufferPct(0)).toBe(true);
    expect(isValidBufferPct(35.5)).toBe(true);
    expect(isValidBufferPct(100)).toBe(true);
  });

  it('rejects out-of-range values', () => {
    expect(isValidBufferPct(-1)).toBe(false);
    expect(isValidBufferPct(101)).toBe(false);
  });

  /** `Number('abc')` is NaN and `Number('1e999')` is Infinity — both reach a number input. */
  it('rejects NaN and Infinity', () => {
    expect(isValidBufferPct(Number('abc'))).toBe(false);
    expect(isValidBufferPct(Number('1e999'))).toBe(false);
    expect(isValidBufferPct(Number.NaN)).toBe(false);
  });

  /**
   * `Number('')` is 0, not NaN — so a CLEARED field must never be routed
   * through `Number()` and handed to this function. It would pass, and the
   * estimator who wiped the box to go back to the house default would silently
   * get a 0% buffer pinned to the estimate instead. Callers have to treat an
   * empty string as "reset to inherit" (null) BEFORE any numeric coercion; the
   * server action and the rollup input both do.
   */
  it('accepts zero, which is why an empty input cannot be coerced to a number', () => {
    expect(Number('')).toBe(0);
    expect(isValidBufferPct(Number(''))).toBe(true);
  });
});

describe('snapToQuarterHour', () => {
  it('rounds to the nearest quarter', () => {
    expect(snapToQuarterHour(2.4)).toBe(2.5);
    expect(snapToQuarterHour(2.6)).toBe(2.5);
    expect(snapToQuarterHour(3.63)).toBe(3.75);
  });

  it('floors at zero rather than returning a negative', () => {
    expect(snapToQuarterHour(-4)).toBe(0);
  });

  /** Unlike specialist.ts's helper, nothing here caps at the four-hour rule. */
  it('does not cap large values', () => {
    expect(snapToQuarterHour(37.5)).toBe(37.5);
  });
});

describe('taxedHoursFor', () => {
  it('applies a whole-percent buffer', () => {
    expect(taxedHoursFor(10, 20)).toBe(12);
  });

  it('returns the base figure when the buffer is zero', () => {
    expect(taxedHoursFor(3.25, 0)).toBe(3.25);
  });

  /**
   * The rounding dead zone, asserted so nobody "fixes" it without reading why.
   *
   * Per-line snapping is what keeps the line figures on screen summing to the
   * total on screen. The price is that nudging a buffer by one point moves some
   * lines and not others: at 20% -> 21% a 2h and a 4h line do not move at all
   * while a 3h line gains a quarter hour. See the note on taxedHoursFor.
   */
  it('moves some lines and not others on a one-point nudge', () => {
    expect(taxedHoursFor(2, 20)).toBe(2.5);
    expect(taxedHoursFor(2, 21)).toBe(2.5);

    expect(taxedHoursFor(4, 20)).toBe(4.75);
    expect(taxedHoursFor(4, 21)).toBe(4.75);

    expect(taxedHoursFor(3, 20)).toBe(3.5);
    expect(taxedHoursFor(3, 21)).toBe(3.75);
  });

  /** The ledger has to add up: the rows sum to exactly the total, at both rates. */
  it('keeps the sum of the lines equal to the sum shown', () => {
    const bases = [2, 3, 4];
    const at20 = bases.map((b) => taxedHoursFor(b, 20));
    const at21 = bases.map((b) => taxedHoursFor(b, 21));
    expect(at20.reduce((a, b) => a + b, 0)).toBe(10.75);
    expect(at21.reduce((a, b) => a + b, 0)).toBe(11);
  });
});
