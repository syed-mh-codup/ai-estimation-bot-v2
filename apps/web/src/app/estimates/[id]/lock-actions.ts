'use server';

import {
  lockEnvelope,
  lockHistoryFor,
  prisma,
  unlockEnvelope,
  type LockTarget,
  type RoleKind,
} from '@repo/db';
import { requireUser } from '@/lib/rbac';
import { loadLockState } from '@/lib/lock-state';
import type { LockEventDTO, LockStateDTO } from './lock-dto';

/**
 * Freezing and releasing ledger rows — AEH-238.
 *
 * Separate from `actions.ts` because these are not ledger edits: a lock changes
 * what may be edited, not what the estimate says. Keeping them apart means the
 * guards in `actions.ts` never have to reason about whether the call in front
 * of them is the one allowed to bypass them.
 *
 * Every one of these returns the estimate's WHOLE lock state rather than a
 * patch. The hot paths in `actions.ts` return single rows for the client to
 * reconcile optimistically, and for typing an hour into a box that is right.
 * A lock is not a hot path — it is a deliberate act taken a few times per
 * review — and one card-scoped lock changes the rendering of every row on that
 * card plus the card's own controls. Returning the resolved truth is both
 * cheaper to reason about and impossible to get out of step.
 */

/** What a lock or unlock did, plus the state to render afterwards. */
export type LockActionResult = {
  state: LockStateDTO;
  /** How many rows this call actually froze or freed. */
  changed: number;
  /**
   * Set when the call could not do all of what was asked, with a sentence to
   * show. Not an error: locking fourteen of sixteen rows because a colleague
   * holds the other two is a real outcome, and it must not read as a failure.
   */
  notice: string | null;
};

/** Refuses a FINALISED estimate — nothing about it may change, locks included. */
async function assertOpen(estimateId: string): Promise<void> {
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { status: true },
  });
  if (!est) throw new Error('Estimate not found');
  if (est.status === 'FINALISED') throw new Error('This estimate is finalised and cannot be edited');
}

/** Names for a set of user ids, resolved at read time so renames stay correct. */
async function namesFor(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Map();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.name ?? u.email]));
}

/**
 * Freeze everything in one declaration of `scope x role`.
 *
 * Rows already frozen by somebody else are left alone and reported. The unique
 * index on `LedgerLock.lineItemId` is what makes that safe under a race rather
 * than merely likely: two overlapping selections submitted at the same instant
 * cannot both win a row.
 */
export async function lockRegion(
  estimateId: string,
  target: LockTarget,
  roles: RoleKind[],
): Promise<LockActionResult> {
  const actor = await requireUser();
  await assertOpen(estimateId);

  const result = await lockEnvelope(prisma, {
    estimateId,
    envelope: { target, roles },
    actorId: actor.id,
  });

  const held = result.alreadyLocked.filter((l) => l.lockedById !== actor.id);
  const names = await namesFor(held.map((l) => l.lockedById));
  const notice =
    held.length === 0
      ? null
      : `${held.length} line${held.length === 1 ? ' was' : 's were'} already locked by ${[
          ...new Set(held.map((l) => names.get(l.lockedById) ?? 'a colleague')),
        ].join(', ')} and stayed as they were.`;

  return { state: await loadLockState(estimateId), changed: result.locked.length, notice };
}

/**
 * Release everything in one declaration.
 *
 * `override` is the confirmation step for removing somebody else's lock. No
 * reason is required, deliberately — the audited record is the preventative
 * measure, and a mandatory justification on every unlock collects nothing but
 * the word "adjusting". What the record does is stop an override being the same
 * as the lock never having been set, which is why it is its own event kind.
 *
 * Without `override`, a colleague's locks are reported and left standing. This
 * is a partial release rather than a refusal of the whole call: freeing your own
 * eight rows should not fail because somebody holds a ninth.
 */
export async function unlockRegion(
  estimateId: string,
  target: LockTarget,
  roles: RoleKind[],
  override = false,
): Promise<LockActionResult> {
  const actor = await requireUser();
  await assertOpen(estimateId);

  const result = await unlockEnvelope(prisma, {
    estimateId,
    envelope: { target, roles },
    actorId: actor.id,
    override,
  });

  const names = await namesFor(result.heldByOthers.map((l) => l.lockedById));
  const notice =
    result.heldByOthers.length === 0
      ? null
      : `${result.heldByOthers.length} line${
          result.heldByOthers.length === 1 ? ' is' : 's are'
        } locked by ${[
          ...new Set(result.heldByOthers.map((l) => names.get(l.lockedById) ?? 'a colleague')),
        ].join(', ')}. Confirm to override.`;

  return { state: await loadLockState(estimateId), changed: result.unlocked.length, notice };
}

/**
 * One row's lock story, oldest first, for the hover affordance.
 *
 * Read on demand rather than shipped with the page: a reviewer looks at one
 * row's history when they want to know why they cannot edit it, and preloading
 * every event for an estimate with hundreds of locks would be several hundred
 * rows nobody reads.
 */
export async function lineLockHistory(
  estimateId: string,
  lineItemId: string,
): Promise<LockEventDTO[]> {
  await requireUser();
  const events = await lockHistoryFor(prisma, estimateId, lineItemId);
  const names = await namesFor(events.flatMap((e) => [e.actorId, e.priorHolderId ?? '']));
  return events.map((e) => ({
    kind: e.kind,
    declaredScope: e.declaredScope,
    actorName: names.get(e.actorId) ?? 'a former colleague',
    priorHolderName: e.priorHolderId ? (names.get(e.priorHolderId) ?? 'a former colleague') : null,
    at: e.createdAt.toISOString(),
  }));
}
