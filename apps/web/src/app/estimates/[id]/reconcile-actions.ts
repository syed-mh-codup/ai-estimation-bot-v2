'use server';

import { revalidatePath } from 'next/cache';
import { applyReconciliation, prisma } from '@repo/db';

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

  // A reconciliation pass costs a model call and rewrites the ledger; a
  // deleted estimate gets neither. AEH-375.
  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId, deletedAt: null },
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

/**
 * Run a failed pass again WITHOUT throwing away what it already paid for.
 *
 * The retry this replaces discarded the reconciliation and started a fresh one,
 * which deleted the row — and with it the Librarian's output, cached on
 * `requirements` precisely so a second attempt need not buy it twice. On a
 * large brief that read is the most expensive call in the pass and the one most
 * likely to be the reason for the failure, so the old retry made the recovery
 * cost the same as the thing that failed.
 *
 * Keeping the row also keeps `fingerprint` — the ledger's state as the FIRST
 * attempt began. That is the honest reading: a resume is the same pass
 * continuing, so what it is allowed to overwrite must still be judged against
 * the ledger it set out from, not against whatever it looks like now.
 *
 * What this does NOT skip is triage and the specialists. The Reconciler is no
 * more deterministic than the Librarian, so a resume that reused some of the
 * previous attempt's proposals and re-decided the rest would be merging two
 * different answers to one question — exactly what the pass refuses to do when
 * it replaces its proposals wholesale. Skipping those needs the triage decision
 * persisted too; until then the pass resumes past the reading and decides the
 * rest again, in full.
 */
export async function resumeReconciliation(reconciliationId: string): Promise<MutationOutcome> {
  await requireUser();

  const rec = await prisma.estimateReconciliation.findUnique({
    where: { id: reconciliationId },
    select: {
      estimateId: true,
      status: true,
      estimate: { select: { status: true, ingestStatus: true, runStatus: true } },
    },
  });
  if (!rec) return { kind: 'refused', error: 'That reconciliation no longer exists.' };

  // Only a failure is resumable. A PROPOSED pass has an answer waiting to be
  // reviewed and an APPLIED one is already in the ledger; re-running either
  // would discard a result somebody may be part-way through deciding on.
  if (rec.status !== 'FAILED') {
    return {
      kind: 'refused',
      error:
        rec.status === 'QUEUED' || rec.status === 'RUNNING'
          ? 'This pass is still running.'
          : 'Only a failed pass can be resumed.',
    };
  }

  // The same three guards as starting one. A pass that failed an hour ago can
  // be resumed into a very different estimate.
  if (rec.estimate.status === 'FINALISED') {
    return { kind: 'refused', error: 'This estimate is finalised and cannot be changed.' };
  }
  if (rec.estimate.ingestStatus === 'RUNNING') {
    return {
      kind: 'refused',
      error: 'The attached documents are still being read. Wait for that to finish.',
    };
  }
  if (rec.estimate.runStatus === 'RUNNING') {
    return { kind: 'refused', error: 'This estimate is being estimated right now.' };
  }

  // Still one at a time, and the check has to exclude this row: it is FAILED,
  // so it cannot be the one in flight, but another pass started since is.
  const inFlight = await prisma.estimateReconciliation.findFirst({
    where: {
      estimateId: rec.estimateId,
      status: { in: ['QUEUED', 'RUNNING'] },
      id: { not: reconciliationId },
    },
    select: { id: true },
  });
  if (inFlight) {
    return { kind: 'refused', error: 'A reconciliation is already running on this estimate.' };
  }

  await prisma.estimateReconciliation.update({
    where: { id: reconciliationId },
    data: { status: 'QUEUED', stage: 'Resuming', error: null },
  });

  await inngest.send({ name: EVENT_RECONCILE, data: { reconciliationId } });
  revalidatePath(`/estimates/${rec.estimateId}`);
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

/**
 * Accept or reject one proposal.
 *
 * Recorded immediately rather than gathered up and sent with the apply, so a
 * half-finished review survives a reload — a person working through forty
 * cards must not lose the decisions they already made.
 */
export async function decideProposal(
  proposalId: string,
  decision: 'ACCEPTED' | 'REJECTED' | 'PENDING',
): Promise<MutationOutcome> {
  const actor = await requireUser();
  const p = await prisma.reconciliationProposal.findUnique({
    where: { id: proposalId },
    select: { reconciliation: { select: { id: true, estimateId: true, status: true } } },
  });
  if (!p) return { kind: 'refused', error: 'That proposal no longer exists.' };
  if (p.reconciliation.status === 'APPLIED') {
    return { kind: 'refused', error: 'This reconciliation has already been applied.' };
  }

  await prisma.reconciliationProposal.update({
    where: { id: proposalId },
    data: {
      decision,
      // Cleared when a decision is undone, so the record never claims somebody
      // settled something that is open again.
      decidedAt: decision === 'PENDING' ? null : new Date(),
      decidedById: decision === 'PENDING' ? null : actor.id,
    },
  });
  return { kind: 'ok' };
}

/**
 * Write every accepted proposal to the ledger.
 *
 * `overwrite` is how a person answers the conflict the applier parks: it is
 * never set on a first attempt, because "the estimate changed under you" is a
 * question, not something to decide on somebody's behalf.
 */
export async function applyReconciliationAction(
  reconciliationId: string,
  overwrite = false,
): Promise<MutationOutcome> {
  await requireUser();
  const rec = await prisma.estimateReconciliation.findUnique({
    where: { id: reconciliationId },
    select: { estimateId: true, status: true },
  });
  if (!rec) return { kind: 'refused', error: 'That reconciliation no longer exists.' };
  if (rec.status === 'APPLIED') {
    return { kind: 'refused', error: 'This reconciliation has already been applied.' };
  }

  const out = await applyReconciliation(prisma, {
    reconciliationId,
    overwriteConflict: overwrite,
  });

  revalidatePath(`/estimates/${rec.estimateId}`);

  switch (out.kind) {
    case 'APPLIED':
      return { kind: 'ok' };
    case 'NOTHING_ACCEPTED':
      return { kind: 'refused', error: 'Nothing has been accepted yet.' };
    case 'REFUSED_LOCKED':
      return {
        kind: 'refused',
        error: `${out.lockedLineItemIds.length} line${out.lockedLineItemIds.length === 1 ? ' was' : 's were'} frozen while this was open, so nothing was written. Unlock them and try again.`,
      };
    case 'CONFLICT':
      return {
        kind: 'refused',
        error:
          'This estimate changed while the proposal was open. Applying now would overwrite what landed since — reconcile again, or apply anyway to overwrite it.',
      };
  }
}

/**
 * Throw the whole pass away.
 *
 * Deletes the reconciliation and its proposals. Nothing was written to the
 * ledger, so there is nothing to undo — which is the point of a pass that only
 * ever proposes.
 */
export async function discardReconciliation(reconciliationId: string): Promise<MutationOutcome> {
  await requireUser();
  const rec = await prisma.estimateReconciliation.findUnique({
    where: { id: reconciliationId },
    select: { estimateId: true, status: true },
  });
  if (!rec) return { kind: 'refused', error: 'That reconciliation no longer exists.' };
  if (rec.status === 'APPLIED') {
    return {
      kind: 'refused',
      error: 'This reconciliation has been applied — discarding it would not undo the change.',
    };
  }
  await prisma.estimateReconciliation.delete({ where: { id: reconciliationId } });
  revalidatePath(`/estimates/${rec.estimateId}`);
  return { kind: 'ok' };
}
