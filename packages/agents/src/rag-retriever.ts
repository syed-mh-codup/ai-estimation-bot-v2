import type { PrismaClient } from '@repo/db';
import { findNearestPresets } from '@repo/db';


export type RankedPreset = {
  presetId: string;
  presetVersion: number;
  name: string;
  devHours: number;
  touchesFrontend: boolean;
  touchesBackend: boolean;
  score: number;
};

/**
 * Find nearest presets by vector similarity using pgvector ANN.
 * Returns presets with cosine similarity score (0-1, higher = more similar).
 */
export async function queryPresetsByVector(
  db: PrismaClient,
  queryVector: number[],
  k = 5,
): Promise<RankedPreset[]> {
  const rows = await findNearestPresets(db, queryVector, k);

  return rows.map((r) => ({
    presetId: r.presetId,
    presetVersion: r.version,
    name: r.name,
    devHours: r.devHours,
    touchesFrontend: r.touchesFrontend,
    touchesBackend: r.touchesBackend,
    // findNearestPresets returns cosine distance; convert to similarity
    score: Math.max(0, Math.min(1, 1 - r.distance)),
  }));
}
