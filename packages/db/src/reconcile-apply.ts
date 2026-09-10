/**
 * Writing an accepted reconciliation to the ledger. AEH-236.
 *
 * The pass proposes and never writes; this is the only thing that writes. The
 * separation is the feature — a whole pass can be thrown away for the cost of a
 * button, and the numbers a client might see move only when somebody decided
 * they should.
 *
 * ── Everything lands together ────────────────────────────────────────────────
 *
 * One transaction for every accepted proposal. A reconciliation is one
 * decision about one estimate: applying half of it produces a ledger that
 * matches neither the old approach nor the new one, and nothing on the screen
 * would say which half you got.
 *
 * ── What a rejection costs ───────────────────────────────────────────────────
 *
 * Nothing is written, and the proposal keeps its rationale. That is the whole
 * point of recording rejections: "why is this still 18h when the brief changed"
 * has an answer six weeks later, and the answer is a sentence somebody can
 * disagree with rather than an absence.
 */
import type { Prisma, PrismaClient } from './generated/client/index.js';
import { markAmended } from './carriage';

export type ReconcileApplyOutcome =
  | { kind: 'APPLIED'; added: number; modified: number; removed: number }
  | { kind: 'CONFLICT'; observedFingerprint: Date | null }
  | { kind: 'REFUSED_LOCKED'; lockedLineItemIds: string[] }
  | { kind: 'NOTHING_ACCEPTED' };

/** One proposed row, as the pass wrote it into `payload`. */
type PayloadRow = {
  role: 'DEV' | 'QA' | 'PM' | 'BA';
  title: string;
  baseHours: number;
  taxedHours: number;
  notes: string | null;
  touchesFrontend: boolean;
  touchesBackend: boolean;
};

/**
 * Apply every ACCEPTED proposal on a reconciliation.
 *
 * `expectFingerprint` is compared inside the transaction, not before it: the
 * gap between a check and a write is exactly where a concurrent edit lands.
 */
export async function applyReconciliation(
  db: PrismaClient,
  args: { reconciliationId: string; overwriteConflict?: boolean },
): Promise<ReconcileApplyOutcome> {
  const { reconciliationId, overwriteConflict = false } = args;

  const rec = await db.estimateReconciliation.findUniqueOrThrow({
    where: { id: reconciliationId },
    select: { estimateId: true, fingerprint: true },
  });

  const accepted = await db.reconciliationProposal.findMany({
    where: { reconciliationId, decision: 'ACCEPTED' },
    select: {
      id: true,
      menuItemId: true,
      kind: true,
      title: true,
      supersedesMenuItemIds: true,
      payload: true,
    },
  });
  if (accepted.length === 0) return { kind: 'NOTHING_ACCEPTED' };

  // Every card this apply will touch, so the lock check covers the whole write
  // rather than one proposal at a time.
  const touchedCardIds = accepted.flatMap((p) =>
    [p.menuItemId, ...p.supersedesMenuItemIds].filter((id): id is string => Boolean(id)),
  );

  return db.$transaction(
    async (tx) => {
      // Refuse when anything in the write set is frozen. Inside the transaction
      // because a lock landing between a check and the write would be taken out
      // by the delete below — no error, no LockEvent, a lock nobody removed.
      // The same window `applyRegionReplace` closes, for the same reason.
      const locked = await tx.ledgerLock.findMany({
        where: { lineItem: { menuItemId: { in: touchedCardIds } } },
        select: { lineItemId: true },
      });
      if (locked.length > 0) {
        await tx.estimateReconciliation.update({
          where: { id: reconciliationId },
          data: {
            status: 'FAILED',
            error: `${locked.length} line${locked.length === 1 ? ' was' : 's were'} frozen while this was waiting, so nothing was written. Unlock them and reconcile again.`,
          },
        });
        return { kind: 'REFUSED_LOCKED' as const, lockedLineItemIds: locked.map((l) => l.lineItemId) };
      }

      if (!overwriteConflict) {
        const observed = await currentFingerprint(tx, rec.estimateId);
        const moved =
          (observed?.getTime() ?? null) !== (rec.fingerprint?.getTime() ?? null);
        if (moved) {
          // Parked, not discarded. A person has to decide whether to overwrite
          // work that landed while they were reading — a background job cannot
          // ask, so the question is left where the UI will find it.
          await tx.estimateReconciliation.update({
            where: { id: reconciliationId },
            data: {
              stage: 'Waiting on a decision',
              error:
                'This estimate changed while the proposal was open. Applying now would overwrite what landed since.',
            },
          });
          return { kind: 'CONFLICT' as const, observedFingerprint: observed };
        }
      }

      let added = 0;
      let modified = 0;
      let removed = 0;

      const maxOrder = await tx.menuItem.aggregate({
        where: { estimateId: rec.estimateId },
        _max: { order: true },
      });
      let nextOrder = (maxOrder._max.order ?? -1) + 1;

      for (const p of accepted) {
        const rows = ((p.payload as { rows?: PayloadRow[] } | null)?.rows ?? []).filter(
          (r) => r.baseHours > 0 || r.title.trim().length > 0,
        );

        if (p.kind === 'REMOVE') {
          if (p.menuItemId) {
            // Cascades to its line items. The proposal keeps the title, the
            // hours and the rationale, so the record survives the row.
            await tx.menuItem.deleteMany({ where: { id: p.menuItemId } });
            removed += 1;
          }
          continue;
        }

        if (p.kind === 'ADD') {
          await tx.menuItem.create({
            data: {
              estimateId: rec.estimateId,
              taxonomyKey: 'reconciled',
              title: p.title,
              order: nextOrder++,
              // No carriage: this work has no counterpart on the parent, so the
              // margin stays blank rather than claiming a lineage it lacks.
              carriedFromId: null,
              carriedIntact: true,
              lineItems: {
                create: rows.map((r) => ({
                  role: r.role,
                  title: r.title,
                  baseHours: r.baseHours,
                  taxedHours: r.taxedHours,
                  notes: r.notes,
                  // STEERED: a person decided, the council priced. The same
                  // distinction a steered edit records.
                  provenance: 'STEERED' as const,
                  touchesFrontend: r.touchesFrontend,
                  touchesBackend: r.touchesBackend,
                })),
              },
            },
            select: { id: true },
          });
          added += 1;

          // A collapse: this one card replaces several. Deleted in the SAME
          // transaction that writes it, so the ledger never holds both the old
          // cards and the thing that supersedes them.
          if (p.supersedesMenuItemIds.length > 0) {
            await tx.menuItem.deleteMany({ where: { id: { in: p.supersedesMenuItemIds } } });
            removed += p.supersedesMenuItemIds.length;
          }
          continue;
        }

        // MODIFY — replace the card's rows wholesale, exactly as a re-price
        // does, so a reconciled card is indistinguishable in shape from a
        // steered one.
        if (!p.menuItemId) continue;
        await markAmended(tx, { cardIds: [p.menuItemId] });
        await tx.roleLineItem.deleteMany({ where: { menuItemId: p.menuItemId } });
        if (rows.length > 0) {
          await tx.roleLineItem.createMany({
            data: rows.map((r) => ({
              menuItemId: p.menuItemId!,
              role: r.role,
              title: r.title,
              baseHours: r.baseHours,
              taxedHours: r.taxedHours,
              notes: r.notes,
              provenance: 'STEERED' as const,
              touchesFrontend: r.touchesFrontend,
              touchesBackend: r.touchesBackend,
            })),
          });
        }
        modified += 1;
      }

      await tx.estimateReconciliation.update({
        where: { id: reconciliationId },
        data: {
          status: 'APPLIED',
          stage: 'Applied',
          pct: 100,
          error: null,
          appliedAt: new Date(),
        },
      });

      return { kind: 'APPLIED' as const, added, modified, removed };
    },
    // Generous for the same reason every other ledger write is: a handful of
    // statements over a remote database goes past Prisma's 5s default.
    { maxWait: 15_000, timeout: 120_000 },
  );
}

/** The most recent write anywhere in this estimate's ledger. */
async function currentFingerprint(
  tx: Prisma.TransactionClient,
  estimateId: string,
): Promise<Date | null> {
  const [card, row] = await Promise.all([
    tx.menuItem.findFirst({
      where: { estimateId },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
    tx.roleLineItem.findFirst({
      where: { menuItem: { estimateId } },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
  ]);
  const times = [card?.updatedAt, row?.updatedAt].filter((d): d is Date => d instanceof Date);
  return times.length === 0 ? null : times.reduce((a, b) => (a > b ? a : b));
}
