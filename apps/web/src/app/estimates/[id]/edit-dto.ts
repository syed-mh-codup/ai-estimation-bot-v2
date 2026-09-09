import type { LockScope, RoleKind } from '@repo/db';

/**
 * Shapes for the steered-edit surface — AEH-238.
 *
 * Separate from `edit-actions.ts` for the reason that module cannot hold them:
 * a `'use server'` file may export only async functions, and one synchronous
 * export there fails the build of every route importing anything from it. See
 * AEH-253, and the `dto.ts` / `lock-dto.ts` pair alongside.
 *
 * Everything here crosses to the client, so: plain objects, ISO strings, no
 * `Date`. And nothing here is a snapshot — the payloads stay on the server,
 * read only by a revert.
 */

export type LedgerEditStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'PENDING_CONFLICT'
  | 'APPLIED'
  | 'REVERTED'
  | 'DISCARDED'
  | 'FAILED';

/** One steered edit as the ledger renders it. */
export type LedgerEditDTO = {
  id: string;
  status: LedgerEditStatus;
  /** Human-readable progress, e.g. "Re-pricing DEV on Checkout". */
  stage: string | null;
  pct: number;
  error: string | null;
  /** What the person asked for, verbatim. */
  prompt: string;
  /** What the council said it did, collated across the slices. */
  reasoning: string | null;
  roles: RoleKind[];
  scope: LockScope;
  /** The cards the envelope covered, so the ledger can badge them. */
  cardIds: string[];
  rowsBefore: number | null;
  rowsAfter: number | null;
  hoursBefore: number | null;
  hoursAfter: number | null;
  overwroteConflict: boolean;
  createdAt: string;
  appliedAt: string | null;
  revertedAt: string | null;
  /** True when the viewer is the person who asked for it. */
  mine: boolean;
};

/** Still working, so the ledger should keep polling. */
export function isEditInFlight(e: LedgerEditDTO): boolean {
  return e.status === 'QUEUED' || e.status === 'RUNNING';
}

/** Applied, not yet put back, and therefore revertible. */
export function isRevertible(e: LedgerEditDTO): boolean {
  return e.status === 'APPLIED';
}

/**
 * The hours this edit moved, or null when it has not landed.
 *
 * Signed on purpose: "+18h" and "-6h" are different news, and a reviewer
 * skimming a list of edits is looking for the big movers in either direction.
 */
export function hoursDelta(e: LedgerEditDTO): number | null {
  if (e.hoursBefore === null || e.hoursAfter === null) return null;
  return Math.round((e.hoursAfter - e.hoursBefore) * 100) / 100;
}
