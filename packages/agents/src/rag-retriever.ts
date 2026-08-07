import type { PrismaClient } from '@repo/db';
import { findNearestPresets } from '@repo/db';

export type RankedTaxonomyNode = {
  nodeKey: string;
  label: string;
  keywords: string[];
  score: number;
};

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
 * Rank active taxonomy nodes by keyword overlap with the query text.
 * Returns all nodes, sorted by overlap score descending.
 */
export async function queryTaxonomyByText(
  db: PrismaClient,
  queryText: string,
): Promise<RankedTaxonomyNode[]> {
  const nodes = await db.taxonomyNodeVersion.findMany({
    where: { active: true },
    select: { nodeKey: true, label: true, keywords: true },
  });

  const queryTokens = queryText.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = nodes.map((n) => {
    const nodeTokens = [
      ...n.keywords.map((k) => k.toLowerCase()),
      ...n.label.toLowerCase().split(/\s+/),
      n.nodeKey.toLowerCase().split('.').join(' '),
    ];
    const hits = queryTokens.filter((t) => nodeTokens.some((nt) => nt.includes(t) || t.includes(nt)));
    const score = queryTokens.length > 0 ? hits.length / queryTokens.length : 0;
    return { nodeKey: n.nodeKey, label: n.label, keywords: n.keywords, score };
  });

  return scored.sort((a, b) => b.score - a.score);
}

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
