'use server';

import { revalidatePath } from 'next/cache';
import { familyIds, prisma, rootOf, type LineageKind } from '@repo/db';

import { requireUser } from '@/lib/rbac';
import type { MutationOutcome } from './dto';

/**
 * Naming and relating whole families of estimates. AEH-236.
 *
 * Both actions here are about the FAMILY rather than any one estimate, which is
 * why they are not in `actions.ts` with the ledger edits. Both also return a
 * typed refusal rather than throwing: a thrown message is legible under
 * `next dev` and becomes React boilerplate once deployed, and these have real
 * things to say.
 */

/** Every estimate, as the lineage helpers want it. Small enough to load whole. */
async function allNodes() {
  return prisma.estimate.findMany({
    select: { id: true, parentId: true, projectName: true, title: true },
  });
}

/**
 * Rename the project a given estimate belongs to.
 *
 * Writes every member of the family in one statement, because the name is
 * denormalised onto all of them — see `Estimate.projectName` for why it is not
 * held on the root alone. Renaming from any member is deliberate: on the
 * dashboard you are looking at the project, not at whichever estimate happens
 * to have started it.
 */
export async function renameProject(estimateId: string, name: string): Promise<MutationOutcome> {
  await requireUser();
  const trimmed = name.trim();
  if (!trimmed) return { kind: 'refused', error: 'Give the project a name.' };
  if (trimmed.length > 200) {
    return { kind: 'refused', error: 'That name is too long — 200 characters at most.' };
  }

  const nodes = await allNodes();
  if (!nodes.some((n) => n.id === estimateId)) {
    return { kind: 'refused', error: 'That estimate no longer exists.' };
  }

  await prisma.estimate.updateMany({
    where: { id: { in: familyIds(nodes, estimateId) } },
    data: { projectName: trimmed },
  });

  revalidatePath('/dashboard');
  revalidatePath(`/estimates/${estimateId}`);
  return { kind: 'ok' };
}

/**
 * Relate two estimates that already exist.
 *
 * Lineage otherwise only comes into being by forking, which leaves no way to
 * say anything about the estimates already on the platform — and they are
 * exactly the ones that need it. Two takes on the same client's platform,
 * estimated separately before this feature existed, are alternates of each
 * other by any reading, and without this they show as unrelated projects that
 * happen to share a name.
 *
 * NOTHING IS COPIED. The child's rows already exist and stay exactly as they
 * are, so no carried marks appear — which is the honest outcome: this estimate
 * was not derived from that one, it was written alongside it. The link records
 * a relationship, not a provenance.
 */
export async function linkToParent(
  childId: string,
  parentId: string,
  kind: LineageKind,
): Promise<MutationOutcome> {
  await requireUser();
  if (childId === parentId) {
    return { kind: 'refused', error: 'An estimate cannot be a fork of itself.' };
  }

  const nodes = await allNodes();
  const child = nodes.find((n) => n.id === childId);
  const parent = nodes.find((n) => n.id === parentId);
  if (!child) return { kind: 'refused', error: 'That estimate no longer exists.' };
  if (!parent) return { kind: 'refused', error: 'The estimate you picked no longer exists.' };
  if (child.parentId) {
    return {
      kind: 'refused',
      error: 'This estimate already records where it came from. Unlink it first.',
    };
  }

  // A cycle would hang every read of the family. `rootOf` is cycle-guarded and
  // would not spin, but it would answer nonsense, and a dashboard row that
  // reports an arbitrary member as the root of its own ancestor is worse than a
  // refusal somebody can act on.
  const parentRoot = rootOf(nodes, parentId);
  if (parentRoot?.id === childId) {
    return {
      kind: 'refused',
      error: 'That estimate is already descended from this one, so linking them would form a loop.',
    };
  }

  await prisma.estimate.update({
    where: { id: childId },
    data: {
      parentId,
      lineageKind: kind,
      // The child joins the parent's family and takes its name. Reading through
      // `rootOf` would give the same answer today; writing it keeps the column
      // consistent across every member, which is what lets the name survive the
      // root being deleted.
      projectName: parent.projectName,
    },
  });

  revalidatePath('/dashboard');
  revalidatePath(`/estimates/${childId}`);
  revalidatePath(`/estimates/${parentId}`);
  return { kind: 'ok' };
}

/**
 * Break a link, leaving both estimates intact.
 *
 * The counterpart to linking, and needed for the same reason: a relationship
 * asserted by hand can be asserted wrongly. Only clears the pointer — nothing
 * about either estimate's contents changes, and a child that was genuinely
 * FORKED keeps its carried marks, which stay true of a document it no longer
 * points at.
 */
export async function unlinkFromParent(childId: string): Promise<MutationOutcome> {
  await requireUser();
  const child = await prisma.estimate.findUnique({
    where: { id: childId },
    select: { parentId: true },
  });
  if (!child) return { kind: 'refused', error: 'That estimate no longer exists.' };
  if (!child.parentId) return { kind: 'refused', error: 'This estimate is not linked to another.' };

  await prisma.estimate.update({
    where: { id: childId },
    data: { parentId: null, lineageKind: null },
  });

  revalidatePath('/dashboard');
  revalidatePath(`/estimates/${childId}`);
  return { kind: 'ok' };
}
