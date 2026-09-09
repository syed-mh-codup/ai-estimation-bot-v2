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

/** One frozen row, as the editor renders it. */
export type LineLockDTO = {
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
  lines: Record<string, LineLockDTO>;
  /** Cards with at least one frozen row: existence and enablement frozen. */
  cardsWithAnyLock: string[];
  /** Cards where every row is frozen: the title is frozen too. */
  cardsFullyLocked: string[];
};

export const EMPTY_LOCK_STATE: LockStateDTO = {
  lines: {},
  cardsWithAnyLock: [],
  cardsFullyLocked: [],
};

/** One entry of a row's lock story, as the hover affordance renders it. */
export type LockEventDTO = {
  kind: 'LOCKED' | 'UNLOCKED' | 'OVERRIDDEN';
  declaredScope: LockScope;
  actorName: string;
  /** Whose lock was removed. Null on LOCKED. */
  priorHolderName: string | null;
  at: string;
};
