import { PrismaClient } from './generated/client/index.js';

export type PresetMatch = {
  id: string;
  presetId: string;
  version: number;
  name: string;
  devHours: number;
  touchesFrontend: boolean;
  touchesBackend: boolean;
  distance: number;
};

/**
 * Find top-k Presets by cosine distance to the query vector.
 * Uses pgvector <=> operator (cosine distance) for ANN search.
 *
 * The retrieval surface (name + embedding) lives on `PresetRetrieval`, the
 * anchor (devHours, side flags) on `PresetAnchor`, and both are one-per-version
 * keyed off `PresetVersion`. The join through the active version reconstitutes
 * a match.
 */
export async function findNearestPresets(
  db: PrismaClient,
  queryVector: number[],
  k = 5,
): Promise<PresetMatch[]> {
  const vectorLiteral = `[${queryVector.join(',')}]`;
  const rows = await db.$queryRawUnsafe<PresetMatch[]>(
    `SELECT v.id,
            v."presetId",
            v.version,
            r.name,
            a."devHours",
            a."touchesFrontend",
            a."touchesBackend",
            r.embedding <=> $1::vector AS distance
     FROM "PresetVersion" v
     JOIN "PresetRetrieval" r ON r."presetVersionId" = v.id
     JOIN "PresetAnchor" a ON a."presetVersionId" = v.id
     WHERE v.active = true AND r.embedding IS NOT NULL
     ORDER BY r.embedding <=> $1::vector
     LIMIT $2`,
    vectorLiteral,
    k,
  );
  return rows;
}

/**
 * Copy a preset's embedding and its source text onto a newly created version's
 * retrieval row, inside the caller's transaction.
 *
 * Every writer that creates a new PresetVersion must call this. The vector lives
 * on `PresetRetrieval`, which is one row per version, so a new version starts
 * with `embedding IS NULL` — and `findNearestPresets` filters on
 * `embedding IS NOT NULL AND v.active = true`. Skip the carry and the preset
 * silently drops out of Archivist retrieval the moment it is versioned: no
 * error, no match, and nothing to notice until someone asks why a preset stopped
 * matching. Doing it inside the caller's transaction is what closes the window —
 * the new version is never visible without a vector.
 *
 * `embeddingText` rides along unchanged on purpose. It records the text the
 * carried vector was built from, so when the new version's own text differs — an
 * edited name, or `recordActuals` writing new notes — that mismatch is exactly
 * what marks the vector stale and gets the row re-embedded by
 * `backfillPresetEmbeddings` or `pnpm db:embed:presets`. A stale vector keeps the
 * preset findable; no vector makes it disappear.
 *
 * Raw SQL because Prisma's typed client cannot read or write an
 * `Unsupported("vector")` column.
 */
export async function carryPresetVector(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  fromRetrievalId: string,
  toPresetVersionId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `UPDATE "PresetRetrieval" AS target
        SET embedding = source.embedding, "embeddingText" = source."embeddingText"
       FROM "PresetRetrieval" AS source
      WHERE target."presetVersionId" = $1 AND source.id = $2`,
    toPresetVersionId,
    fromRetrievalId,
  );
}
