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
 * Find top-k PresetVersions by cosine distance to the query vector.
 * Uses pgvector <=> operator (cosine distance) for ANN search.
 */
export async function findNearestPresets(
  db: PrismaClient,
  queryVector: number[],
  k = 5,
): Promise<PresetMatch[]> {
  const vectorLiteral = `[${queryVector.join(',')}]`;
  const rows = await db.$queryRawUnsafe<PresetMatch[]>(
    `SELECT id, "presetId", version, name, "devHours", "touchesFrontend", "touchesBackend",
            embedding <=> $1::vector AS distance
     FROM "PresetVersion"
     WHERE embedding IS NOT NULL AND active = true
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    vectorLiteral,
    k,
  );
  return rows;
}
