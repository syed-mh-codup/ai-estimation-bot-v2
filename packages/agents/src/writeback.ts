import { allocatePresetCode, carryPresetVector, toMenuItem, type PrismaClient } from '@repo/db';
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

    // The prior state for carry lives across the version shell plus all three
    // concern tables now. `carry` is the latest version's anchor+retrieval+composition,
    // and it must come from a version that actually exists — a strong match whose
    // latest version has no anchor/retrieval is a half-written row (see the
    // transaction below), not licence to clobber the preset's retrieval surface.
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
            projectSizeFit: true,
            integrationCount: true,
            dataVolume: true,
            phase: true,
            aiAssist: true,
            risk: true,
            spikeNeeded: true,
            taxonomyKey: true,
          },
        },
        retrieval: {
          select: { id: true, name: true, description: true, keywords: true, notes: true, userStoryTags: true },
        },
        composition: {
          select: { requires: true, blocks: true, canParallel: true },
        },
      },
    });
    const newVersion = (latestVersion?.version ?? 0) + 1;

    const effort = devEffortOf(item.lineItems);

    // Versioning a real preset: keep its taxonomy/metadata and change only what
    // this estimate actually evidences. Minting one: derive what we can. Carry is
    // only valid when the matched preset's latest version is complete — a strong
    // match whose latest version lacks an anchor/retrieval is a half-written row,
    // not licence to clobber the preset's retrieval surface.
    const carryAnchor = strongMatch ? latestVersion?.anchor ?? null : null;
    const carryRetrieval = strongMatch ? latestVersion?.retrieval ?? null : null;
    const carryComposition = strongMatch ? latestVersion?.composition ?? null : null;

    // One transaction: deactivate → create version → create anchor/retrieval/
    // composition. Without it there is a version→anchor gap where an active
    // version exists but the preset vanishes from search and the editor 404s.
    await db.$transaction(async (tx) => {
      if (latestVersion) {
        await tx.presetVersion.updateMany({ where: { presetId }, data: { active: false } });
      }

      const version = await tx.presetVersion.create({
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

      await tx.presetAnchor.create({
        data: {
          presetVersionId: version.id,
          category: carryAnchor?.category ?? item.taxonomyKey.split('.')[0] ?? 'general',
          devHours: effort.devHours,
          // Flags come from this estimate only when it actually tagged something.
          // Otherwise carry the prior version's — same rule as keywords and risk:
          // change only what this estimate evidences. Without this, promoting an
          // untagged card onto a matched preset would erase its flags.
          touchesFrontend: effort.tagged ? effort.touchesFrontend : (carryAnchor?.touchesFrontend ?? false),
          touchesBackend: effort.tagged ? effort.touchesBackend : (carryAnchor?.touchesBackend ?? false),
          // Legacy split: never written going forward. NULL means "not tracked".
          beHours: null,
          feHours: null,
          platforms: carryAnchor?.platforms ?? [],
          reqType: carryAnchor?.reqType ?? 'FEATURE',
          projectSizeFit: carryAnchor?.projectSizeFit ?? [],
          integrationCount: carryAnchor?.integrationCount ?? 0,
          dataVolume: carryAnchor?.dataVolume ?? 'LOW',
          phase: carryAnchor?.phase ?? 'CORE',
          aiAssist: carryAnchor?.aiAssist ?? 'LOW',
          risk: carryAnchor?.risk ?? 'LOW',
          spikeNeeded: carryAnchor?.spikeNeeded ?? false,
          taxonomyKey: carryAnchor?.taxonomyKey ?? item.taxonomyKey,
        },
      });

      // Retrieval surface: one per version. A strong match carries the prior
      // name/description/keywords/notes/userStoryTags forward (they are what made
      // it match); minting a new preset derives them from the card.
      await tx.presetRetrieval.create({
        data: {
          presetVersionId: version.id,
          name: carryRetrieval?.name ?? item.title,
          description: carryRetrieval?.description ?? `Promoted from estimate ${estimateId}`,
          keywords: carryRetrieval?.keywords ?? [item.taxonomyKey],
          notes: carryRetrieval?.notes ?? '',
          userStoryTags: carryRetrieval?.userStoryTags ?? [],
        },
      });

      // Carry the prior version's vector onto the new retrieval row, in this
      // transaction. Gated on a prior retrieval row rather than on `strongMatch`:
      // a minted preset has nothing to carry and gets its first vector from the
      // backfill. See carryPresetVector for why skipping this de-indexes the
      // preset the moment it is versioned.
      if (latestVersion?.retrieval) {
        await carryPresetVector(tx, latestVersion.retrieval.id, version.id);
      }

      // Composition: one per version, carried forward from the prior version.
      await tx.presetComposition.create({
        data: {
          presetVersionId: version.id,
          requires: carryComposition?.requires ?? [],
          blocks: carryComposition?.blocks ?? [],
          canParallel: carryComposition?.canParallel ?? true,
        },
      });
    });

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
 * All five fields live on `PresetRetrieval` — the retrieval surface is
 * self-contained by construction, so a row's own embedding text is computable
 * from the row alone with no join to a sibling table. The function stays flat
 * and the concatenation order is the one contract that must never silently
 * drift.
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
  // The retrieval surface is self-contained now — name, description, keywords,
  // userStoryTags and notes all live on the row. Select active versions' retrieval
  // rows and compare the computed text in JS — SQL can't express that concatenation.
  const rows = await db.presetRetrieval.findMany({
    where: {
      presetVersion: {
        active: true,
        ...(opts.presetIds ? { presetId: { in: opts.presetIds } } : {}),
      },
    },
    select: {
      id: true,
      name: true,
      description: true,
      keywords: true,
      notes: true,
      userStoryTags: true,
      embeddingText: true,
      presetVersion: { select: { presetId: true } },
    },
    orderBy: { presetVersion: { presetId: 'asc' } },
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
    const candidate = {
      retrievalId: row.id,
      presetId: row.presetVersion.presetId,
      name: row.name,
      description: row.description,
      keywords: row.keywords,
      notes: row.notes,
      userStoryTags: row.userStoryTags,
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
  // Get current active version + its full anchor, retrieval and composition.
  const current = await db.presetVersion.findFirst({
    where: { presetId: entry.presetId, active: true },
    select: {
      version: true,
      sourceEstimateId: true,
      anchor: true,
      retrieval: true,
      composition: true,
    },
  });

  if (!current?.anchor || !current.retrieval || !current.composition) {
    throw new Error(`No active preset version found for presetId: ${entry.presetId}`);
  }
  const anchor = current.anchor;
  const retrieval = current.retrieval;
  const composition = current.composition;

  const newVersion = current.version + 1;

  // Post-delivery dev actuals go in whole. There is no split to reconstruct
  // any more, which is what made this path dangerous before: it used to store
  // `beHours = actual; feHours = round(actual * 0.4)`, inflating *measured*
  // delivered hours by 40% — the calibration path made the library worse than
  // not calibrating at all.
  const devActual = entry.role === 'DEV' ? Math.round(entry.actualHours) : anchor.devHours;

  // One transaction so the new version and its three concern rows appear (or
  // don't) together — no version→anchor gap that makes the preset vanish.
  await db.$transaction(async (tx) => {
    await tx.presetVersion.updateMany({
      where: { presetId: entry.presetId, active: true },
      data: { active: false },
    });

    const version = await tx.presetVersion.create({
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

    await tx.presetAnchor.create({
      data: {
        presetVersionId: version.id,
        devHours: devActual,
        touchesFrontend: anchor.touchesFrontend,
        touchesBackend: anchor.touchesBackend,
        beHours: null,
        feHours: null,
        platforms: anchor.platforms,
        reqType: anchor.reqType,
        projectSizeFit: anchor.projectSizeFit,
        integrationCount: anchor.integrationCount,
        dataVolume: anchor.dataVolume,
        phase: anchor.phase,
        aiAssist: anchor.aiAssist,
        risk: anchor.risk,
        spikeNeeded: anchor.spikeNeeded,
        taxonomyKey: anchor.taxonomyKey,
        category: anchor.category,
      },
    });

    // Retrieval and composition are cloned verbatim — an actuals entry changes
    // only the anchor's hours, never how the preset is found or sequenced.
    await tx.presetRetrieval.create({
      data: {
        presetVersionId: version.id,
        name: retrieval.name,
        description: retrieval.description,
        keywords: retrieval.keywords,
        notes: entry.notes ?? retrieval.notes,
        userStoryTags: retrieval.userStoryTags,
      },
    });

    // An actuals entry that carries new notes changes the embedding text, so the
    // carried vector lands stale by design — the embeddingText mismatch is what
    // queues it for re-embedding. Stale and findable beats absent.
    await carryPresetVector(tx, retrieval.id, version.id);

    await tx.presetComposition.create({
      data: {
        presetVersionId: version.id,
        requires: composition.requires,
        blocks: composition.blocks,
        canParallel: composition.canParallel,
      },
    });
  });

  return { version: newVersion };
}
