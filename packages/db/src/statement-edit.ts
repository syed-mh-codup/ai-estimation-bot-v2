import type {
  EstimateStatement as EstimateStatementRow,
  Prisma,
  PrismaClient,
} from './generated/client/index.js';

import { markStatementsAmended } from './carriage';

/**
 * Writing a steered statement revision. AEH-238.
 *
 * The statement half of `ledger-edit.ts`, and the same three rules hold it up:
 * the write set is PINNED at dispatch and never re-resolved, a statement that
 * became locked while the job ran is a hard refusal rather than an approvable
 * conflict, and the snapshot is written in the same transaction as the change.
 *
 * ## What is different, and it is worth knowing
 *
 * An hours edit deletes its rows and creates replacements, so a revert gives
 * them new ids. A statement revision UPDATES in place, so ids survive — and
 * when it does delete one (merging two assumptions into one), the revert
 * recreates it with the id it had. So putting a statement revision back is
 * exact in a way putting an hours edit back is not.
 *
 * That is why this is not folded into `applyRegionReplace` with a flag. The two
 * writes have different shapes: one replaces a set, the other patches
 * individual rows and needs to know which it patched.
 */

/** One statement exactly as it stood. The revert payload, line by line. */
export type StatementSnapshotRow = Pick<
  EstimateStatementRow,
  'id' | 'kind' | 'text' | 'order' | 'provenance'
>;

export type StatementSnapshot = {
  rows: StatementSnapshotRow[];
};

/**
 * The statements exactly as they are, for the audit record and the revert.
 *
 * Ordered by id, like `snapshotRegion`, so two snapshots of an unchanged region
 * compare equal.
 */
export async function snapshotStatements(
  db: PrismaClient,
  statementIds: string[],
): Promise<StatementSnapshot> {
  if (statementIds.length === 0) return { rows: [] };
  const rows = await db.estimateStatement.findMany({
    where: { id: { in: statementIds } },
    orderBy: { id: 'asc' },
    select: { id: true, kind: true, text: true, order: true, provenance: true },
  });
  return { rows };
}

/**
 * The staleness fingerprint for a statement region: the latest write in it.
 *
 * Only the statements themselves, unlike `regionFingerprint`, which also reads
 * the cards. There is no container here whose own change matters — a statement
 * belongs to a list, and the list is not a row.
 */
export async function statementFingerprint(
  db: PrismaClient,
  statementIds: string[],
): Promise<Date | null> {
  if (statementIds.length === 0) return null;
  const agg = await db.estimateStatement.aggregate({
    where: { id: { in: statementIds } },
    _max: { updatedAt: true },
  });
  return agg._max.updatedAt ?? null;
}

/** One statement's new wording. Empty text deletes it. */
export type ProposedStatement = {
  statementId: string;
  text: string;
};

export type StatementApplyOutcome =
  | { kind: 'APPLIED'; rewritten: number; deleted: number }
  /**
   * A statement in the write set is now locked. Not offered for approval —
   * approving would be a lock bypass with none of the override ceremony.
   */
  | { kind: 'REFUSED_LOCKED'; lockedStatementIds: string[] }
  /** The region moved. The proposal is parked for a person to decide. */
  | { kind: 'CONFLICT'; observedFingerprint: Date | null };

/**
 * Write the Scribe's wording into the ledger, in one transaction.
 *
 * Only the statements the Scribe actually returned are touched, and only those
 * that are in `pinnedStatementIds`. The intersection is taken here rather than
 * trusted: the agent already drops refs outside the envelope, and this is the
 * boundary that must hold even if that changes.
 *
 * `expectFingerprint` is compared INSIDE the transaction, for the reason
 * `applyRegionReplace` gives — checking outside leaves a window in which a
 * concurrent write lands between the check and the write.
 */
export async function applyStatementRevision(
  db: PrismaClient,
  args: {
    editId: string;
    /** Resolved at dispatch. The only statements this may touch. */
    pinnedStatementIds: string[];
    proposed: ProposedStatement[];
    expectFingerprint: Date | null;
    /** Set when a person approved the write over a concurrent change. */
    overwriteConflict?: boolean;
    reasoning?: string | null;
  },
): Promise<StatementApplyOutcome> {
  const {
    editId,
    pinnedStatementIds,
    proposed,
    expectFingerprint,
    overwriteConflict = false,
    reasoning = null,
  } = args;

  // Outside the transaction: a lock is a refusal, so there is nothing to do
  // atomically with it.
  const locked = await db.statementLock.findMany({
    where: { statementId: { in: pinnedStatementIds } },
    select: { statementId: true },
  });
  if (locked.length > 0) {
    await db.ledgerEdit.update({
      where: { id: editId },
      data: {
        status: 'FAILED',
        error: `${locked.length} statement${
          locked.length === 1 ? '' : 's'
        } in this selection were locked while the edit was running, so nothing was written. Unlock them and ask again.`,
      },
    });
    return { kind: 'REFUSED_LOCKED', lockedStatementIds: locked.map((l) => l.statementId) };
  }

  const pinned = new Set(pinnedStatementIds);
  const writes = proposed.filter((p) => pinned.has(p.statementId));
  const rewrites = writes.filter((w) => w.text.trim().length > 0);
  const deletes = writes.filter((w) => w.text.trim().length === 0);

  const before = await snapshotStatements(db, pinnedStatementIds);

  return db.$transaction(
    async (tx) => {
      if (!overwriteConflict) {
        const agg = await tx.estimateStatement.aggregate({
          where: { id: { in: pinnedStatementIds } },
          _max: { updatedAt: true },
        });
        const observed = agg._max.updatedAt ?? null;
        const moved = (observed?.getTime() ?? null) !== (expectFingerprint?.getTime() ?? null);
        if (moved) {
          await tx.ledgerEdit.update({
            where: { id: editId },
            data: {
              status: 'PENDING_CONFLICT',
              stage: 'Waiting on a decision',
              pct: 100,
              beforeSnapshot: before as unknown as Prisma.InputJsonValue,
              afterSnapshot: { statements: writes } as unknown as Prisma.InputJsonValue,
              rowsBefore: before.rows.length,
              rowsAfter: before.rows.length - deletes.length,
              reasoning,
            },
          });
          return { kind: 'CONFLICT' as const, observedFingerprint: observed };
        }
      }

      // One round trip per rewrite, which is safe HERE and would not be
      // everywhere: `rewrites` is bounded by what a person ticked, so it is a
      // handful. `reconcileStatements` had this shape over a whole list and
      // 485 sequential writes blew a transaction timeout — if a future change
      // lets this reach a whole list, it needs the same bulk treatment.
      for (const w of rewrites) {
        // STEERED, the same distinction the line items make: a person decided,
        // a model wrote the words.
        await tx.estimateStatement.update({
          where: { id: w.statementId },
          data: { text: w.text.trim(), provenance: 'STEERED' },
        });
      }
      // A rewritten assumption is new text, not an amended version of old
      // text — prose has no card underneath it to hold the older claim, so the
      // carried mark simply drops. Deletes need nothing: the row goes. AEH-236.
      await markStatementsAmended(tx, rewrites.map((w) => w.statementId));
      if (deletes.length > 0) {
        await tx.estimateStatement.deleteMany({
          where: { id: { in: deletes.map((d) => d.statementId) } },
        });
      }

      await tx.ledgerEdit.update({
        where: { id: editId },
        data: {
          status: 'APPLIED',
          stage: 'Applied',
          pct: 100,
          error: null,
          appliedAt: new Date(),
          beforeSnapshot: before as unknown as Prisma.InputJsonValue,
          afterSnapshot: { statements: writes } as unknown as Prisma.InputJsonValue,
          rowsBefore: before.rows.length,
          rowsAfter: before.rows.length - deletes.length,
          // No hours moved, and that is the point of this mode rather than an
          // omission. Recording zeros would put a REVISE_STATEMENTS edit into
          // the hours trend as a change of nothing; null keeps it out of it.
          hoursBefore: null,
          hoursAfter: null,
          overwroteConflict: overwriteConflict,
          reasoning,
        },
      });

      return {
        kind: 'APPLIED' as const,
        rewritten: rewrites.length,
        deleted: deletes.length,
      };
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
}

/**
 * Put a statement revision back to its snapshot.
 *
 * Exact, in a way the hours revert is not: a rewritten statement keeps its id,
 * so restoring it is an update, and a deleted one is recreated WITH the id it
 * had. Nothing that referred to these statements ends up pointing at nothing.
 *
 * The provenance restored is the snapshot's own, not `STEERED`. A revert is not
 * a third kind of edit; it is the assertion that the edit did not happen, and a
 * line reading "steered" afterwards would record something that was undone.
 */
export async function revertStatementRevision(
  db: PrismaClient,
  args: { editId: string; revertedById: string },
): Promise<{ statementsRestored: number }> {
  const edit = await db.ledgerEdit.findUniqueOrThrow({
    where: { id: args.editId },
    select: { status: true, mode: true, estimateId: true, beforeSnapshot: true },
  });
  if (edit.status !== 'APPLIED') {
    throw new Error(`Only an applied edit can be put back; this one is ${edit.status}.`);
  }
  if (edit.mode !== 'REVISE_STATEMENTS') {
    throw new Error('This edit did not change any statements.');
  }

  const snapshot = edit.beforeSnapshot as unknown as StatementSnapshot | null;
  const rows = snapshot?.rows ?? [];

  // Same rule as the hours revert, and the same omission it was fixing: the
  // upsert below rewrites text and provenance, so a statement locked since this
  // edit applied would have its wording replaced with a lock still standing
  // over it.
  if (rows.length > 0) {
    const locked = await db.statementLock.findMany({
      where: { statementId: { in: rows.map((r) => r.id) } },
      select: { statementId: true },
    });
    if (locked.length > 0) {
      throw new Error(
        `${locked.length} line${
          locked.length === 1 ? ' this edit changed is' : 's this edit changed are'
        } now locked, so putting it back would overwrite settled wording. Unlock ${
          locked.length === 1 ? 'it' : 'them'
        } first.`,
      );
    }
  }

  await db.$transaction(
    async (tx) => {
      // Bounded by the edit's own snapshot, so the same handful — see the
      // note in `applyStatementRevision`.
      for (const row of rows) {
        // An upsert rather than an update, because a merge deleted one of these
        // and it has to come back. Same id: see the note above.
        await tx.estimateStatement.upsert({
          where: { id: row.id },
          update: { text: row.text, order: row.order, provenance: row.provenance },
          create: {
            id: row.id,
            estimateId: edit.estimateId,
            kind: row.kind,
            text: row.text,
            order: row.order,
            provenance: row.provenance,
          },
        });
      }
      await tx.ledgerEdit.update({
        where: { id: args.editId },
        data: { status: 'REVERTED', revertedAt: new Date(), revertedById: args.revertedById },
      });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );

  return { statementsRestored: rows.length };
}
