import { lockStateFor, prisma, type LockScope } from '@repo/db';

/**
 * The lock state one estimate's screen needs, resolved for rendering — AEH-238.
 *
 * Separate from `packages/db`'s `lockStateFor`, which answers the enforcement
 * question with ids. This adds the two things a UI needs and a guard does not:
 * holder names, and a shape that survives the server-to-client boundary (plain
 * objects and ISO strings, no `Map`, `Set` or `Date`).
 *
 * Names are resolved by id at read time rather than stored on the lock, so a
 * rename stays correct — the rule `HiddenWorkFinding` already follows for
 * whoever dismissed a risk.
 */

/** One frozen row, as the editor renders it. */
export type LineLockDTO = {
  lockedById: string;
  /** Display name, or the email when there is no name. */
  lockedByName: string;
  /** ISO 8601 — a `Date` does not cross into a client component. */
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

/** Every lock on one estimate, with holder names, ready to render. */
export async function loadLockState(estimateId: string): Promise<LockStateDTO> {
  const { byLineItem, cardsWithAnyLock, cardsFullyLocked } = await lockStateFor(prisma, estimateId);
  if (byLineItem.size === 0) return EMPTY_LOCK_STATE;

  const holderIds = [...new Set([...byLineItem.values()].map((l) => l.lockedById))];
  const holders = await prisma.user.findMany({
    where: { id: { in: holderIds } },
    select: { id: true, name: true, email: true },
  });
  const nameOf = (id: string): string => {
    const u = holders.find((h) => h.id === id);
    // A lock cascades away with its holder, so this is unreachable in practice —
    // it is here so a rendering bug never shows a raw cuid to a reviewer.
    return u ? (u.name ?? u.email) : 'a former colleague';
  };

  const lines: Record<string, LineLockDTO> = {};
  for (const [lineItemId, lock] of byLineItem) {
    lines[lineItemId] = {
      lockedById: lock.lockedById,
      lockedByName: nameOf(lock.lockedById),
      lockedAt: lock.lockedAt.toISOString(),
      declaredScope: lock.declaredScope,
    };
  }

  return {
    lines,
    cardsWithAnyLock: [...cardsWithAnyLock],
    cardsFullyLocked: [...cardsFullyLocked],
  };
}

/** One entry of a row's lock story, as the hover affordance renders it. */
export type LockEventDTO = {
  kind: 'LOCKED' | 'UNLOCKED' | 'OVERRIDDEN';
  declaredScope: LockScope;
  actorName: string;
  /** Whose lock was removed. Null on LOCKED. */
  priorHolderName: string | null;
  at: string;
};
