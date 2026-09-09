import { FOUR_HOUR_CAP, snapToQuarterHour, taxedHoursFor, type TaxPercents } from '@repo/shared';

import type {
  LineProvenance,
  Prisma,
  PrismaClient,
  RoleLineItem as RoleLineItemRow,
  RoleKind,
} from './generated/client/index.js';

/**
 * Region replace — writing a steered edit into the ledger. AEH-238.
 *
 * The pipeline's own persist deletes every card on the estimate before writing
 * the new set (`run-estimate.ts`), which is why a re-run and "keep the
 * corrections I just made" have always been mutually exclusive. This is the
 * narrow version of that write: it deletes exactly the rows a person declared
 * and nothing else.
 *
 * Three rules hold the whole thing up.
 *
 * The write set is PINNED, not re-resolved. `pinnedLineItemIds` was resolved
 * when the job was dispatched, and the applier deletes those ids. Re-resolving
 * the envelope here would be a bug with teeth: somebody adding a QA row to the
 * card while the job ran would have that brand-new row swept into the delete
 * set, destroying a line the person who asked for the edit never saw.
 *
 * Hours are taxed against the estimate's PINNED config, never the active one.
 * The percents arrive as a parameter for exactly that reason — resolving them
 * here would mean this module deciding which config version applies, and
 * AEH-335 exists because that decision was once made in the wrong place and an
 * estimate's stored hours became a mix of two config versions.
 *
 * A row that became locked while the job ran is a hard refusal, never an
 * approvable conflict. See `applyRegionReplace`.
 */

/** One row exactly as it stood. The revert payload, row by row. */
export type RegionSnapshotRow = Pick<
  RoleLineItemRow,
  | 'menuItemId'
  | 'role'
  | 'title'
  | 'baseHours'
  | 'taxedHours'
  | 'notes'
  | 'provenance'
  | 'touchesFrontend'
  | 'touchesBackend'
> & { lineItemId: string; meta: Prisma.JsonValue };

export type RegionSnapshot = {
  rows: RegionSnapshotRow[];
  /** Summed base hours, promoted onto the edit row so trends are a query. */
  baseHours: number;
};

/**
 * The region exactly as it is, for the audit record and the revert.
 *
 * Ordered by id so two snapshots of an unchanged region compare equal, which is
 * what makes "did anything actually change" answerable without a set diff.
 */
export async function snapshotRegion(
  db: PrismaClient,
  lineItemIds: string[],
): Promise<RegionSnapshot> {
  if (lineItemIds.length === 0) return { rows: [], baseHours: 0 };
  const rows = await db.roleLineItem.findMany({
    where: { id: { in: lineItemIds } },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      menuItemId: true,
      role: true,
      title: true,
      baseHours: true,
      taxedHours: true,
      notes: true,
      provenance: true,
      touchesFrontend: true,
      touchesBackend: true,
      meta: true,
    },
  });
  return {
    rows: rows.map(({ id, ...rest }) => ({ lineItemId: id, ...rest })),
    baseHours: rows.reduce((sum, r) => sum + r.baseHours, 0),
  };
}

/**
 * The region's staleness fingerprint: the latest write anywhere in it.
 *
 * Cards as well as rows, because a region can move without any of its rows
 * changing — a card renamed, switched off, or dragged elsewhere all matter to
 * somebody reading the ledger, and all bump `MenuItem.updatedAt`.
 *
 * Null for an empty region, which compares equal to null and so never reports a
 * spurious conflict.
 */
export async function regionFingerprint(
  db: PrismaClient,
  region: { cardIds: string[]; lineItemIds: string[] },
): Promise<Date | null> {
  const [cards, rows] = await Promise.all([
    region.cardIds.length
      ? db.menuItem.aggregate({
          where: { id: { in: region.cardIds } },
          _max: { updatedAt: true },
        })
      : Promise.resolve({ _max: { updatedAt: null } }),
    region.lineItemIds.length
      ? db.roleLineItem.aggregate({
          where: { id: { in: region.lineItemIds } },
          _max: { updatedAt: true },
        })
      : Promise.resolve({ _max: { updatedAt: null } }),
  ]);
  const stamps = [cards._max.updatedAt, rows._max.updatedAt].filter(
    (d): d is Date => d instanceof Date,
  );
  if (stamps.length === 0) return null;
  return new Date(Math.max(...stamps.map((d) => d.getTime())));
}

/** A row the council proposed for the region. */
export type ProposedRow = {
  menuItemId: string;
  role: RoleKind;
  title: string;
  /** Pre-tax. Snapped and capped here regardless of what arrived. */
  baseHours: number;
  notes?: string | null;
  touchesFrontend?: boolean;
  touchesBackend?: boolean;
  /** Envelope structure (complexity tier, requirement id, anchors). */
  meta?: Prisma.InputJsonValue;
};

/**
 * Normalise a proposed row's hours the way the pipeline does.
 *
 * `runSpecialist` already snaps to the quarter hour and splits anything over the
 * four-hour cap, so in the ordinary case this changes nothing. It is here
 * because this is the LAST gate before the ledger, and the failure it prevents
 * is silent: a 3.7-hour row renders perfectly, sums perfectly, and quietly
 * breaks the decomposition rule every other row on the estimate obeys.
 *
 * A row over the cap is clamped rather than split. Splitting here would invent a
 * description for the second half, and inventing content at the persistence
 * layer is exactly the habit this codebase removed — the council is where work
 * gets decomposed.
 */
function normaliseHours(baseHours: number): number {
  const snapped = snapToQuarterHour(Math.max(0, baseHours));
  return Math.min(snapped, FOUR_HOUR_CAP);
}

export type ApplyOutcome =
  | { kind: 'APPLIED'; rowsWritten: number; baseHours: number }
  /**
   * A row in the write set is now locked. Not offered for approval: approving
   * would be a lock bypass with none of the override ceremony, so the edit is
   * failed and the person is told which rows and who holds them.
   */
  | { kind: 'REFUSED_LOCKED'; lockedLineItemIds: string[] }
  /** The region moved. The proposal is parked for a person to decide. */
  | { kind: 'CONFLICT'; observedFingerprint: Date | null };

/**
 * Replace a pinned region with the council's new rows, in one transaction.
 *
 * The order inside the transaction is the durability argument: the snapshot and
 * the edit record are written alongside the ledger change, never after it. A
 * ledger write whose revert payload did not land is worse than no audit at all,
 * and "worse" is precise here — it is a change nobody can explain and nobody can
 * undo.
 *
 * `expectFingerprint` is compared inside the transaction rather than before it.
 * Checking outside would leave a window in which a concurrent write lands
 * between the check and the delete, which is the whole failure the check exists
 * to catch.
 */
export async function applyRegionReplace(
  db: PrismaClient,
  args: {
    editId: string;
    /** Resolved at dispatch. The delete set, exactly. */
    pinnedLineItemIds: string[];
    pinnedCardIds: string[];
    proposed: ProposedRow[];
    /** The buffers in force for THIS estimate's pinned config version. */
    effective: TaxPercents;
    /** What the region looked like when the job started. */
    expectFingerprint: Date | null;
    /** Set when a person approved the write over a concurrent change. */
    overwriteConflict?: boolean;
    reasoning?: string | null;
  },
): Promise<ApplyOutcome> {
  const {
    editId,
    pinnedLineItemIds,
    pinnedCardIds,
    proposed,
    effective,
    expectFingerprint,
    overwriteConflict = false,
    reasoning = null,
  } = args;

  // Outside the transaction: a lock is a refusal, so there is nothing to do
  // atomically with it, and reporting it needs no snapshot.
  const locked = await db.ledgerLock.findMany({
    where: { lineItemId: { in: pinnedLineItemIds } },
    select: { lineItemId: true },
  });
  if (locked.length > 0) {
    await db.ledgerEdit.update({
      where: { id: editId },
      data: {
        status: 'FAILED',
        error: `${locked.length} line${
          locked.length === 1 ? '' : 's'
        } in this selection were locked while the edit was running, so nothing was written. Unlock them and ask again.`,
      },
    });
    return { kind: 'REFUSED_LOCKED', lockedLineItemIds: locked.map((l) => l.lineItemId) };
  }

  const before = await snapshotRegion(db, pinnedLineItemIds);

  const rows = proposed.map((p) => {
    const baseHours = normaliseHours(p.baseHours);
    return {
      menuItemId: p.menuItemId,
      role: p.role,
      title: p.title,
      baseHours,
      taxedHours: taxedHoursFor(baseHours, effective[p.role] ?? 0),
      notes: p.notes ?? null,
      // The council re-priced this against the requirement with a person
      // steering, which is neither the crew's own number nor one somebody
      // typed. See LineProvenance.
      provenance: 'STEERED' as LineProvenance,
      touchesFrontend: p.touchesFrontend ?? false,
      touchesBackend: p.touchesBackend ?? false,
      ...(p.meta === undefined ? {} : { meta: p.meta }),
    };
  });

  const afterBaseHours = rows.reduce((sum, r) => sum + r.baseHours, 0);

  const outcome = await db.$transaction(
    async (tx) => {
      if (!overwriteConflict) {
        const observed = await regionFingerprint(tx as unknown as PrismaClient, {
          cardIds: pinnedCardIds,
          lineItemIds: pinnedLineItemIds,
        });
        const moved =
          (observed?.getTime() ?? null) !== (expectFingerprint?.getTime() ?? null);
        if (moved) {
          await tx.ledgerEdit.update({
            where: { id: editId },
            data: {
              status: 'PENDING_CONFLICT',
              stage: 'Waiting on a decision',
              pct: 100,
              beforeSnapshot: before as unknown as Prisma.InputJsonValue,
              afterSnapshot: { rows } as unknown as Prisma.InputJsonValue,
              rowsBefore: before.rows.length,
              rowsAfter: rows.length,
              hoursBefore: before.baseHours,
              hoursAfter: afterBaseHours,
              reasoning,
            },
          });
          return { kind: 'CONFLICT' as const, observedFingerprint: observed };
        }
      }

      if (pinnedLineItemIds.length > 0) {
        await tx.roleLineItem.deleteMany({ where: { id: { in: pinnedLineItemIds } } });
      }
      // `createManyAndReturn` rather than `createMany`, because a revert has to
      // delete EXACTLY the rows this edit wrote. Identifying them later by card
      // and provenance would also catch an earlier steered edit's rows on the
      // same card, and putting one edit back would silently destroy another's.
      const written =
        rows.length > 0
          ? await tx.roleLineItem.createManyAndReturn({ data: rows, select: { id: true } })
          : [];

      await tx.ledgerEdit.update({
        where: { id: editId },
        data: {
          status: 'APPLIED',
          stage: 'Applied',
          pct: 100,
          error: null,
          appliedAt: new Date(),
          beforeSnapshot: before as unknown as Prisma.InputJsonValue,
          // The ids ride along with the proposed rows rather than in a column of
          // their own: they ARE part of what the after-state turned out to be,
          // and the payload is read by the two callers that already read it.
          afterSnapshot: {
            rows,
            writtenLineItemIds: written.map((w) => w.id),
          } as unknown as Prisma.InputJsonValue,
          rowsBefore: before.rows.length,
          rowsAfter: rows.length,
          hoursBefore: before.baseHours,
          hoursAfter: afterBaseHours,
          overwroteConflict: overwriteConflict,
          reasoning,
        },
      });

      return { kind: 'APPLIED' as const, rowsWritten: rows.length, baseHours: afterBaseHours };
    },
    // Generous, for the same reason the pipeline's persist is: many sequential
    // writes over a remote database push past Prisma's 5s default.
    { maxWait: 15_000, timeout: 60_000 },
  );

  return outcome;
}

/**
 * Put a region back to its snapshot.
 *
 * One level, scoped to the region the prompt touched — the richer undo model,
 * and how it behaves when two people are editing at once, is deliberately left
 * as later work.
 *
 * What comes back is the snapshot's rows with their ORIGINAL provenance, not
 * `STEERED`. A revert is not a third kind of edit; it is the assertion that the
 * edit did not happen, and a row that reads `steered` afterwards would be a
 * record of something that was undone.
 *
 * The rows come back with NEW ids, which is worth knowing: the originals were
 * deleted, and anything holding an old id — an open tab, a stale client — will
 * not find them. Nothing in the schema points at a `RoleLineItem` except a lock,
 * and a locked row can never be in a write set, so there is no dangling
 * reference to repair.
 */
export async function revertRegion(
  db: PrismaClient,
  args: { editId: string; revertedById: string },
): Promise<{ rowsRestored: number }> {
  const edit = await db.ledgerEdit.findUniqueOrThrow({
    where: { id: args.editId },
    select: { status: true, beforeSnapshot: true, afterSnapshot: true },
  });
  if (edit.status !== 'APPLIED') {
    throw new Error(`Only an applied edit can be put back; this one is ${edit.status}.`);
  }

  const snapshot = edit.beforeSnapshot as unknown as RegionSnapshot | null;
  const rows = snapshot?.rows ?? [];
  const after = edit.afterSnapshot as unknown as { writtenLineItemIds?: string[] } | null;
  const writtenLineItemIds = after?.writtenLineItemIds ?? [];

  await db.$transaction(
    async (tx) => {
      // Exactly the rows this edit wrote, by id. Not "steered rows on these
      // cards": that would also sweep up an earlier steered edit's output and
      // putting one edit back would destroy another's.
      if (writtenLineItemIds.length > 0) {
        await tx.roleLineItem.deleteMany({ where: { id: { in: writtenLineItemIds } } });
      }
      if (rows.length > 0) {
        await tx.roleLineItem.createMany({
          data: rows.map((r) => ({
            menuItemId: r.menuItemId,
            role: r.role,
            title: r.title,
            baseHours: r.baseHours,
            taxedHours: r.taxedHours,
            notes: r.notes,
            provenance: r.provenance,
            touchesFrontend: r.touchesFrontend,
            touchesBackend: r.touchesBackend,
            ...(r.meta === null ? {} : { meta: r.meta as Prisma.InputJsonValue }),
          })),
        });
      }
      await tx.ledgerEdit.update({
        where: { id: args.editId },
        data: { status: 'REVERTED', revertedAt: new Date(), revertedById: args.revertedById },
      });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );

  return { rowsRestored: rows.length };
}
