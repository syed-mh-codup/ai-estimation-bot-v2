import { prisma, type PrismaClient } from '@repo/db';
import {
  isTaxableRole,
  resolveTaxPercents,
  type HouseRates,
  type RateOverrides,
  type TaxableRole,
  type TaxPercents,
} from '@repo/shared';

/**
 * Reading the buffers that apply to one estimate.
 *
 * There used to be two copies of this, in `estimates/[id]/page.tsx` and in
 * `estimates/[id]/actions.ts`, and both had the same bug: they read the config
 * row where `active` is true, while an estimate is pinned to a `configVersion`
 * of its own. An estimate costed under v3 therefore picked up v4's rates on any
 * line edited after v4 was activated, and its stored `taxedHours` became a mix
 * of two config versions — with the estimate page still displaying "Config v3"
 * beside them. One module, reading the pin, is the fix. AEH-335.
 */

/**
 * Just the model accessors these helpers need, so a transaction client
 * (Prisma.TransactionClient) can be passed without a cast. Resolving the rates
 * inside the same transaction that recomputes the hours is the normal case, and
 * reading them from outside it would be a torn read.
 */
type TaxCapable = Pick<PrismaClient, 'estimate' | 'estimationConfig'>;

/** As above, for the provenance reader, which also needs to name a person. */
type ProvenanceCapable = Pick<PrismaClient, 'estimateTaxChange' | 'user'>;

/** The Estimate columns needed to resolve rates. Spread into a Prisma select. */
export const RATE_SELECT = {
  configVersion: true,
  pmCommunicationTaxPctOverride: true,
  baCommunicationTaxPctOverride: true,
  qaRegressionBufferPctOverride: true,
} as const;

const HOUSE_SELECT = {
  pmCommunicationTaxPct: true,
  baCommunicationTaxPct: true,
  qaRegressionBufferPct: true,
} as const;

/** Everything the estimate page and the rollup need to render and edit buffers. */
export type TaxContext = {
  /** Effective whole-percent buffer per role: override where set, house otherwise. */
  effective: TaxPercents;
  /** The house defaults from the pinned config, so "reset" can say what it reverts to. */
  house: HouseRates | null;
  /** Which roles this estimate sets for itself. Null means inherit. */
  overrides: RateOverrides;
  /** The config version the rates above were read from. */
  configVersion: number;
};

/**
 * The house rates for one config version.
 *
 * Falls back to the active config when that version has no row. This is not
 * laxness: `configVersion` defaults to 0 for an estimate created while no
 * config was active at all (see the ingest-create route), and version 0 has
 * never existed. Zeroing those estimates' buffers would silently reprice them,
 * so the fallback preserves exactly the behaviour they have today. Once a
 * pipeline run has written the version back, the fallback stops being reachable
 * for that estimate.
 */
export async function houseRatesFor(
  configVersion: number,
  client: TaxCapable = prisma,
): Promise<HouseRates | null> {
  const pinned = await client.estimationConfig.findUnique({
    where: { version: configVersion },
    select: HOUSE_SELECT,
  });
  if (pinned) return pinned;
  return client.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
    select: HOUSE_SELECT,
  });
}

/** Resolve the buffers for an estimate whose rate columns have already been read. */
export async function taxContextFor(
  est: { configVersion: number } & RateOverrides,
  client: TaxCapable = prisma,
): Promise<TaxContext> {
  const house = await houseRatesFor(est.configVersion, client);
  const overrides: RateOverrides = {
    pmCommunicationTaxPctOverride: est.pmCommunicationTaxPctOverride,
    baCommunicationTaxPctOverride: est.baCommunicationTaxPctOverride,
    qaRegressionBufferPctOverride: est.qaRegressionBufferPctOverride,
  };
  return {
    effective: resolveTaxPercents(house, overrides),
    house,
    overrides,
    configVersion: est.configVersion,
  };
}

/** Resolve the buffers for an estimate by id. Throws if it does not exist. */
export async function taxContextForEstimate(
  estimateId: string,
  client: TaxCapable = prisma,
): Promise<TaxContext> {
  // @deleted-ok resolves the rates an estimate was costed under, always
  // downstream of a caller that has already decided the estimate is readable —
  // and a deleted estimate's stored hours still have to add up. AEH-375.
  const est = await client.estimate.findUniqueOrThrow({
    where: { id: estimateId },
    select: RATE_SELECT,
  });
  return taxContextFor(est, client);
}

/** The last time one role's buffer was moved on this estimate, and by whom. */
export type TaxChangeNote = {
  fromPct: number | null;
  toPct: number | null;
  /**
   * Preformatted here rather than on the client.
   *
   * The rollup is a client component and this reaches it as a prop, so
   * formatting a Date there would run once on the server and again in the
   * browser with a different locale and timezone — a hydration mismatch on a
   * line nobody would think to check. A fixed en-GB/UTC format is identical
   * wherever it runs.
   */
  atLabel: string;
  /** The person's email, or null when the account is gone or a job did it. */
  by: string | null;
};

const CHANGED_AT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * The most recent change to each role's buffer, so the rollup can answer "why
 * is this estimate's QA buffer 35%" without anyone opening a database client.
 *
 * `distinct` over a descending sort is what makes this one query rather than
 * one per role. Emails are resolved separately because `changedBy` holds a
 * plain user id rather than a foreign key — the same shape `createdBy` uses on
 * the config and prompt version rows, and for the same reason: the record has
 * to outlive the account, so it must not be a relation that cascades or blocks.
 */
export async function latestTaxChanges(
  estimateId: string,
  client: ProvenanceCapable = prisma,
): Promise<Partial<Record<TaxableRole, TaxChangeNote>>> {
  const rows = await client.estimateTaxChange.findMany({
    where: { estimateId },
    orderBy: { createdAt: 'desc' },
    distinct: ['role'],
    select: { role: true, fromPct: true, toPct: true, createdAt: true, changedBy: true },
  });
  if (rows.length === 0) return {};

  const ids = [...new Set(rows.map((r) => r.changedBy).filter((v): v is string => v !== null))];
  const people = ids.length
    ? await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true } })
    : [];
  const emailOf = new Map(people.map((p) => [p.id, p.email]));

  const out: Partial<Record<TaxableRole, TaxChangeNote>> = {};
  for (const row of rows) {
    if (!isTaxableRole(row.role)) continue;
    out[row.role] = {
      fromPct: row.fromPct,
      toPct: row.toPct,
      atLabel: CHANGED_AT.format(row.createdAt),
      by: row.changedBy ? emailOf.get(row.changedBy) ?? null : null,
    };
  }
  return out;
}
