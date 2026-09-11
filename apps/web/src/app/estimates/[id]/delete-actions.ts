'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';

import { requireUser } from '@/lib/rbac';
import type { MutationOutcome } from './dto';

/**
 * Deleting an estimate, and taking it back. AEH-375.
 *
 * Deleting used to be the one act in this product with no route back. It
 * cascaded through sections, cards, line items, dependencies, statements, risk
 * findings, scope scenarios, artifacts, exports, locks and edit history, and
 * one confirm dialog stood between a mis-click and a week of work. A steered
 * edit can be reverted, a reconciliation can be discarded before it writes,
 * even a buffer change records who moved it — deletion simply ended.
 *
 * So it is now a stamp. `deletedAt` goes on, the row and its whole subtree stay
 * exactly where they are, and recovery clears the stamp. Nothing has to be
 * rebuilt on the way back because nothing was ever taken apart, and every id
 * survives — which is the point. Snapshotting to JSON and re-creating would
 * hand every restored row a NEW id, and a fork's carried marks, a promoted
 * preset's provenance and every scope pick would be left pointing at nothing.
 *
 * NOTHING PURGES. There is deliberately no sweep and no retention window: a
 * deleted estimate is kept indefinitely, and destroying one for real is a
 * hand-run DELETE against the database. That is a decision, not an omission —
 * a sweep is the one part of this feature that could still lose the work, and
 * there is no operational pressure to reclaim the rows.
 */

/**
 * Stamp an estimate deleted. Allowed regardless of status — the owner may
 * remove a finalised estimate.
 *
 * Restricted to the owner or an admin, as destruction always was. Every
 * signed-in user can see and edit every estimate — that is the shared
 * workspace this tool is — but removing one needs an accountable actor rather
 * than merely an authenticated one. That the act is now reversible does not
 * widen it: a recoverable delete still takes the estimate off everyone else's
 * dashboard.
 *
 * Throws rather than returning a refusal, unlike `recoverEstimate` below,
 * because its two callers are form actions that redirect on success and have
 * nowhere to render a message. The guard failing here means someone posted a
 * form for an estimate that is not theirs.
 */
export async function deleteEstimate(id: string): Promise<void> {
  const user = await requireEstimateOwnerOrAdmin(id);

  // `updateMany` with `deletedAt: null` in the where, rather than `update`, so
  // a second delete cannot overwrite the first one's attribution. Two people
  // hitting the button at once would otherwise leave the row stamped by
  // whoever lost the race, and the trash list would name the wrong person.
  await prisma.estimate.updateMany({
    where: { id, deletedAt: null },
    data: { deletedAt: new Date(), deletedById: user.id },
  });

  revalidatePath('/dashboard');
  revalidatePath(`/estimates/${id}`);
}

/**
 * Clear the stamp and put the estimate back.
 *
 * Owner-or-admin, the same right as deleting: the person who mis-clicked can
 * undo it themselves. Admins get the discoverable list at `/admin/trash`;
 * an owner without that page reaches recovery through the estimate's own URL,
 * which still resolves for them and renders the deleted state instead of a
 * 404. Keeping the ids alive is what makes that link work at all.
 *
 * The family comes back with it and needs no repair. `rootOf` treats a parent
 * outside the node set as absent, so while a parent is deleted its children
 * read as originals, and clearing the stamp puts the parent back in the set
 * and the tree reassembles on the next read. There is nothing to rebuild
 * because `parentId` was never touched.
 *
 * Returns a typed refusal rather than throwing: a thrown message is legible
 * under `next dev` and becomes React boilerplate once deployed, and each of
 * these has something real to say.
 */
export async function recoverEstimate(id: string): Promise<MutationOutcome> {
  const user = await requireUser();

  // @deleted-ok this IS the recovery path — filtering it out would make every
  // deleted estimate unrecoverable. AEH-375.
  const est = await prisma.estimate.findUnique({
    where: { id },
    select: { ownerId: true, deletedAt: true },
  });
  if (!est) {
    return {
      kind: 'refused',
      error: 'That estimate is not here any more. Only a deletion run directly against the database removes one for good, so this was not undone by anything in the app.',
    };
  }
  if (user.role !== 'ADMIN' && est.ownerId !== user.id) {
    return { kind: 'refused', error: 'Only the owner or an admin can recover this estimate.' };
  }
  if (est.deletedAt === null) {
    return { kind: 'refused', error: 'This estimate has not been deleted — it is already live.' };
  }

  await prisma.estimate.update({
    where: { id },
    data: { deletedAt: null, deletedById: null },
  });

  revalidatePath('/dashboard');
  revalidatePath('/admin/trash');
  revalidatePath(`/estimates/${id}`);
  return { kind: 'ok' };
}

/**
 * Throws unless the caller owns this estimate or is an admin, and says who
 * they are — the delete needs the id to record who did it.
 *
 * Reads without a `deletedAt` filter on purpose: this guard is the gate on an
 * already-deleted row as much as a live one. It is one of the named exceptions
 * in the estimate-read-paths audit.
 */
async function requireEstimateOwnerOrAdmin(estimateId: string): Promise<{ id: string }> {
  const user = await requireUser();
  if (user.role === 'ADMIN') return user;
  // @deleted-ok gates an already-deleted row as much as a live one: recovery
  // shares this guard. AEH-375.
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { ownerId: true },
  });
  if (!est) throw new Error('Estimate not found');
  if (est.ownerId !== user.id) {
    throw new Error('Only the owner or an admin can delete this estimate');
  }
  return user;
}
