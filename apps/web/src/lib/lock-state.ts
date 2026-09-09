import { lockStateFor, prisma } from '@repo/db';
import {
  EMPTY_LOCK_STATE,
  type LineLockDTO,
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
    // A lock cascades away with its holder, so this is unreachable in practice.
    // It is here so a rendering bug never shows a raw cuid to a reviewer.
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
