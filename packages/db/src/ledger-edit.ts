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
  /**
   * What this row's number IS, when it is not the council's steered output.
   *
   * Defaults to `STEERED`, which is right for everything the council actually
   * re-priced. The exception is a row carried through untouched because its
   * card had no requirement to price against: it was not re-priced, so
   * stamping it `STEERED` would record a re-assessment nobody made and, on a
   * hand-typed row, overwrite the `HUMAN` flag that says a person set it.
   */
  provenance?: LineProvenance;
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
   * The region has rows and the council proposed none, so there is nothing to
   * write and deleting is not the answer.
   *
   * Its own outcome rather than an empty APPLIED, because the two are opposite
   * news. An edit that produced nothing is a failure to report; a delete of
   * everything it was pointed at, recorded as success, is the loudest possible
   * way for this feature to lose somebody's work.
   */
  | { kind: 'REFUSED_EMPTY'; rowsAtRisk: number }
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

  /**
   * Refuse when anything in the write set is locked.
   *
   * Called twice: once here, cheaply, so a refusal costs no snapshot and no
   * transaction — and again INSIDE the transaction below, which is the one that
   * matters.
   *
   * The reason it has to be inside is a window this code used to leave open. A
   * `lockRegion` call landing between the check and the `deleteMany` inserts a
   * `LedgerLock` row, and the fingerprint comparison cannot see it —
   * `ledgerLock.createMany` touches neither `RoleLineItem.updatedAt` nor
   * `MenuItem.updatedAt`, so `moved` stays false. The delete then ran and took
   * the lock with it by cascade: no error, no `LockEvent`, a lock nobody
   * removed. Exactly the failure the in-transaction fingerprint check exists
   * to close, on a table the fingerprint does not cover.
   */
  const lockedIn = async (client: Prisma.TransactionClient): Promise<string[]> =>
    (
      await client.ledgerLock.findMany({
        where: { lineItemId: { in: pinnedLineItemIds } },
        select: { lineItemId: true },
      })
    ).map((l) => l.lineItemId);

  const refuseLocked = async (
    client: Prisma.TransactionClient,
    lockedLineItemIds: string[],
  ): Promise<ApplyOutcome> => {
    await client.ledgerEdit.update({
      where: { id: editId },
      data: {
        status: 'FAILED',
        error: `${lockedLineItemIds.length} line${
          lockedLineItemIds.length === 1 ? '' : 's'
        } in this selection were locked while the edit was running, so nothing was written. Unlock them and ask again.`,
      },
    });
    return { kind: 'REFUSED_LOCKED', lockedLineItemIds };
  };

  const lockedEarly = await lockedIn(db as unknown as Prisma.TransactionClient);
  if (lockedEarly.length > 0) {
    return refuseLocked(db as unknown as Prisma.TransactionClient, lockedEarly);
  }

  // An empty proposal over a non-empty region. Refused, never applied.
  //
  // The path that gets here is real: `rolesInPlay` intersects the pinned rows'
  // roles with the declared ones, and `resolveTarget` documents that a LINE
  // target ignores `roles` — so a LINE-scoped edit whose roles omit that line's
  // own role pins the row, yields no slices, and arrives with nothing to write.
  // The council returning no line items for every slice reaches the same place.
  // Without this, the delete below ran and the edit was stamped APPLIED with
  // `hoursAfter: 0`.
  if (proposed.length === 0 && pinnedLineItemIds.length > 0) {
    await db.ledgerEdit.update({
      where: { id: editId },
      data: {
        status: 'FAILED',
        stage: 'Nothing to write',
        pct: 100,
        error: `The council proposed no lines for this selection, so nothing was written — the ${
          pinnedLineItemIds.length
        } line${
          pinnedLineItemIds.length === 1 ? '' : 's'
        } it covers are untouched. Check that the roles you ticked are the ones this selection actually has.`,
        reasoning,
      },
    });
    return { kind: 'REFUSED_EMPTY', rowsAtRisk: pinnedLineItemIds.length };
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
      // typed. See LineProvenance — and `ProposedRow.provenance` for the one
      // case that overrides it.
      provenance: p.provenance ?? ('STEERED' as LineProvenance),
      touchesFrontend: p.touchesFrontend ?? false,
      touchesBackend: p.touchesBackend ?? false,
      ...(p.meta === undefined ? {} : { meta: p.meta }),
    };
  });

  const afterBaseHours = rows.reduce((sum, r) => sum + r.baseHours, 0);

  const outcome = await db.$transaction(
    async (tx) => {
      // The check that actually holds. See `lockedIn`.
      const lockedNow = await lockedIn(tx);
      if (lockedNow.length > 0) return refuseLocked(tx, lockedNow);

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

/** One card the restructure should end up with. */
export type RestructureCard = {
  /** Reuse this existing card row, or null to create a new one. */
  reuseMenuItemId: string | null;
  title: string;
  taxonomyKey: string;
  category: string | null;
  phase: string | null;
  /** Existing line items that belong here after the move. */
  lineItemIds: string[];
};

export type RestructureOutcome = {
  /** The cards the region now consists of, in order. */
  cardIds: string[];
  /** Cards that ended up empty and were removed. */
  removedCardIds: string[];
};

/**
 * Reshape a set of cards: move the lines, create what is needed, remove what is
 * left empty. AEH-238.
 *
 * Lines are MOVED — `menuItemId` reassigned — not deleted and recreated. That
 * keeps their ids, their provenance, their envelope meta and anything pointing
 * at them, which matters because a restructure is usually followed by a re-cost
 * and the council needs to see the rows as they stand.
 *
 * Three cascades, and none of them is the model's judgement to make:
 *
 * `matchScore` goes null on every card this touches. It is the Archivist's
 * measured similarity to past work, so half a card is no longer the thing that
 * was matched — and promotion and writeback read it, so a plausible invented
 * figure would quietly corrupt the preset library.
 *
 * Scope-scenario picks and dependency edges for the affected cards are dropped,
 * by the rule the pipeline's own persist already states: dependencies, and the
 * scopes cut from them, are properties of one particular set of cards. A split
 * replaced that set.
 *
 * A hidden-work finding's card link is cleared while its outcome survives —
 * also the existing precedent. What somebody decided about a risk is a fact;
 * which card it landed in is not, once that card has been reshaped.
 */
export async function applyRestructure(
  db: PrismaClient,
  args: { estimateId: string; sourceCardIds: string[]; cards: RestructureCard[] },
): Promise<RestructureOutcome> {
  const { estimateId, sourceCardIds, cards } = args;

  const sources = await db.menuItem.findMany({
    where: { id: { in: sourceCardIds }, estimateId },
    select: { id: true, sectionId: true, order: true, injected: true, overhead: true, meta: true },
  });
  if (sources.length === 0) return { cardIds: [], removedCardIds: [] };

  // New cards join the first source's section, immediately after it, so a split
  // appears where the person was looking rather than at the bottom of the board.
  const anchor = sources.reduce((lowest, s) => (s.order < lowest.order ? s : lowest), sources[0]!);

  return db.$transaction(
    async (tx) => {
      const cardIds: string[] = [];

      for (const [index, card] of cards.entries()) {
        let menuItemId = card.reuseMenuItemId;

        if (menuItemId && sources.some((s) => s.id === menuItemId)) {
          await tx.menuItem.update({
            where: { id: menuItemId },
            data: {
              title: card.title,
              taxonomyKey: card.taxonomyKey,
              category: card.category,
              phase: card.phase,
              // Never carried, never invented. See the note above.
              matchScore: null,
            },
          });
        } else {
          const created = await tx.menuItem.create({
            data: {
              estimateId,
              title: card.title,
              taxonomyKey: card.taxonomyKey,
              category: card.category,
              phase: card.phase,
              sectionId: anchor.sectionId,
              order: anchor.order + index,
              // A card carved out of an injected one is still inferred work,
              // and a card carved out of an overhead one is still overhead:
              // both flags change behaviour elsewhere and must not be lost.
              injected: anchor.injected,
              overhead: anchor.overhead,
              // The requirement ids come from the source, because that is what
              // the work is still against — a split does not re-classify it.
              meta: anchor.meta ?? undefined,
              matchScore: null,
            },
            select: { id: true },
          });
          menuItemId = created.id;
        }

        if (card.lineItemIds.length > 0) {
          await tx.roleLineItem.updateMany({
            where: { id: { in: card.lineItemIds } },
            data: { menuItemId },
          });
        }
        cardIds.push(menuItemId);
      }

      // Anything left with no lines was emptied by the move. Removing it is the
      // merge half of this operation: two cards become one, and the loser goes.
      const emptied = await tx.menuItem.findMany({
        where: { id: { in: sourceCardIds.filter((id) => !cardIds.includes(id)) } },
        select: { id: true, _count: { select: { lineItems: true } } },
      });
      const removedCardIds = emptied.filter((e) => e._count.lineItems === 0).map((e) => e.id);

      const touched = [...new Set([...cardIds, ...removedCardIds])];

      // The scopes cut from this set of cards, and the graph over it, are no
      // longer about the cards that exist. Same rule the run persist states.
      await tx.scopeScenarioPick.deleteMany({ where: { menuItemId: { in: touched } } });
      await tx.menuItemDependency.deleteMany({
        where: {
          estimateId,
          OR: [{ dependentId: { in: touched } }, { prerequisiteId: { in: touched } }],
        },
      });
      // The decision survives; the link does not.
      await tx.hiddenWorkFinding.updateMany({
        where: { estimateId, menuItemId: { in: touched } },
        data: { menuItemId: null },
      });

      if (removedCardIds.length > 0) {
        await tx.menuItem.deleteMany({ where: { id: { in: removedCardIds } } });
      }

      return { cardIds, removedCardIds };
    },
    { maxWait: 15_000, timeout: 60_000 },
  );
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
    select: { status: true, mode: true, beforeSnapshot: true, afterSnapshot: true },
  });
  if (edit.status !== 'APPLIED') {
    throw new Error(`Only an applied edit can be put back; this one is ${edit.status}.`);
  }
  // A restructure is deliberately not revertible, and saying so is better than
  // a revert that half-works. Putting the rows back where they came from would
  // leave the cards the split CREATED sitting empty, and could not resurrect a
  // card the merge deleted — so the ledger would end up in a state that is
  // neither before nor after. Undoing a reshape properly belongs with the
  // richer undo model, which is explicitly later work.
  if (edit.mode !== 'REPRICE') {
    throw new Error(
      'A split or merge cannot be put back automatically — the cards it created would be left behind and the ones it removed cannot be restored. Reshape it by hand, or re-price from here.',
    );
  }

  const snapshot = edit.beforeSnapshot as unknown as RegionSnapshot | null;
  const rows = snapshot?.rows ?? [];
  const after = edit.afterSnapshot as unknown as { writtenLineItemIds?: string[] } | null;
  const writtenLineItemIds = after?.writtenLineItemIds ?? [];

  // A revert is a WRITE, and it was the only one in this feature that did not
  // ask about locks. The sequence that matters: an edit applies, a reviewer
  // locks one of the rows it wrote, somebody puts the edit back — the
  // `deleteMany` below would take the locked row with it and the lock would
  // cascade away. No error, no LockEvent, a lock nobody removed.
  if (writtenLineItemIds.length > 0) {
    const locked = await db.ledgerLock.findMany({
      where: { lineItemId: { in: writtenLineItemIds } },
      select: { lineItemId: true },
    });
    if (locked.length > 0) {
      throw new Error(
        `${locked.length} line${
          locked.length === 1 ? ' this edit wrote is' : 's this edit wrote are'
        } now locked, so putting it back would destroy settled work. Unlock ${
          locked.length === 1 ? 'it' : 'them'
        } first.`,
      );
    }
  }

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
