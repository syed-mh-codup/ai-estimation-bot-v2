import { allocatePresetCode, toMenuItem, type PrismaClient } from '@repo/db';
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

    // The prior state for carry lives across three tables now: the version shell
    // (for version number), the anchor (for taxonomy/metadata), the retrieval
    // surface (name/description/keywords) and the composition (requires/blocks).
    const latestVersion = await db.presetVersion.findFirst({
      where: { presetId },
      orderBy: { version: 'desc' },
      select: {
        version: true,
        anchor: {
          select: {
            category: true,
            devHours: true,
            touchesFrontend: true,
            touchesBackend: true,
            platforms: true,
            reqType: true,
            userStoryTags: true,
            projectSizeFit: true,
            integrationCount: true,
            dataVolume: true,
            phase: true,
            aiAssist: true,
            risk: true,
            spikeNeeded: true,
            notes: true,
            taxonomyKey: true,
          },
        },
      },
    });
    const [retrieval, composition] = await Promise.all([
      db.presetRetrieval.findUnique({ where: { presetId } }),
      db.presetComposition.findUnique({ where: { presetId } }),
    ]);
    const newVersion = (latestVersion?.version ?? 0) + 1;

    if (latestVersion) {
      await db.presetVersion.updateMany({ where: { presetId }, data: { active: false } });
    }

    const effort = devEffortOf(item.lineItems);

    // Versioning a real preset: keep its taxonomy/metadata and change only what
    // this estimate actually evidences. Minting one: derive what we can.
    const carry = strongMatch ? latestVersion?.anchor : null;

    const version = await db.presetVersion.create({
      data: {
        presetId,
        version: newVersion,
        active: true,
        changeMotivation: 'POST_DELIVERY_VALIDATION',
        sourceEstimateId: estimateId,
        sourceMenuItemId: item.id,
        changeReason: strongMatch
          ? `Recalibrated from finalised estimate ${estimateId} (match ${(item.matchScore ?? 0).toFixed(2)}) — ${describeSides(effort)}`
          : `Promoted from finalised estimate ${estimateId} — ${describeSides(effort)}`,
      },
      select: { id: true },
    });

    await db.presetAnchor.create({
      data: {
        presetVersionId: version.id,
        category: carry?.category ?? item.taxonomyKey.split('.')[0] ?? 'general',
        devHours: effort.devHours,
        // Flags come from this estimate only when it actually tagged something.
        // Otherwise carry the prior version's — same rule as keywords and risk:
        // change only what this estimate evidences. Without this, promoting an
        // untagged card onto a matched preset would erase its flags.
        touchesFrontend: effort.tagged ? effort.touchesFrontend : (carry?.touchesFrontend ?? false),
        touchesBackend: effort.tagged ? effort.touchesBackend : (carry?.touchesBackend ?? false),
        // Legacy split: never written going forward. NULL means "not tracked".
        beHours: null,
        feHours: null,
        platforms: carry?.platforms ?? [],
        reqType: carry?.reqType ?? 'FEATURE',
        userStoryTags: carry?.userStoryTags ?? [],
        projectSizeFit: carry?.projectSizeFit ?? [],
        integrationCount: carry?.integrationCount ?? 0,
        dataVolume: carry?.dataVolume ?? 'LOW',
        phase: carry?.phase ?? 'CORE',
        aiAssist: carry?.aiAssist ?? 'LOW',
        risk: carry?.risk ?? 'LOW',
        spikeNeeded: carry?.spikeNeeded ?? false,
        notes: carry?.notes ?? '',
        taxonomyKey: carry?.taxonomyKey ?? item.taxonomyKey,
      },
    });

    // Retrieval surface: one per preset. On a strong match we keep the prior
    // name/description/keywords (they are what made it match); minting a new
    // preset derives them from the card title and taxonomy key.
    if (retrieval) {
      await db.presetRetrieval.update({
        where: { presetId },
        data: carry
          ? {}
          : {
              name: item.title,
              description: `Promoted from estimate ${estimateId}`,
              keywords: [item.taxonomyKey],
            },
      });
    } else {
      await db.presetRetrieval.create({
        data: {
          presetId,
          name: item.title,
          description: `Promoted from estimate ${estimateId}`,
          keywords: [item.taxonomyKey],
        },
      });
    }

    // Composition: update in place (one per preset), carrying prior rules forward.
    if (composition) {
      await db.presetComposition.update({ where: { presetId }, data: {} });
    } else {
      await db.presetComposition.create({
        data: { presetId, requires: [], blocks: [], canParallel: true },
      });
    }

    promoted.push(presetId);
    (strongMatch ? versioned : created).push(presetId);
  }

  return { promoted, skipped, versioned, created };
}

/**
 * Promote a finalised estimate straight from its persisted rows.
 *
 * The read-and-map half of promotion, which used to live inline inside the
 * Inngest step closure and was therefore unreachable from a test. That is the
 * seam the WBS/preset round trip has to enter through: the Prisma row to
 * `MenuItem` mapping below is hand-written, so it is precisely where a renamed
 * or dropped field goes quietly missing.
 */
export async function promoteEstimate(
  db: PrismaClient,
  estimateId: string,
): Promise<PromoteResult> {
  const est = await db.estimate.findUnique({
    where: { id: estimateId },
    // Injected cards are NOT excluded any more.
    //
    // AEH-227 excluded every `injected` row, correctly: back then an injected
    // card carried invented flat hours, and letting that into the library would
    // have poisoned the anchor every future estimate reads. Those hours are now
    // the Specialist council's, produced the same way as any other card's.
    //
    // Promotion still only ever sees a FINALISED estimate, and only `enabled`
    // cards survive the filter in promoteMenuItemsToPresets. That is the human
    // acceptance: an estimator who finalises with an inferred card present and
    // switched on has reviewed it and stood behind it — they could have deleted
    // or disabled it, and disabling is exactly how they say no. So the library
    // finally learns what rate limiting and data migrations actually cost,
    // instead of re-deriving them from first principles on every estimate.
    //
    // `injected` stays true on the row forever regardless: it is what makes
    // "work we inferred" versus "work they asked for" answerable later. AEH-263.
    include: { menuItems: { include: { lineItems: true } } },
  });
  if (!est) return { promoted: [], skipped: [], versioned: [], created: [] };

  const items: MenuItem[] = est.menuItems.map(toMenuItem);

  return promoteMenuItemsToPresets(db, estimateId, items);
}

// ─── WS20-02: Generate + store embeddings for promoted rows ───────────────────

/**
 * The one definition of what a preset "means" to the Archivist. Every writer
 * of `embedding` must go through this, so `embeddingText` is always literally
 * the string that produced the vector sitting next to it.
 *
 * After AEH-244 the fields come from two places: `name`, `description` and
 * `keywords` from `PresetRetrieval` (the retrieval surface), and `notes` +
 * `userStoryTags` from `PresetAnchor` (the estimate anchor). The function
 * itself stays flat so callers gather the pieces and pass them here — the
 * concatenation order is the one contract that must never silently drift.
 */
export function presetEmbeddingText(v: {
  name: string;
  description: string;
  keywords: string[];
  notes: string;
  userStoryTags: string[];
}): string {
  // `notes` and `userStoryTags` carry meaning the other three don't. Notes is
  // where an admin writes what a preset actually assumes and excludes ("P21
  // order history API must be available", "template-level only, formal audit
  // excluded"); userStoryTags names whose journey the work serves. Both were
  // written on every preset and read by nothing — including, until now, the one
  // function that decides what a preset MEANS to the matcher. AEH-253.
  return [v.name, v.description, ...v.keywords, ...v.userStoryTags, v.notes].join(' ');
}

/** Embed one retrieval row and store the vector alongside its source text. */
async function embedRetrievalRow(
  db: PrismaClient,
  row: {
    retrievalId: string;
    name: string;
    description: string;
    keywords: string[];
    notes: string;
    userStoryTags: string[];
  },
  embeddingProvider: IEmbeddingProvider,
): Promise<boolean> {
  const text = presetEmbeddingText(row);
  const [vector] = await embeddingProvider.embed(text);
  if (!vector) return false;

  // Prisma's typed client can't write an Unsupported("vector") column, so the
  // cast has to happen in raw SQL. embeddingText rides the same statement —
  // the two must never disagree. The vector lives on PresetRetrieval now.
  await db.$executeRawUnsafe(
    `UPDATE "PresetRetrieval" SET embedding = $1::vector, "embeddingText" = $2 WHERE id = $3`,
    `[${vector.join(',')}]`,
    text,
    row.retrievalId,
  );
  return true;
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
  // The retrieval surface lives on PresetRetrieval; the anchor's notes and
  // userStoryTags (which also feed the embedding text) live on PresetAnchor.
  // Select retrieval rows joined to the active version's anchor, then compare
  // the computed text in JS — SQL can't express that concatenation.
  const rows = await db.presetRetrieval.findMany({
    where: {
      preset: {
        versions: { some: { active: true } },
        ...(opts.presetIds ? { id: { in: opts.presetIds } } : {}),
      },
    },
    select: {
      id: true,
      presetId: true,
      name: true,
      description: true,
      keywords: true,
      embeddingText: true,
      preset: {
        select: {
          versions: {
            where: { active: true },
            select: {
              anchor: {
                select: { notes: true, userStoryTags: true },
              },
            },
            take: 1,
          },
        },
      },
    },
    orderBy: { presetId: 'asc' },
  });

  // Whether the vector column is populated can't come back through the typed
  // client either (Unsupported columns are omitted from the select), so ask
  // for it separately and join in memory.
  const populated = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "PresetRetrieval" WHERE embedding IS NOT NULL`,
  );
  const hasVector = new Set(populated.map((r) => r.id));

  const result: BackfillResult = { missing: 0, stale: 0, embedded: 0, failed: [] };
  const todo: Array<{
    retrievalId: string;
    presetId: string;
    name: string;
    description: string;
    keywords: string[];
    notes: string;
    userStoryTags: string[];
  }> = [];

  for (const row of rows) {
    const anchor = row.preset.versions[0]?.anchor;
    const candidate = {
      retrievalId: row.id,
      presetId: row.presetId,
      name: row.name,
      description: row.description,
      keywords: row.keywords,
      notes: anchor?.notes ?? '',
      userStoryTags: anchor?.userStoryTags ?? [],
    };
    if (!hasVector.has(row.id)) {
      result.missing++;
      todo.push(candidate);
    } else if (opts.force || row.embeddingText !== presetEmbeddingText(candidate)) {
      result.stale++;
      todo.push(candidate);
    }
  }

  let done = 0;
  for (const row of todo) {
    try {
      if (await embedRetrievalRow(db, row, embeddingProvider)) result.embedded++;
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
  // Get current active version + its full anchor (the anchor is where the hours
  // and everything else that carries forward live).
  const current = await db.presetVersion.findFirst({
    where: { presetId: entry.presetId, active: true },
    select: {
      version: true,
      sourceEstimateId: true,
      anchor: true,
    },
  });

  if (!current?.anchor) {
    throw new Error(`No active preset version found for presetId: ${entry.presetId}`);
  }

  const prevAnchor = current.anchor;

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
  const devActual = entry.role === 'DEV' ? Math.round(entry.actualHours) : prevAnchor.devHours;

  const version = await db.presetVersion.create({
    data: {
      presetId: entry.presetId,
      version: newVersion,
      active: true,
      changeMotivation: 'POST_DELIVERY_VALIDATION',
      sourceEstimateId: current.sourceEstimateId,
      changeReason: `Actuals for ${entry.role}: ${entry.actualHours}h`,
    },
    select: { id: true },
  });

  // Clone the anchor for this version, changing only the dev hours (and notes
  // when provided). The retrieval surface and composition are one-per-preset
  // and carry over untouched.
  await db.presetAnchor.create({
    data: {
      presetVersionId: version.id,
      devHours: devActual,
      touchesFrontend: prevAnchor.touchesFrontend,
      touchesBackend: prevAnchor.touchesBackend,
      beHours: null,
      feHours: null,
      platforms: prevAnchor.platforms,
      reqType: prevAnchor.reqType,
      userStoryTags: prevAnchor.userStoryTags,
      projectSizeFit: prevAnchor.projectSizeFit,
      integrationCount: prevAnchor.integrationCount,
      dataVolume: prevAnchor.dataVolume,
      phase: prevAnchor.phase,
      aiAssist: prevAnchor.aiAssist,
      risk: prevAnchor.risk,
      spikeNeeded: prevAnchor.spikeNeeded,
      notes: entry.notes ?? prevAnchor.notes,
      taxonomyKey: prevAnchor.taxonomyKey,
      category: prevAnchor.category,
    },
  });

  return { version: newVersion };
}
