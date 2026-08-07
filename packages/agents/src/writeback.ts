import type { PrismaClient } from '@repo/db';
import type { IEmbeddingProvider } from '@repo/providers';
import type { MenuItem } from '@repo/shared';

// ─── WS20-01: Promote enabled menu items to PresetVersions ────────────────────

export type PromoteResult = {
  promoted: string[];  // preset IDs created/updated
  skipped: string[];   // already exists
};

/**
 * Finalise an estimate: promote each enabled menu item to a new PresetVersion.
 * Idempotent — re-finalising skips items already promoted from this estimate.
 */
export async function promoteMenuItemsToPresets(
  db: PrismaClient,
  estimateId: string,
  menuItems: MenuItem[],
): Promise<PromoteResult> {
  const enabled = menuItems.filter((m) => m.enabled);
  const promoted: string[] = [];
  const skipped: string[] = [];

  // Update estimate status to FINALISED
  await db.estimate.update({
    where: { id: estimateId },
    data: { status: 'FINALISED' },
  });

  for (const item of enabled) {
    // Skip baseline items (they're not real features)
    if (item.id.startsWith('baseline-') || item.id.startsWith('hidden-')) continue;

    const presetId = `promoted-${estimateId}-${item.id}`;

    // Check if already promoted from this estimate
    const existing = await db.presetVersion.findFirst({
      where: { presetId, sourceEstimateId: estimateId },
    });

    if (existing) {
      skipped.push(presetId);
      continue;
    }

    // Get next version number for this preset
    const latestVersion = await db.presetVersion.findFirst({
      where: { presetId },
      orderBy: { version: 'desc' },
    });
    const newVersion = (latestVersion?.version ?? 0) + 1;

    // Deactivate prior versions
    if (latestVersion) {
      await db.presetVersion.updateMany({
        where: { presetId },
        data: { active: false },
      });
    }

    // Ensure parent Preset record exists
    const presetExists = await db.preset.findUnique({ where: { id: presetId } });
    if (!presetExists) {
      await db.preset.create({ data: { id: presetId } });
    }

    // A role's DEV scope can now span several <=4h line items (FOUR-HOUR RULE
    // decomposition), so sum them rather than reading a single lump item.
    const devLineItems = item.lineItems.filter((l) => l.role === 'DEV');
    const beHours = devLineItems.reduce((s, l) => s + l.taxedHours, 0);
    const feHours = Math.round(beHours * 0.4); // approximate FE split

    await db.presetVersion.create({
      data: {
        presetId,
        version: newVersion,
        active: true,
        category: item.taxonomyKey.split('.')[0] ?? 'general',
        name: item.title,
        description: `Promoted from estimate ${estimateId}`,
        beHours,
        feHours,
        platforms: [],
        reqType: 'FEATURE',
        keywords: [item.taxonomyKey],
        userStoryTags: [],
        projectSizeFit: [],
        integrationCount: 0,
        dataVolume: 'LOW',
        phase: 'CORE',
        requires: [],
        blocks: [],
        canParallel: true,
        aiAssist: 'LOW',
        risk: 'LOW',
        spikeNeeded: false,
        notes: '',
        taxonomyKey: item.taxonomyKey,
        changeMotivation: 'OTHER',
        sourceEstimateId: estimateId,
      },
    });

    promoted.push(presetId);
  }

  return { promoted, skipped };
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

  // Adjust hours based on role
  const devActual = entry.role === 'DEV' ? entry.actualHours : current.beHours;
  const feActual = entry.role === 'DEV' ? Math.round(entry.actualHours * 0.4) : current.feHours;

  await db.presetVersion.create({
    data: {
      presetId: entry.presetId,
      version: newVersion,
      active: true,
      category: current.category,
      name: current.name,
      description: current.description,
      beHours: devActual,
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
