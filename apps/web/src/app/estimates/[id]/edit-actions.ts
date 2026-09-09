'use server';

import {
  applyRegionReplace,
  lockedWithin,
  prisma,
  regionFingerprint,
  resolveTarget,
  revertRegion,
  type LockTarget,
  type ProposedRow,
  type RoleKind,
} from '@repo/db';
import { requireUser } from '@/lib/rbac';
import { inngest, EVENT_LEDGER_EDIT } from '@/lib/inngest';
import { taxContextForEstimate } from '@/lib/estimate-tax';
import type { LedgerEditDTO } from './edit-dto';

/**
 * Starting, deciding and undoing a steered edit — AEH-238.
 *
 * The dispatch here is where the envelope becomes real. Three things happen
 * before an event is sent, and the order matters:
 *
 *   1. the declaration is resolved to concrete row ids
 *   2. the enforcement rule is applied — refuse if it intersects a lock
 *   3. those ids and the region's fingerprint are PINNED onto the row
 *
 * After that the job cannot widen its own reach: the engine reads the pinned
 * ids and `applyRegionReplace` writes to those and no others. Resolving the
 * envelope again at the end would undo the guarantee — a row somebody added
 * mid-run would be swept into the delete set.
 */

/** Refuses a FINALISED estimate. */
async function assertOpen(estimateId: string): Promise<void> {
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { status: true },
  });
  if (!est) throw new Error('Estimate not found');
  if (est.status === 'FINALISED') throw new Error('This estimate is finalised and cannot be edited');
}

/** The columns the ledger renders. Never the snapshot payloads — see the model. */
const EDIT_SELECT = {
  id: true,
  status: true,
  stage: true,
  pct: true,
  error: true,
  prompt: true,
  reasoning: true,
  roles: true,
  declaredScope: true,
  pinnedCardIds: true,
  pinnedLineItemIds: true,
  rowsBefore: true,
  rowsAfter: true,
  hoursBefore: true,
  hoursAfter: true,
  overwroteConflict: true,
  createdAt: true,
  appliedAt: true,
  revertedAt: true,
  actorId: true,
} as const;

type EditRow = {
  id: string;
  status: string;
  stage: string | null;
  pct: number;
  error: string | null;
  prompt: string;
  reasoning: string | null;
  roles: RoleKind[];
  declaredScope: string;
  pinnedCardIds: string[];
  pinnedLineItemIds: string[];
  rowsBefore: number | null;
  rowsAfter: number | null;
  hoursBefore: number | null;
  hoursAfter: number | null;
  overwroteConflict: boolean;
  createdAt: Date;
  appliedAt: Date | null;
  revertedAt: Date | null;
  actorId: string;
};

function toDTO(row: EditRow, viewerId: string): LedgerEditDTO {
  return {
    id: row.id,
    status: row.status as LedgerEditDTO['status'],
    stage: row.stage,
    pct: row.pct,
    error: row.error,
    prompt: row.prompt,
    reasoning: row.reasoning,
    roles: row.roles,
    scope: row.declaredScope as LedgerEditDTO['scope'],
    cardIds: row.pinnedCardIds,
    rowsBefore: row.rowsBefore,
    rowsAfter: row.rowsAfter,
    hoursBefore: row.hoursBefore,
    hoursAfter: row.hoursAfter,
    overwroteConflict: row.overwroteConflict,
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt?.toISOString() ?? null,
    revertedAt: row.revertedAt?.toISOString() ?? null,
    mine: row.actorId === viewerId,
  };
}

export type StartEditResult =
  | { ok: true; edit: LedgerEditDTO; staleWarning: string | null }
  | { ok: false; reason: string };

/**
 * Declare an envelope, say what should happen to it, and start the job.
 *
 * `renderedAt` is when the screen the person is looking at was produced. If the
 * region has been written to since, they are warned BEFORE a model call is paid
 * for — which is the cheap half of the concurrency answer. It is deliberately
 * one aggregate over the region's `updatedAt` columns rather than a row-by-row
 * comparison: the question is "has anything here moved", and that is the
 * performant way to ask it.
 *
 * The warning does not block. The person asked for this edit knowing what they
 * could see, and the expensive check — did it move WHILE the job ran — happens
 * at apply time, where it can park the proposal for a decision.
 */
export async function startLedgerEdit(
  estimateId: string,
  target: LockTarget,
  roles: RoleKind[],
  prompt: string,
  renderedAt: string,
): Promise<StartEditResult> {
  const actor = await requireUser();
  await assertOpen(estimateId);

  const instruction = prompt.trim();
  if (instruction.length === 0) return { ok: false, reason: 'Say what should change.' };

  const envelope = { target, roles };
  const pinnedLineItemIds = await resolveTarget(prisma, estimateId, envelope);
  if (pinnedLineItemIds.length === 0) {
    return {
      ok: false,
      reason: 'That selection covers no lines. Pick at least one card and one role.',
    };
  }

  // The enforcement rule, at the only point where refusing is cheap.
  const locks = await lockedWithin(prisma, estimateId, envelope);
  if (locks.length > 0) {
    const holders = await prisma.user.findMany({
      where: { id: { in: [...new Set(locks.map((l) => l.lockedById))] } },
      select: { id: true, name: true, email: true },
    });
    const names = [
      ...new Set(
        locks.map((l) => {
          if (l.lockedById === actor.id) return 'you';
          const u = holders.find((h) => h.id === l.lockedById);
          return u ? (u.name ?? u.email) : 'a colleague';
        }),
      ),
    ].join(', ');
    return {
      ok: false,
      reason: `${locks.length} line${
        locks.length === 1 ? ' in' : 's in'
      } this selection ${locks.length === 1 ? 'is' : 'are'} locked (${names}). Unlock ${
        locks.length === 1 ? 'it' : 'them'
      }, or narrow the selection.`,
    };
  }

  const cards = await prisma.roleLineItem.findMany({
    where: { id: { in: pinnedLineItemIds } },
    select: { menuItemId: true },
    distinct: ['menuItemId'],
  });
  const pinnedCardIds = cards.map((c) => c.menuItemId);

  const fingerprint = await regionFingerprint(prisma, {
    cardIds: pinnedCardIds,
    lineItemIds: pinnedLineItemIds,
  });

  const rendered = new Date(renderedAt);
  const staleWarning =
    fingerprint && !Number.isNaN(rendered.getTime()) && fingerprint > rendered
      ? 'Someone has changed this part of the estimate since your screen was drawn. What you are looking at may not be what gets re-priced.'
      : null;

  const edit = await prisma.ledgerEdit.create({
    data: {
      estimateId,
      actorId: actor.id,
      prompt: instruction,
      declaredScope: target.scope,
      declaredTargetId: target.scope === 'ESTIMATE' ? null : target.id,
      roles,
      pinnedLineItemIds,
      pinnedCardIds,
      fingerprint,
      status: 'QUEUED',
      stage: 'Queued',
    },
    select: EDIT_SELECT,
  });

  await inngest.send({ name: EVENT_LEDGER_EDIT, data: { editId: edit.id } });

  return { ok: true, edit: toDTO(edit, actor.id), staleWarning };
}

/**
 * Every edit on this estimate that the ledger still cares about.
 *
 * In-flight ones so the progress can be shown in context, and the settled ones
 * from this session so a revert stays reachable. Capped, and the snapshots are
 * never selected.
 */
export async function listLedgerEdits(estimateId: string): Promise<LedgerEditDTO[]> {
  const actor = await requireUser();
  const rows = await prisma.ledgerEdit.findMany({
    where: { estimateId },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: EDIT_SELECT,
  });
  return rows.map((r) => toDTO(r, actor.id));
}

/**
 * Approve a parked proposal, overwriting the change that landed underneath it.
 *
 * This is the "write warns, approval overwrites" rule. A background job cannot
 * ask a question, so the proposal was parked on the row; this is the answer.
 *
 * Note what approval canNOT do: get past a lock. `applyRegionReplace` re-checks
 * for locks and fails the edit outright rather than offering them for approval,
 * because approving here would be a lock bypass with none of the override
 * ceremony.
 */
export async function approveLedgerEdit(editId: string): Promise<LedgerEditDTO> {
  const actor = await requireUser();
  const edit = await prisma.ledgerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: {
      estimateId: true,
      status: true,
      pinnedLineItemIds: true,
      pinnedCardIds: true,
      afterSnapshot: true,
      reasoning: true,
    },
  });
  if (edit.status !== 'PENDING_CONFLICT') {
    throw new Error(`Nothing is waiting on a decision for this edit (it is ${edit.status}).`);
  }
  await assertOpen(edit.estimateId);

  const parked = edit.afterSnapshot as unknown as { rows?: ProposedRow[] } | null;
  const proposed = parked?.rows ?? [];
  const { effective } = await taxContextForEstimate(edit.estimateId);

  await applyRegionReplace(prisma, {
    editId,
    pinnedLineItemIds: edit.pinnedLineItemIds,
    pinnedCardIds: edit.pinnedCardIds,
    proposed,
    effective,
    // Already parked once for this reason; the person has now decided.
    expectFingerprint: null,
    overwriteConflict: true,
    reasoning: edit.reasoning,
  });

  const row = await prisma.ledgerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: EDIT_SELECT,
  });
  return toDTO(row, actor.id);
}

/** Throw a parked proposal away. The concurrent change stands. */
export async function discardLedgerEdit(editId: string): Promise<LedgerEditDTO> {
  const actor = await requireUser();
  const row = await prisma.ledgerEdit.update({
    where: { id: editId },
    data: { status: 'DISCARDED', stage: 'Discarded' },
    select: EDIT_SELECT,
  });
  return toDTO(row, actor.id);
}

/**
 * Put one applied edit back.
 *
 * One level, scoped to the region that edit touched. The richer undo model, and
 * how it behaves when two people are editing at once, is deliberately later
 * work rather than something guessed at here.
 */
export async function revertLedgerEdit(editId: string): Promise<LedgerEditDTO> {
  const actor = await requireUser();
  const edit = await prisma.ledgerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: { estimateId: true },
  });
  await assertOpen(edit.estimateId);

  await revertRegion(prisma, { editId, revertedById: actor.id });

  const row = await prisma.ledgerEdit.findUniqueOrThrow({
    where: { id: editId },
    select: EDIT_SELECT,
  });
  return toDTO(row, actor.id);
}
