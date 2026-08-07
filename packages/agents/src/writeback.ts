import type { PrismaClient } from '@repo/db';
import { allocatePresetCode } from '@repo/db';
import type { IEmbeddingProvider } from '@repo/providers';
import type { MenuItem, RoleLineItem } from '@repo/shared';

// ─── Dev hours → a preset's single devHours figure ────────────────────────────

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

export type DevEffort = {
  /** The card's dev effort as one figure — never divided. */
  devHours: number;
  touchesFrontend: boolean;
  touchesBackend: boolean;
  /** False when no DEV row carried a side tag, so flags can't be trusted. */
  tagged: boolean;
};

/**
 * A card's DEV effort, as one number plus which sides it covered.
 *
 * There is no ratio here and no arithmetic beyond a sum. That is the point:
 * frontend and backend are estimated together because delivery is full-stack,
 * so the flags are reference metadata rather than a basis for dividing hours.
 *
 * What this replaced: `beHours = Σ DEV; feHours = round(beHours * 0.4)` — which
 * assigned all of DEV to backend and then ADDED 40% on top, storing 1.4x the
 * estimate. Promoted presets become the next estimate's anchor, so that
 * compounded (100h → 140 → 196 → 274). The interim fix partitioned the total
 * using a library ratio; consolidating to one figure removes even that
 * approximation.
 */
export function devEffortOf(lineItems: RoleLineItem[]): DevEffort {
  const dev = lineItems.filter((l) => l.role === 'DEV');
  return {
    devHours: Math.round(dev.reduce((s, l) => s + l.taxedHours, 0)),
    touchesFrontend: dev.some((l) => l.touchesFrontend),
    touchesBackend: dev.some((l) => l.touchesBackend),
    tagged: dev.some((l) => l.touchesFrontend || l.touchesBackend),
  };
}

/** Human-readable provenance for the flags, for `changeReason`. */
function describeSides(e: DevEffort): string {
  if (!e.tagged) return 'no side tags on the dev items — flags left as-is';
  if (e.touchesFrontend && e.touchesBackend) return 'covers frontend and backend';
  return e.touchesBackend ? 'backend only' : 'frontend only';
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

    // Already promoted from this estimate — don't stack duplicate versions on a
    // re-finalise. Keyed on (estimate, menu item) rather than on a synthesised
    // preset id: ids are cuids now, so there is nothing to reconstruct.
    const existing = await db.presetVersion.findFirst({
      where: { sourceEstimateId: estimateId, sourceMenuItemId: item.id },
      select: { presetId: true },
    });
    if (existing) {
      skipped.push(existing.presetId);
      continue;
    }

    // Hybrid: version the matched preset only on a confident match.
    const strongMatch =
      item.sourcePresetId && (item.matchScore ?? 0) >= PROMOTION_MATCH_THRESHOLD
        ? item.sourcePresetId
        : null;

    let presetId: string;
    if (strongMatch) {
      presetId = strongMatch;
    } else {
      // A brand-new preset: cuid id, and a readable code allocated from the
      // sequence so nothing has to pick a number. origin records that this came
      // from delivered work — the code prefix is uniform (P) on purpose, so
      // provenance is a queryable column rather than a string match.
      const created = await db.preset.create({
        data: { code: await allocatePresetCode(db), origin: 'FINALISED' },
        select: { id: true },
      });
      presetId = created.id;
    }

    const latestVersion = await db.presetVersion.findFirst({
      where: { presetId },
      orderBy: { version: 'desc' },
    });
    const newVersion = (latestVersion?.version ?? 0) + 1;

    if (latestVersion) {
      await db.presetVersion.updateMany({ where: { presetId }, data: { active: false } });
    }

    const effort = devEffortOf(item.lineItems);

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
        devHours: effort.devHours,
        // Flags come from this estimate only when it actually tagged something.
        // Otherwise carry the prior version's — same rule as keywords and risk:
        // change only what this estimate evidences. Without this, promoting an
        // untagged card onto a matched preset would erase its flags.
        touchesFrontend: effort.tagged ? effort.touchesFrontend : (carry?.touchesFrontend ?? false),
        touchesBackend: effort.tagged ? effort.touchesBackend : (carry?.touchesBackend ?? false),
        // Legacy split: never written going forward. NULL means "not tracked",
        // which is the truth — 0 would claim there was no work on that side.
        beHours: null,
        feHours: null,
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
        sourceMenuItemId: item.id,
        changeReason: strongMatch
          ? `Recalibrated from finalised estimate ${estimateId} (match ${(item.matchScore ?? 0).toFixed(2)}) — ${describeSides(effort)}`
          : `Promoted from finalised estimate ${estimateId} — ${describeSides(effort)}`,
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

  // Post-delivery dev actuals go in whole. There is no split to reconstruct
  // any more, which is what made this path dangerous before: it used to store
  // `beHours = actual; feHours = round(actual * 0.4)`, inflating *measured*
  // delivered hours by 40% — the calibration path made the library worse than
  // not calibrating at all.
  const devActual = entry.role === 'DEV' ? Math.round(entry.actualHours) : current.devHours;

  await db.presetVersion.create({
    data: {
      presetId: entry.presetId,
      version: newVersion,
      active: true,
      category: current.category,
      name: current.name,
      description: current.description,
      devHours: devActual,
      touchesFrontend: current.touchesFrontend,
      touchesBackend: current.touchesBackend,
      beHours: null,
      feHours: null,
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
