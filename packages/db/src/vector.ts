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
 * The retrieval surface (name + embedding) lives on `PresetRetrieval`; the
 * anchor (devHours, side flags) lives on `PresetAnchor`; the active filter and
 * version number on `PresetVersion`. The join is what reconstitutes a match.
 */
export async function findNearestPresets(
  db: PrismaClient,
  queryVector: number[],
  k = 5,
): Promise<PresetMatch[]> {
  const vectorLiteral = `[${queryVector.join(',')}]`;
  const rows = await db.$queryRawUnsafe<PresetMatch[]>(
    `SELECT v.id,
            r."presetId",
            v.version,
            r.name,
            a."devHours",
            a."touchesFrontend",
            a."touchesBackend",
            r.embedding <=> $1::vector AS distance
     FROM "PresetRetrieval" r
     JOIN "PresetVersion" v ON v."presetId" = r."presetId" AND v.active = true
     JOIN "PresetAnchor" a ON a."presetVersionId" = v.id
     WHERE r.embedding IS NOT NULL
     ORDER BY r.embedding <=> $1::vector
     LIMIT $2`,
    vectorLiteral,
    k,
  );
  return rows;
}
