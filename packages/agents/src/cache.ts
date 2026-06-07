import { createHash } from 'crypto';
import type { PrismaClient } from '@repo/db';

export type CacheKey = {
  sowHash: string;
  taxonomyVersionsPinned: Record<string, unknown>;
  configVersion: number;
  promptVersionsPinned: Record<string, unknown>;
  modelConfig: Record<string, unknown>;
};

/**
 * Compute a deterministic cache key from all the pinned inputs.
 * Identical inputs → identical key → cached result.
 */
export function computeCacheKey(params: CacheKey): string {
  const normalised = JSON.stringify({
    s: params.sowHash,
    tv: params.taxonomyVersionsPinned,
    cv: params.configVersion,
    pv: params.promptVersionsPinned,
    mc: params.modelConfig,
  });
  return createHash('sha256').update(normalised).digest('hex');
}

/**
 * Look up an existing estimate by cache key.
 * Returns the estimate ID if found, null if cache miss.
 */
export async function cacheGet(
  db: PrismaClient,
  key: CacheKey,
): Promise<string | null> {
  const cacheHash = computeCacheKey(key);

  const est = await db.estimate.findFirst({
    where: {
      sowHash: key.sowHash,
      status: { not: 'DRAFT' },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      taxonomyVersionsPinned: true,
      configVersion: true,
      promptVersionsPinned: true,
      modelConfig: true,
    },
  });

  if (!est) return null;

  const existingKey = computeCacheKey({
    sowHash: key.sowHash,
    taxonomyVersionsPinned: est.taxonomyVersionsPinned as Record<string, unknown>,
    configVersion: est.configVersion,
    promptVersionsPinned: est.promptVersionsPinned as Record<string, unknown>,
    modelConfig: est.modelConfig as Record<string, unknown>,
  });

  if (existingKey === cacheHash) return est.id;
  return null;
}

/** In-memory cache for within-process deduplication (test + hot-path). */
const memCache = new Map<string, string>();

export function memCachePut(key: CacheKey, estimateId: string): void {
  memCache.set(computeCacheKey(key), estimateId);
}

export function memCacheGet(key: CacheKey): string | undefined {
  return memCache.get(computeCacheKey(key));
}

export function memCacheClear(): void {
  memCache.clear();
}
