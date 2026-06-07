import type { PrismaClient } from '@repo/db';
import type {
  SupervisorInput,
  SupervisorOutput,
  LibrarianOutput,
  ArchivistOutput,
  ArchitectOutput,
} from '@repo/shared';
import { SupervisorOutputSchema } from '@repo/shared';
import { hashSOW, normaliseSOW } from './sow-utils';
import { cacheGet, memCacheGet, memCachePut, type CacheKey } from './cache';
import { withRetry } from './step-error';

// ─── Agent stub functions (implementations live in WS9–WS16) ─────────────────

export type LibrarianFn = (sowText: string, estimateId: string) => Promise<LibrarianOutput>;
export type ArchivistFn = (lib: LibrarianOutput, estimateId: string) => Promise<ArchivistOutput>;
export type ArchitectFn = (
  lib: LibrarianOutput,
  arch: ArchivistOutput,
  estimateId: string,
) => Promise<ArchitectOutput>;

export type SupervisorDeps = {
  db: PrismaClient;
  librarian: LibrarianFn;
  archivist: ArchivistFn;
  architect: ArchitectFn;
};

export type AgentStateSnapshot = {
  librarianOutput?: LibrarianOutput;
  archivistOutput?: ArchivistOutput;
  architectOutput?: ArchitectOutput;
};

/**
 * Supervisor skeleton: orchestrates Librarian → Archivist → Architect,
 * with SOW hashing, cache lookup, and state persistence.
 */
export async function runSupervisor(
  input: SupervisorInput,
  deps: SupervisorDeps,
): Promise<SupervisorOutput> {
  const { db, librarian, archivist, architect } = deps;
  const { estimateId, sowText, mode } = input;

  const normSOW = normaliseSOW(sowText);
  const sowHash = hashSOW(normSOW);

  const est = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });

  const cacheKey: CacheKey = {
    sowHash,
    taxonomyVersionsPinned: est.taxonomyVersionsPinned as Record<string, unknown>,
    configVersion: est.configVersion,
    promptVersionsPinned: est.promptVersionsPinned as Record<string, unknown>,
    modelConfig: est.modelConfig as Record<string, unknown>,
  };

  // ── Cache check (full mode only) ───────────────────────────────────────────
  if (mode === 'full') {
    const memHit = memCacheGet(cacheKey);
    if (memHit) {
      return SupervisorOutputSchema.parse({ estimateId: memHit, status: 'REVIEW' });
    }
    const dbHit = await cacheGet(db, cacheKey);
    if (dbHit) {
      memCachePut(cacheKey, dbHit);
      return SupervisorOutputSchema.parse({ estimateId: dbHit, status: 'REVIEW' });
    }
  }

  // ── Load prior agentState for refine mode ──────────────────────────────────
  let priorState: AgentStateSnapshot = {};
  if (mode === 'refine') {
    priorState = (est.agentState as AgentStateSnapshot) ?? {};
  }

  // ── Pipeline execution ─────────────────────────────────────────────────────
  const libOut = await withRetry('LIBRARIAN', () => librarian(sowText, estimateId));

  const archOut = await withRetry('ARCHIVIST', () => archivist(libOut, estimateId));

  const arcOut = await withRetry('ARCHITECT', () =>
    architect(libOut, archOut, estimateId),
  );

  // ── Persist state ──────────────────────────────────────────────────────────
  const newState: AgentStateSnapshot = {
    ...priorState,
    librarianOutput: libOut,
    archivistOutput: archOut,
    architectOutput: arcOut,
  };

  await db.estimate.update({
    where: { id: estimateId },
    data: {
      sowHash,
      status: 'REVIEW',
      narrative: arcOut.narrative,
      assumptions: arcOut.assumptions,
      agentState: newState,
    },
  });

  memCachePut(cacheKey, estimateId);

  return SupervisorOutputSchema.parse({ estimateId, status: 'REVIEW' });
}
