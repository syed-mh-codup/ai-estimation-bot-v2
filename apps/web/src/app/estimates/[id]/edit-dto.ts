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

/**
 * What was asked for.
 *
 * `RESTRUCTURE` re-prices what comes out of the reshape, because cutting a
 * module in two re-conceives the work. `RESTRUCTURE_KEEP_HOURS` is the opt-in
 * for a pure reorganisation. `REVISE_STATEMENTS` changes words and cannot reach
 * an hour or a card at all.
 */
export type LedgerEditMode =
  | 'REPRICE'
  | 'RESTRUCTURE'
  | 'RESTRUCTURE_KEEP_HOURS'
  | 'REVISE_STATEMENTS';

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
  mode: LedgerEditMode;
  /** What the council said it did, collated across the slices. */
  reasoning: string | null;
  roles: RoleKind[];
  scope: LockScope;
  /** The cards the envelope covered, so the ledger can badge them. */
  cardIds: string[];
  /** The statements the envelope covered. Empty unless REVISE_STATEMENTS. */
  statementIds: string[];
  rowsBefore: number | null;
  rowsAfter: number | null;
  hoursBefore: number | null;
  hoursAfter: number | null;
  overwroteConflict: boolean;
  createdAt: string;
  appliedAt: string | null;
  revertedAt: string | null;
  /**
   * Who put it back, when somebody did. Null otherwise.
   *
   * A name resolved at read time, not an id, and it is here for the same reason
   * `HiddenWorkFinding` records who dismissed a risk: in a shared workspace,
   * undoing a colleague's change is a decision somebody should be able to ask
   * about later.
   */
  revertedByName: string | null;
  /** True when the viewer is the person who asked for it. */
  mine: boolean;
};

/**
 * How many edits are in each state, over ALL of them rather than a page.
 *
 * Separate from the list because they are answers to different questions. The
 * list is capped so a two-second poll stays cheap; these are not, because a
 * re-price fans out to one edit per card and "did my thirty-card steer
 * actually start" is exactly what a capped list cannot answer.
 */
export type LedgerEditCounts = {
  total: number;
  queued: number;
  running: number;
  pendingConflict: number;
  failed: number;
};

export const EMPTY_EDIT_COUNTS: LedgerEditCounts = {
  total: 0,
  queued: 0,
  running: 0,
  pendingConflict: 0,
  failed: 0,
};

/** Still working, so the ledger should keep polling. */
export function isEditInFlight(e: LedgerEditDTO): boolean {
  return e.status === 'QUEUED' || e.status === 'RUNNING';
}

/**
 * Applied, not yet put back, and therefore revertible.
 *
 * A reshape is deliberately excluded. Putting its rows back would leave the
 * cards it created sitting empty and could not resurrect a card it removed, so
 * the ledger would end up in a state that is neither before nor after. Saying
 * so is better than a revert that half-works; undoing a reshape properly
 * belongs with the richer undo model, which is later work.
 *
 * A statement revision IS revertible, and more exactly than an hours edit: it
 * patched rows rather than replacing them, so the wording goes back onto the
 * same ids and a line a merge removed is restored with the id it had.
 */
export function isRevertible(e: LedgerEditDTO): boolean {
  return e.status === 'APPLIED' && (e.mode === 'REPRICE' || e.mode === 'REVISE_STATEMENTS');
}

/**
 * The hours this edit moved, or null when it has not landed.
 *
 * Signed on purpose: "+18h" and "-6h" are different news, and a reviewer
 * skimming a list of edits is looking for the big movers in either direction.
 *
 * Always null for a statement revision, and that is the honest answer rather
 * than a gap: it moved no hours, and rendering "0h" would put it in the list of
 * things that changed a number.
 */
export function hoursDelta(e: LedgerEditDTO): number | null {
  if (e.hoursBefore === null || e.hoursAfter === null) return null;
  return Math.round((e.hoursAfter - e.hoursBefore) * 100) / 100;
}
