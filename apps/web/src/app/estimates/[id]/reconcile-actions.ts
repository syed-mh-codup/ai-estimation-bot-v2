'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';

import { requireUser } from '@/lib/rbac';
import { inngest } from '@/lib/inngest';
import { EVENT_RECONCILE } from '@/lib/inngest';
import type { MutationOutcome } from './dto';

/**
 * Dispatching a reconciliation. AEH-236.
 *
 * A button, not an automatic dispatch when a fork is created, and for two
 * reasons. The ingest of any attached documents finishes asynchronously, so an
 * auto-dispatch would race it and reconcile against half a brief. And somebody
 * who forked in order to hand-edit should never have a model rewrite their
 * estimate because they attached a file.
 */
export async function startReconciliation(estimateId: string): Promise<MutationOutcome> {
  const actor = await requireUser();

  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: {
      status: true,
      parentId: true,
      lineageKind: true,
      forkPrompt: true,
      ingestStatus: true,
      runStatus: true,
    },
  });
  if (!estimate) return { kind: 'refused', error: 'That estimate no longer exists.' };

  if (!estimate.parentId || !estimate.lineageKind) {
    return {
      kind: 'refused',
      error: 'Only a forked estimate can be reconciled — this one has nothing to reconcile against.',
    };
  }
  if (estimate.status === 'FINALISED') {
    return { kind: 'refused', error: 'This estimate is finalised and cannot be changed.' };
  }
  // Reconciling against a brief that is still being written would read half a
  // document and propose against the other half.
  if (estimate.ingestStatus === 'RUNNING') {
    return {
      kind: 'refused',
      error: 'The attached documents are still being read. Wait for that to finish.',
    };
  }
  if (estimate.runStatus === 'RUNNING') {
    return { kind: 'refused', error: 'This estimate is being estimated right now.' };
  }

  // One at a time. Two passes against one estimate produce two competing
  // answers to the same question, and the review has no way to say which of
  // them a person meant to accept.
  const inFlight = await prisma.estimateReconciliation.findFirst({
    where: { estimateId, status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  if (inFlight) {
    return { kind: 'refused', error: 'A reconciliation is already running on this estimate.' };
  }

  // The steering instruction is copied onto the row rather than read through
  // the estimate when the job runs. It is the record of what THIS pass was
  // asked to do, and editing the fork's prompt afterwards must not rewrite the
  // history of a pass that already happened.
  const rec = await prisma.estimateReconciliation.create({
    data: {
      estimateId,
      actorId: actor.id,
      prompt: estimate.forkPrompt ?? '',
      posture: estimate.lineageKind,
      status: 'QUEUED',
      stage: 'Queued',
      // max(updatedAt) across the ledger as the pass starts. Compared again
      // before anything is applied: estimates are edited live, and a pass that
      // ran for four minutes cannot assume the ledger stood still.
      fingerprint: await regionFingerprint(estimateId),
    },
    select: { id: true },
  });

  await inngest.send({ name: EVENT_RECONCILE, data: { reconciliationId: rec.id } });
  revalidatePath(`/estimates/${estimateId}`);
  return { kind: 'ok' };
}

/** The most recent write anywhere in this estimate's ledger. */
async function regionFingerprint(estimateId: string): Promise<Date | null> {
  const [card, row] = await Promise.all([
    prisma.menuItem.findFirst({
      where: { estimateId },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    prisma.roleLineItem.findFirst({
      where: { menuItem: { estimateId } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
  ]);
  const times = [card?.updatedAt, row?.updatedAt].filter((d): d is Date => d instanceof Date);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (a > b ? a : b));
}
