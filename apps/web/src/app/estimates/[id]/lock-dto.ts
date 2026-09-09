import type { LockScope } from '@repo/db';

/**
 * Shapes for the ledger-lock surface — AEH-238.
 *
 * Separate from `lib/lock-state.ts`, which holds the loader, for a reason worth
 * stating: that module imports `prisma`, and this one is imported by the client
 * ledger context. Types alone would erase at compile time, but `EMPTY_LOCK_STATE`
 * is a real value, so importing it from the loader's module would drag Prisma
 * into the browser bundle. Typecheck stays green on that; the build does not.
 * Same lesson as the `dto.ts`/`actions.ts` split next door — see AEH-253.
 *
 * Everything here crosses the server-to-client boundary, so: plain objects and
 * arrays, ISO strings, no `Map`, `Set` or `Date`.
 */

/**
 * One frozen thing, as the editor renders it.
 *
 * One shape for a frozen row and a frozen statement, because the padlock, the
 * hover story and the override confirmation are the same affordance in both
 * places. `declaredScope` is what tells them apart — CARD or LINE against a
 * row, STATEMENT or STATEMENT_LIST against a statement.
 */
export type HeldLockDTO = {
  lockedById: string;
  /** Display name, or the email when there is no name. */
  lockedByName: string;
  /** ISO 8601 — a `Date` does not survive the boundary. */
  lockedAt: string;
  /** What the human pointed at, for "locked with the whole card" phrasing. */
  declaredScope: LockScope;
};

export type LockStateDTO = {
  /** Keyed by `RoleLineItem.id`. Absent means free. */
  lines: Record<string, HeldLockDTO>;
  /** Cards with at least one frozen row: existence and enablement frozen. */
  cardsWithAnyLock: string[];
  /** Cards where every row is frozen: the title is frozen too. */
  cardsFullyLocked: string[];
  /** Keyed by `EstimateStatement.id`. Absent means free. AEH-238. */
  statements: Record<string, HeldLockDTO>;
  /**
   * Lists where every line is frozen, as StatementKind strings.
   *
   * What it buys the UI is the three-state padlock on the list itself: none,
   * some, all. Same derivation as `cardsFullyLocked`, and an empty list is not
   * locked for the same reason.
   */
  listsFullyLocked: string[];
};

export const EMPTY_LOCK_STATE: LockStateDTO = {
  lines: {},
  cardsWithAnyLock: [],
  cardsFullyLocked: [],
  statements: {},
  listsFullyLocked: [],
};

/** One entry of a lock story, as the hover affordance renders it. */
export type LockEventDTO = {
  kind: 'LOCKED' | 'UNLOCKED' | 'OVERRIDDEN';
  declaredScope: LockScope;
  actorName: string;
  /** Whose lock was removed. Null on LOCKED. */
  priorHolderName: string | null;
  at: string;
};
