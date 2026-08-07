import type { PrismaClient } from '@repo/db';
import type { IEmbeddingProvider } from '@repo/providers';
import type { MenuItem, RoleLineItem } from '@repo/shared';

// ─── Dev hours → a preset's beHours / feHours ─────────────────────────────────

/**
 * Frontend's share of dev effort across the seeded library (P01–P45),
 * hours-weighted: 310 FE of 964 total. Used ONLY to apportion line items that
 * carry no side tag — never to manufacture hours that don't exist.
 */
const LIBRARY_FE_SHARE = 0.32;

/**
 * Minimum Archivist match score at which a finalised card is written back onto
 * the preset it matched, rather than becoming a new preset.
 *
 * Observed scores run ~0.46–0.62 on ordinary SOWs and ~0.60–0.83 on
 * preset-adjacent ones, so this is deliberately strict: a 0.5 "match" is a
 * family resemblance, and letting it overwrite an established preset would
 * corrupt the anchor every future estimate reads.
 */
export const PROMOTION_MATCH_THRESHOLD = 0.75;

export type DevSplit = {
  beHours: number;
  feHours: number;
  /** How the split was arrived at — recorded on the version for auditability. */
  basis: 'tagged' | 'mixed' | 'estimated';
  /** Dev hours that carried no side tag and had to be apportioned. */
  untaggedHours: number;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Partition a card's DEV hours into backend and frontend.
 *
 * This replaces the old `feHours = round(beHours * 0.4)`, which assigned 100%
 * of DEV to backend and then ADDED 40% on top — storing 1.4x the estimate it
 * came from. Because a promoted preset becomes the anchor for the next
 * estimate (specialist.ts feeds beHours+feHours back in), that error compounded
 * every cycle.
 *
 * The partition here always sums to the card's actual DEV total:
 *   - tagged backend-only / frontend-only → counted whole to that side
 *   - tagged both (genuinely inseparable) → halved
 *   - untagged → apportioned by the library ratio, and reported via `basis`
 *     so the caller can say so rather than implying precision it doesn't have
 */
export function splitDevHours(lineItems: RoleLineItem[]): DevSplit {
  const dev = lineItems.filter((l) => l.role === 'DEV');

  let be = 0;
  let fe = 0;
  let untagged = 0;

  for (const li of dev) {
    const h = li.taxedHours;
    const f = li.touchesFrontend;
    const b = li.touchesBackend;
    if (f && b) {
      // Inseparable full-stack unit: nothing better than an even hand, but the
      // total is still right, which is what the preset library depends on.
      be += h / 2;
      fe += h / 2;
    } else if (b) {
      be += h;
    } else if (f) {
      fe += h;
    } else {
      untagged += h;
    }
  }

  if (untagged > 0) {
    fe += untagged * LIBRARY_FE_SHARE;
    be += untagged * (1 - LIBRARY_FE_SHARE);
  }

  const taggedHours = dev.reduce((s, l) => s + l.taxedHours, 0) - untagged;
  const basis: DevSplit['basis'] =
    untagged === 0 ? 'tagged' : taggedHours === 0 ? 'estimated' : 'mixed';

  return { beHours: round2(be), feHours: round2(fe), basis, untaggedHours: round2(untagged) };
}

/** Human-readable provenance for the split, for `changeReason`. */
function describeSplit(s: DevSplit): string {
  if (s.basis === 'tagged') return 'BE/FE from line-item side tags (exact)';
  const pct = Math.round(LIBRARY_FE_SHARE * 100);
  return s.basis === 'estimated'
    ? `BE/FE apportioned from untagged dev hours at the library ratio (${100 - pct}/${pct})`
    : `BE/FE from side tags, with ${s.untaggedHours}h untagged apportioned at the library ratio (${100 - pct}/${pct})`;
}

// ─── WS20-01: Promote enabled menu items to PresetVersions ────────────────────

export type PromoteResult = {
  promoted: string[];  // preset IDs created/updated
  skipped: string[];   // already exists
  /** Promotions that became a new version of the preset the card matched. */
  versioned: string[];
  /** Promotions that minted a brand-new preset (no strong match). */
  created: string[];
};

/**
 * Finalise an estimate: write each enabled menu item back into the preset
 * library. Idempotent — re-finalising skips items already promoted from this
 * estimate.
 *
 * Hybrid target selection. A card that matched an existing preset strongly
 * (>= PROMOTION_MATCH_THRESHOLD) becomes a NEW VERSION of that preset, so the
 * library actually learns from delivered work. A weak or absent match mints a
 * new `promoted-*` preset instead, because writing loosely-related work onto
 * P26 would poison the anchor every future estimate reads.
 */
export async function promoteMenuItemsToPresets(
  db: PrismaClient,
  estimateId: string,
  menuItems: MenuItem[],
): Promise<PromoteResult> {
  const enabled = menuItems.filter((m) => m.enabled);
  const promoted: string[] = [];
  const skipped: string[] = [];
  const versioned: string[] = [];
  const created: string[] = [];

  // Redundant next to finaliseAction, which has already done this — kept so the
  // function is correct when called on its own, and harmless because it's
  // idempotent.
  await db.estimate.update({
    where: { id: estimateId },
    data: { status: 'FINALISED' },
  });

  for (const item of enabled) {
    // Injected placeholders (infra baseline, hidden work) aren't features and
    // have no side tags — they must never enter the library.
    if (item.id.startsWith('baseline-') || item.id.startsWith('hidden-')) continue;

    // Hybrid: version the matched preset only on a confident match.
    const strongMatch =
      item.sourcePresetId && (item.matchScore ?? 0) >= PROMOTION_MATCH_THRESHOLD
        ? item.sourcePresetId
        : null;
    const presetId = strongMatch ?? `promoted-${estimateId}-${item.id}`;

    // Already promoted from this estimate — don't stack duplicate versions on
    // a re-finalise.
    const existing = await db.presetVersion.findFirst({
      where: { presetId, sourceEstimateId: estimateId },
    });
    if (existing) {
      skipped.push(presetId);
      continue;
    }

    const latestVersion = await db.presetVersion.findFirst({
      where: { presetId },
      orderBy: { version: 'desc' },
    });
    const newVersion = (latestVersion?.version ?? 0) + 1;

    if (latestVersion) {
      await db.presetVersion.updateMany({ where: { presetId }, data: { active: false } });
    }

    const presetExists = await db.preset.findUnique({ where: { id: presetId } });
    if (!presetExists) {
      await db.preset.create({ data: { id: presetId } });
    }

    // Dev hours partitioned by side tag, always summing to the card's real DEV
    // total (see splitDevHours — this is what replaced the 1.4x inflation).
    const split = splitDevHours(item.lineItems);

    // Versioning a real preset: keep its taxonomy/metadata and change only what
    // this estimate actually evidences. Minting one: derive what we can.
    const carry = strongMatch && latestVersion ? latestVersion : null;

    await db.presetVersion.create({
      data: {
        presetId,
        version: newVersion,
        active: true,
        category: carry?.category ?? item.taxonomyKey.split('.')[0] ?? 'general',
        name: carry?.name ?? item.title,
        description: carry?.description ?? `Promoted from estimate ${estimateId}`,
        beHours: Math.round(split.beHours),
        feHours: Math.round(split.feHours),
        platforms: carry?.platforms ?? [],
        reqType: carry?.reqType ?? 'FEATURE',
        keywords: carry?.keywords ?? [item.taxonomyKey],
        userStoryTags: carry?.userStoryTags ?? [],
        projectSizeFit: carry?.projectSizeFit ?? [],
        integrationCount: carry?.integrationCount ?? 0,
        dataVolume: carry?.dataVolume ?? 'LOW',
        phase: carry?.phase ?? 'CORE',
        requires: carry?.requires ?? [],
        blocks: carry?.blocks ?? [],
        canParallel: carry?.canParallel ?? true,
        aiAssist: carry?.aiAssist ?? 'LOW',
        risk: carry?.risk ?? 'LOW',
        spikeNeeded: carry?.spikeNeeded ?? false,
        notes: carry?.notes ?? '',
        taxonomyKey: carry?.taxonomyKey ?? item.taxonomyKey,
        changeMotivation: 'POST_DELIVERY_VALIDATION',
        sourceEstimateId: estimateId,
        changeReason: strongMatch
          ? `Recalibrated from finalised estimate ${estimateId} (match ${(item.matchScore ?? 0).toFixed(2)}) — ${describeSplit(split)}`
          : `Promoted from finalised estimate ${estimateId} — ${describeSplit(split)}`,
      },
    });

    promoted.push(presetId);
    (strongMatch ? versioned : created).push(presetId);
  }

  return { promoted, skipped, versioned, created };
}

// ─── WS20-02: Generate + store embeddings for promoted rows ───────────────────

/**
 * The one definition of what a preset "means" to the Archivist. Every writer
 * of `embedding` must go through this, so `embeddingText` is always literally
 * the string that produced the vector sitting next to it.
 */
export function presetEmbeddingText(v: {
  name: string;
  description: string;
  keywords: string[];
}): string {
  return [v.name, v.description, ...v.keywords].join(' ');
}

/** Embed one active version and store the vector alongside its source text. */
async function embedVersionRow(
  db: PrismaClient,
  row: { id: string; name: string; description: string; keywords: string[] },
  embeddingProvider: IEmbeddingProvider,
): Promise<boolean> {
  const text = presetEmbeddingText(row);
  const [vector] = await embeddingProvider.embed(text);
  if (!vector) return false;

  // Prisma's typed client can't write an Unsupported("vector") column, so the
  // cast has to happen in raw SQL. embeddingText rides the same statement —
  // the two must never disagree.
  await db.$executeRawUnsafe(
    `UPDATE "PresetVersion" SET embedding = $1::vector, "embeddingText" = $2 WHERE id = $3`,
    `[${vector.join(',')}]`,
    text,
    row.id,
  );
  return true;
}

/**
 * Generate and store embeddings for promoted PresetVersions.
 * After this, Archivist can match previously promoted items.
 */
export async function embedPromotedPresets(
  db: PrismaClient,
  presetIds: string[],
  embeddingProvider: IEmbeddingProvider,
): Promise<void> {
  for (const presetId of presetIds) {
    const version = await db.presetVersion.findFirst({
      where: { presetId, active: true },
      select: { id: true, name: true, description: true, keywords: true },
    });
    if (!version) continue;
    await embedVersionRow(db, version, embeddingProvider);
  }
}

export type BackfillResult = {
  /** Rows that had no vector at all — invisible to the Archivist until now. */
  missing: number;
  /** Rows whose vector no longer matched their text (edited since embedding). */
  stale: number;
  embedded: number;
  failed: Array<{ presetId: string; error: string }>;
};

/**
 * Bring every active preset version's embedding up to date.
 *
 * `queryPresetsByVector` filters on `embedding IS NOT NULL AND active = true`,
 * so a preset without a vector is simply invisible to retrieval — it does not
 * error, it silently never matches. This is the routine that guarantees that
 * doesn't happen, and it is idempotent: run it as often as you like.
 *
 * Re-embeds a row when it has no vector, or when its current text differs from
 * the `embeddingText` recorded beside the vector (an admin edit, or a row
 * predating that column).
 */
export async function backfillPresetEmbeddings(
  db: PrismaClient,
  embeddingProvider: IEmbeddingProvider,
  opts: {
    presetIds?: string[];
    /** Re-embed everything, ignoring the staleness check. */
    force?: boolean;
    onProgress?: (done: number, total: number, presetId: string) => void;
  } = {},
): Promise<BackfillResult> {
  // `embeddingText` is compared against a value computed per row in JS, which
  // SQL can't express — so select the candidates and decide here.
  const rows = await db.presetVersion.findMany({
    where: { active: true, ...(opts.presetIds ? { presetId: { in: opts.presetIds } } : {}) },
    select: {
      id: true,
      presetId: true,
      name: true,
      description: true,
      keywords: true,
      embeddingText: true,
    },
    orderBy: { presetId: 'asc' },
  });

  // Whether the vector column is populated can't come back through the typed
  // client either (Unsupported columns are omitted from the select), so ask
  // for it separately and join in memory.
  const populated = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "PresetVersion" WHERE embedding IS NOT NULL AND active = true`,
  );
  const hasVector = new Set(populated.map((r) => r.id));

  const result: BackfillResult = { missing: 0, stale: 0, embedded: 0, failed: [] };
  const todo: typeof rows = [];

  for (const row of rows) {
    if (!hasVector.has(row.id)) {
      result.missing++;
      todo.push(row);
    } else if (opts.force || row.embeddingText !== presetEmbeddingText(row)) {
      result.stale++;
      todo.push(row);
    }
  }

  let done = 0;
  for (const row of todo) {
    try {
      if (await embedVersionRow(db, row, embeddingProvider)) result.embedded++;
    } catch (err) {
      // One bad row must not abort the sweep — record it and keep going, so a
      // partial failure still leaves the rest of the library indexed.
      result.failed.push({ presetId: row.presetId, error: String((err as Error)?.message ?? err) });
    }
    opts.onProgress?.(++done, todo.length, row.presetId);
  }

  return result;
}

// ─── WS20-03: Post-delivery actuals entry ────────────────────────────────────

export type ActualsEntry = {
  presetId: string;
  role: 'DEV' | 'QA' | 'PM' | 'BA';
  actualHours: number;
  notes?: string;
};

/**
 * Store actual hours as a new PresetVersion with POST_DELIVERY_VALIDATION motivation.
 * Creates a new version recording real-world hours against the estimate.
 */
export async function recordActuals(
  db: PrismaClient,
  entry: ActualsEntry,
): Promise<{ version: number }> {
  // Get current active version
  const current = await db.presetVersion.findFirst({
    where: { presetId: entry.presetId, active: true },
  });

  if (!current) {
    throw new Error(`No active preset version found for presetId: ${entry.presetId}`);
  }

  // Deactivate current version
  await db.presetVersion.updateMany({
    where: { presetId: entry.presetId, active: true },
    data: { active: false },
  });

  const newVersion = current.version + 1;

  // Post-delivery dev actuals: we know the real TOTAL but not how it divided,
  // so keep the proportion this preset already records and rescale it to the
  // measured total. Falls back to the library ratio if the preset somehow has
  // no hours to take a proportion from.
  //
  // This used to be `beHours = actual; feHours = round(actual * 0.4)`, which
  // inflated measured, delivered hours by 40% — the calibration path made
  // things worse than not calibrating at all.
  let beActual = current.beHours;
  let feActual = current.feHours;
  if (entry.role === 'DEV') {
    const prior = current.beHours + current.feHours;
    const feShare = prior > 0 ? current.feHours / prior : LIBRARY_FE_SHARE;
    feActual = Math.round(entry.actualHours * feShare);
    beActual = Math.round(entry.actualHours - feActual);
  }

  await db.presetVersion.create({
    data: {
      presetId: entry.presetId,
      version: newVersion,
      active: true,
      category: current.category,
      name: current.name,
      description: current.description,
      beHours: beActual,
      feHours: feActual,
      platforms: current.platforms,
      reqType: current.reqType,
      keywords: current.keywords,
      userStoryTags: current.userStoryTags,
      projectSizeFit: current.projectSizeFit,
      integrationCount: current.integrationCount,
      dataVolume: current.dataVolume,
      phase: current.phase,
      requires: current.requires,
      blocks: current.blocks,
      canParallel: current.canParallel,
      aiAssist: current.aiAssist,
      risk: current.risk,
      spikeNeeded: current.spikeNeeded,
      notes: entry.notes ?? current.notes,
      taxonomyKey: current.taxonomyKey,
      changeMotivation: 'POST_DELIVERY_VALIDATION',
      sourceEstimateId: current.sourceEstimateId,
      changeReason: `Actuals for ${entry.role}: ${entry.actualHours}h`,
    },
  });

  return { version: newVersion };
}
