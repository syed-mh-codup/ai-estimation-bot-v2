import { lockStateFor, prisma, statementLockStateFor } from '@repo/db';
import {
  EMPTY_LOCK_STATE,
  type HeldLockDTO,
  type LockStateDTO,
} from '@/app/estimates/[id]/lock-dto';

/**
 * Reading one estimate's lock state for rendering — AEH-238.
 *
 * Separate from `packages/db`'s `lockStateFor`, which answers the enforcement
 * question with ids. This adds the two things a UI needs and a guard does not:
 * holder names, and a shape that survives the server-to-client boundary.
 *
 * Names are resolved by id at read time rather than stored on the lock, so a
 * rename stays correct — the rule `HiddenWorkFinding` already follows for
 * whoever dismissed a risk.
 *
 * The DTO types live in `lock-dto.ts` rather than here because this module
 * imports Prisma and the client ledger context imports those types. See the
 * note there.
 */

/**
 * Every lock on one estimate, with holder names, ready to render.
 *
 * Rows and statements in one object, and one round trip's worth of user
 * lookups for both. The ledger context ships this whole shape to the client, so
 * a second loader would mean a second thing for the page to await and a second
 * chance for the two to disagree about who holds what.
 */
export async function loadLockState(estimateId: string): Promise<LockStateDTO> {
  const [rowState, statementState] = await Promise.all([
    lockStateFor(prisma, estimateId),
    statementLockStateFor(prisma, estimateId),
  ]);
  const { byLineItem, cardsWithAnyLock, cardsFullyLocked } = rowState;
  const { byStatement, listsFullyLocked } = statementState;
  if (byLineItem.size === 0 && byStatement.size === 0) return EMPTY_LOCK_STATE;

  const holderIds = [
    ...new Set(
      [...byLineItem.values(), ...byStatement.values()].map((l) => l.lockedById),
    ),
  ];
  const holders = await prisma.user.findMany({
    where: { id: { in: holderIds } },
    select: { id: true, name: true, email: true },
  });
  const nameOf = (id: string): string => {
    const u = holders.find((h) => h.id === id);
    // A lock cascades away with its holder, so this is unreachable in practice.
    // It is here so a rendering bug never shows a raw cuid to a reviewer.
    return u ? (u.name ?? u.email) : 'a former colleague';
  };
  const toDTO = (lock: {
    lockedById: string;
    lockedAt: Date;
    declaredScope: HeldLockDTO['declaredScope'];
  }): HeldLockDTO => ({
    lockedById: lock.lockedById,
    lockedByName: nameOf(lock.lockedById),
    lockedAt: lock.lockedAt.toISOString(),
    declaredScope: lock.declaredScope,
  });

  const lines: Record<string, HeldLockDTO> = {};
  for (const [lineItemId, lock] of byLineItem) lines[lineItemId] = toDTO(lock);

  const statements: Record<string, HeldLockDTO> = {};
  for (const [statementId, lock] of byStatement) statements[statementId] = toDTO(lock);

  return {
    lines,
    cardsWithAnyLock: [...cardsWithAnyLock],
    cardsFullyLocked: [...cardsFullyLocked],
    statements,
    listsFullyLocked: [...listsFullyLocked],
  };
}
