/**
 * Which buffer percentages apply to one estimate, and the one piece of
 * arithmetic that turns a base figure into a taxed one.
 *
 * This module exists because the same two calculations were previously written
 * out in four places — twice in `apps/web` (a server component and a server
 * action), once in the pipeline, once again in the client's optimistic patch —
 * and the copies had already drifted: the web copies read whichever config was
 * ACTIVE while the estimate itself is pinned to a `configVersion`, so an
 * estimate costed under v3 picked up v4 rates on any line edited after v4 was
 * activated, and its stored hours silently became a mix of two config versions.
 *
 * Everything here is pure and has no dependency on Prisma or React, which is
 * what lets the server action, the server component, the client's optimistic
 * recompute and the agent pipeline share one implementation. A client that
 * predicts a total with different arithmetic than the server stores is a UI
 * that lies for one round trip and then jumps. AEH-335.
 */

/** Every role an estimate prices work for. */
export const BUFFER_ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;
export type BufferRole = (typeof BUFFER_ROLES)[number];

/**
 * The roles a buffer can actually be set for.
 *
 * DEV is absent deliberately and permanently: the complexity multiplier is
 * already applied to DEV hours upstream, so a communication tax on top would
 * charge for the same uncertainty twice. `resolveTaxPercents` still reports
 * DEV — as zero — because callers key by role and a missing key reads as a bug.
 */
export const TAXABLE_ROLES = ['QA', 'PM', 'BA'] as const;
export type TaxableRole = (typeof TAXABLE_ROLES)[number];

/** The house defaults, as held on an `EstimationConfig` row. */
export type HouseRates = {
  pmCommunicationTaxPct: number;
  baCommunicationTaxPct: number;
  qaRegressionBufferPct: number;
};

/** The per-estimate overrides, as held on an `Estimate` row. Null = inherit. */
export type RateOverrides = {
  pmCommunicationTaxPctOverride: number | null;
  baCommunicationTaxPctOverride: number | null;
  qaRegressionBufferPctOverride: number | null;
};

/** Effective whole-percent buffer per role. 20 means 20%, not 0.2. */
export type TaxPercents = Record<BufferRole, number>;

/**
 * Bounds on a per-estimate override.
 *
 * Stricter than the config admin, which only rejects NaN. That is not an
 * oversight being copied: the config is edited rarely, by an admin, behind a
 * mandatory change reason, whereas this is a field an estimator nudges while
 * looking at a client's number. A fat-fingered 350 there would treble an
 * estimate silently. The range matches `ProcessOverheadItemSchema`, which is
 * the repo's existing answer for "a percentage a human types".
 */
export const MIN_BUFFER_PCT = 0;
export const MAX_BUFFER_PCT = 100;

/** Which `RateOverrides` key carries the override for a role. */
export const OVERRIDE_FIELD: Record<TaxableRole, keyof RateOverrides> = {
  QA: 'qaRegressionBufferPctOverride',
  PM: 'pmCommunicationTaxPctOverride',
  BA: 'baCommunicationTaxPctOverride',
};

/** Which `HouseRates` key carries the house default for a role. */
export const HOUSE_FIELD: Record<TaxableRole, keyof HouseRates> = {
  QA: 'qaRegressionBufferPct',
  PM: 'pmCommunicationTaxPct',
  BA: 'baCommunicationTaxPct',
};

export function isTaxableRole(role: string): role is TaxableRole {
  return (TAXABLE_ROLES as readonly string[]).includes(role);
}

/**
 * True for a percentage a human may set as an override.
 *
 * Rejects NaN and Infinity as well as out-of-range values — `Number('')` is
 * NaN and `Number('1e999')` is Infinity, and both arrive from a number input
 * without any of the digits that would make them look wrong.
 */
export function isValidBufferPct(pct: number): boolean {
  return Number.isFinite(pct) && pct >= MIN_BUFFER_PCT && pct <= MAX_BUFFER_PCT;
}

/**
 * The buffers actually in force for one estimate: its own override where it has
 * one, the house default from the config it is pinned to otherwise.
 *
 * `house` may be null, which means the pinned config version could not be
 * found. Zero is then the honest answer for an un-overridden role — it is what
 * the code this replaces already did when no config existed — and an override
 * is still honoured, because an override is a fact about the estimate and does
 * not depend on a config row being readable.
 *
 * Note that 0 is a real override and not the absence of one: a client with no
 * BA involvement is exactly the case this feature was asked for. Only null
 * inherits, which is why the overrides are nullable rather than defaulted.
 */
export function resolveTaxPercents(
  house: HouseRates | null,
  overrides: RateOverrides,
): TaxPercents {
  // Written out per role rather than looped over OVERRIDE_FIELD/HOUSE_FIELD.
  // Three lines of `??` are plainer than two lookup tables and an inner
  // closure, and the field audit can only see a column as consumed when it is
  // read by name — a dynamic index reads to it as nothing at all, which is how
  // three live columns would have been reported as orphans.
  return {
    DEV: 0,
    QA: overrides.qaRegressionBufferPctOverride ?? house?.qaRegressionBufferPct ?? 0,
    PM: overrides.pmCommunicationTaxPctOverride ?? house?.pmCommunicationTaxPct ?? 0,
    BA: overrides.baCommunicationTaxPctOverride ?? house?.baCommunicationTaxPct ?? 0,
  };
}

/**
 * Round to the nearest 0.25h.
 *
 * Line items are atomic units of at most four hours at quarter-hour
 * granularity (the FOUR-HOUR RULE), so whole-hour rounding would visibly
 * distort them. Floored at zero because negative hours are not a thing and a
 * pasted minus sign should not become a credit.
 *
 * Deliberately NOT shared with `specialist.ts`'s helper of the same shape: that
 * one clamps into [0.25, 4] because it is splitting an oversized figure into
 * legal chunks, and clamping a taxed total to four hours would silently cap
 * every large line item.
 */
export function snapToQuarterHour(hours: number): number {
  return Math.max(0, Math.round(hours * 4) / 4);
}

/**
 * What a line item's hours become once its role's buffer is applied.
 *
 * Snapped per line, not per total, and that is a decision rather than an
 * accident. Snapping once at the end would make the total glide smoothly as a
 * buffer is nudged, but the line figures on screen would then no longer add up
 * to the total on screen — and a ledger whose rows do not sum to its own total
 * is not defensible in front of a client. The cost is that a one-point nudge
 * moves the total unevenly, and on a small estimate sometimes not at all: at a
 * 20% buffer a 2h line and a 4h line both stay where they are while a 3h line
 * moves. That lumpiness is the accepted price of a ledger that adds up.
 *
 * `pct` is whole percent, matching how it is stored and displayed everywhere.
 */
export function taxedHoursFor(baseHours: number, pct: number): number {
  return snapToQuarterHour(baseHours * (1 + pct / 100));
}
