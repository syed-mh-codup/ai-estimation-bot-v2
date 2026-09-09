import type {
  LedgerLock as LedgerLockRow,
  LockScope,
  PrismaClient,
  RoleKind,
} from './generated/client/index.js';

/**
 * Ledger locks, and the addressing concept they share with the edit envelope —
 * AEH-238.
 *
 * A lock says one `RoleLineItem`'s hours, its description and its existence are
 * settled. It binds PEOPLE as well as the AI: this is a permission layer on the
 * ledger that the edit engine happens to also respect, not an AI-only guard.
 *
 * The one thing to understand before changing anything here: a lock and a
 * selection are the same coordinate system read in opposite directions. A human
 * declares what may change by selecting `scope x role`, and declares what may
 * NOT change by locking `scope x role`. So `resolveTarget` below is the single
 * function that turns either declaration into concrete row ids, and the whole
 * enforcement rule is one line on top of it:
 *
 *     refuse when the selection intersects a lock; otherwise the write set is
 *     exactly the selection, and nothing outside it is writable.
 *
 * Two consequences that are easy to undo by accident:
 *
 * Locks are MATERIALISED to rows when they are taken, never evaluated live.
 * A section-scoped lock tested against current membership would evaporate the
 * moment somebody dragged a card out of that section — and dragging is
 * deliberately allowed, because placement is presentational. The two rules only
 * coexist if a lock is pinned to the rows at the moment it is declared.
 *
 * The envelope NEVER cascades. `@repo/shared`'s `scope-selection` also resolves
 * a selection over cards, but it is the scope configurator's: it walks the
 * dependency graph and pulls prerequisites in. Reusing it here would silently
 * widen a boundary a human drew deliberately, which is the one thing this
 * mechanism exists to prevent.
 */

/** What a human pointed at. `LINE` already implies its own role. */
export type LockTarget =
  | { scope: 'ESTIMATE' }
  | { scope: 'SECTION'; id: string }
  | { scope: 'CARD'; id: string }
  | { scope: 'LINE'; id: string };

/**
 * One declaration on the two axes: what was pointed at, and which roles of it.
 *
 * `roles` is ignored for a `LINE` target, which carries exactly one role of its
 * own. An empty `roles` on any other target resolves to nothing rather than to
 * everything — a selection nobody narrowed is a mistake, and the permissive
 * reading of it is the one that does damage.
 */
export type LockEnvelope = { target: LockTarget; roles: readonly RoleKind[] };

/**
 * A frozen row, and who froze it.
 *
 * Picked from the generated row type rather than written out, following
 * `menu-item-mapping.ts`. Not only for brevity: the orphan-field audit
 * attributes a read to a model by the RECEIVER's type, so a hand-written
 * look-alike would make every `lock.declaredScope` in the app invisible to it
 * and report live columns as orphans.
 */
export type LockInfo = Pick<
  LedgerLockRow,
  'lineItemId' | 'lockedById' | 'lockedAt' | 'declaredScope' | 'declaredTargetId'
>;

/** `declaredTargetId` for a target — null only for the whole estimate. */
function targetId(target: LockTarget): string | null {
  return target.scope === 'ESTIMATE' ? null : target.id;
}

/**
 * The concrete line-item ids one declaration covers, right now.
 *
 * The only place the axes are interpreted, so a lock and a write set can never
 * disagree about what "DEV on this card" means. Scoped to `estimateId` in every
 * branch: a card or line id from a stale client must not be able to reach
 * another estimate's rows.
 */
export async function resolveTarget(
  db: PrismaClient,
  estimateId: string,
  envelope: LockEnvelope,
): Promise<string[]> {
  const { target, roles } = envelope;

  if (target.scope === 'LINE') {
    // Verified through the card rather than trusted: the row must belong to
    // this estimate. Role is not filtered — a line IS one role.
    const row = await db.roleLineItem.findFirst({
      where: { id: target.id, menuItem: { estimateId } },
      select: { id: true },
    });
    return row ? [row.id] : [];
  }

  if (roles.length === 0) return [];

  const menuItem =
    target.scope === 'CARD'
      ? { estimateId, id: target.id }
      : target.scope === 'SECTION'
        ? { estimateId, sectionId: target.id }
        : { estimateId };

  const rows = await db.roleLineItem.findMany({
    where: { menuItem, role: { in: [...roles] } },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Which of these rows are locked. Absent from the map means free. */
export async function locksOn(db: PrismaClient, lineItemIds: string[]): Promise<Map<string, LockInfo>> {
  if (lineItemIds.length === 0) return new Map();
  const locks = await db.ledgerLock.findMany({
    where: { lineItemId: { in: lineItemIds } },
    select: {
      lineItemId: true,
      lockedById: true,
      lockedAt: true,
      declaredScope: true,
      declaredTargetId: true,
    },
  });
  return new Map(locks.map((l) => [l.lineItemId, l]));
}

export type LockWriteResult = {
  /** Rows frozen by this call. */
  locked: string[];
  /** Rows that were already frozen, so this call left them alone. */
  alreadyLocked: LockInfo[];
};

/**
 * Freeze everything one declaration covers.
 *
 * Idempotent by construction rather than by checking first: `LedgerLock` is
 * unique on `lineItemId`, so `createMany` with `skipDuplicates` cannot produce
 * a second lock on a row even if two people submit overlapping selections at
 * the same instant. The rows that lost are reported, not silently dropped —
 * "you locked 14 of 16, Alice already had the other two" is a different thing
 * to be told than "done".
 *
 * The event rows are written in the same transaction, because a lock whose
 * history did not land is a lock nobody can later explain.
 */
export async function lockEnvelope(
  db: PrismaClient,
  args: { estimateId: string; envelope: LockEnvelope; actorId: string },
): Promise<LockWriteResult> {
  const { estimateId, envelope, actorId } = args;
  const ids = await resolveTarget(db, estimateId, envelope);
  if (ids.length === 0) return { locked: [], alreadyLocked: [] };

  const existing = await locksOn(db, ids);
  const fresh = ids.filter((id) => !existing.has(id));
  if (fresh.length === 0) return { locked: [], alreadyLocked: [...existing.values()] };

  const declaredScope = envelope.target.scope;
  const declaredTargetId = targetId(envelope.target);

  await db.$transaction(async (tx) => {
    await tx.ledgerLock.createMany({
      data: fresh.map((lineItemId) => ({
        estimateId,
        lineItemId,
        declaredScope,
        declaredTargetId,
        lockedById: actorId,
      })),
      skipDuplicates: true,
    });
    await tx.lockEvent.createMany({
      data: fresh.map((lineItemId) => ({
        estimateId,
        lineItemId,
        kind: 'LOCKED' as const,
        declaredScope,
        declaredTargetId,
        actorId,
      })),
    });
  });

  return { locked: fresh, alreadyLocked: [...existing.values()] };
}

export type UnlockResult = {
  /** Rows this call freed. */
  unlocked: string[];
  /**
   * Locks held by somebody else that this call refused to touch. Empty when
   * `override` was passed.
   */
  heldByOthers: LockInfo[];
};

/**
 * Release everything one declaration covers.
 *
 * Whoever set a lock may remove it freely. Anyone else has to pass `override`,
 * which is the confirmation step — no reason is required, deliberately: a
 * simple audited record is the preventative measure here, and a mandatory
 * justification on every unlock collects nothing but the word "adjusting".
 * The record is what stops an override being the same as the lock never having
 * been set, so an overridden release is its own event kind rather than a flag.
 *
 * Without `override`, other people's locks are reported and left in place —
 * a partial release, not a refusal of the whole call. Releasing your own eight
 * rows should not fail because a colleague holds a ninth.
 */
export async function unlockEnvelope(
  db: PrismaClient,
  args: { estimateId: string; envelope: LockEnvelope; actorId: string; override?: boolean },
): Promise<UnlockResult> {
  const { estimateId, envelope, actorId, override = false } = args;
  const ids = await resolveTarget(db, estimateId, envelope);
  if (ids.length === 0) return { unlocked: [], heldByOthers: [] };

  const existing = await locksOn(db, ids);
  if (existing.size === 0) return { unlocked: [], heldByOthers: [] };

  const mine = [...existing.values()].filter((l) => l.lockedById === actorId);
  const others = [...existing.values()].filter((l) => l.lockedById !== actorId);
  const releasing = override ? [...mine, ...others] : mine;
  if (releasing.length === 0) return { unlocked: [], heldByOthers: others };

  await db.$transaction(async (tx) => {
    await tx.ledgerLock.deleteMany({ where: { lineItemId: { in: releasing.map((l) => l.lineItemId) } } });
    await tx.lockEvent.createMany({
      data: releasing.map((l) => ({
        estimateId,
        lineItemId: l.lineItemId,
        // The kind records whose lock it was, not who clicked: releasing your
        // own is UNLOCKED even in a call that overrode somebody else's too.
        kind: l.lockedById === actorId ? ('UNLOCKED' as const) : ('OVERRIDDEN' as const),
        declaredScope: l.declaredScope,
        declaredTargetId: l.declaredTargetId,
        actorId,
        priorHolderId: l.lockedById,
      })),
    });
  });

  return {
    unlocked: releasing.map((l) => l.lineItemId),
    heldByOthers: override ? [] : others,
  };
}

/**
 * Every lock on one estimate, plus the two derived card-level facts the guards
 * and the UI both need.
 *
 * Both facts are DERIVED from the row locks rather than stored, so the two ways
 * of arriving at a fully locked card — locking it once, or ticking all four
 * roles over time — are indistinguishable, which they should be. A card with no
 * rows at all is not locked: "every row is frozen" is vacuously true of nothing
 * and reading it as locked would freeze an empty card nobody had touched.
 */
export async function lockStateFor(
  db: PrismaClient,
  estimateId: string,
): Promise<{
  byLineItem: Map<string, LockInfo>;
  /** Cards carrying at least one locked row: existence and enablement frozen. */
  cardsWithAnyLock: Set<string>;
  /** Cards where every row is locked: the title is frozen too. */
  cardsFullyLocked: Set<string>;
}> {
  const [locks, rows] = await Promise.all([
    db.ledgerLock.findMany({
      where: { estimateId },
      select: {
        lineItemId: true,
        lockedById: true,
        lockedAt: true,
        declaredScope: true,
        declaredTargetId: true,
      },
    }),
    db.roleLineItem.findMany({
      where: { menuItem: { estimateId } },
      select: { id: true, menuItemId: true },
    }),
  ]);

  const byLineItem = new Map(locks.map((l) => [l.lineItemId, l]));
  const cardsWithAnyLock = new Set<string>();
  const total = new Map<string, number>();
  const frozen = new Map<string, number>();

  for (const row of rows) {
    total.set(row.menuItemId, (total.get(row.menuItemId) ?? 0) + 1);
    if (byLineItem.has(row.id)) {
      cardsWithAnyLock.add(row.menuItemId);
      frozen.set(row.menuItemId, (frozen.get(row.menuItemId) ?? 0) + 1);
    }
  }

  const cardsFullyLocked = new Set<string>();
  for (const [menuItemId, count] of total) {
    if (count > 0 && frozen.get(menuItemId) === count) cardsFullyLocked.add(menuItemId);
  }

  return { byLineItem, cardsWithAnyLock, cardsFullyLocked };
}

/** One row's lock story, oldest first. Outlives the locks it describes. */
export async function lockHistoryFor(
  db: PrismaClient,
  estimateId: string,
  lineItemId: string,
): Promise<
  Array<{
    kind: 'LOCKED' | 'UNLOCKED' | 'OVERRIDDEN';
    declaredScope: LockScope;
    actorId: string;
    priorHolderId: string | null;
    createdAt: Date;
  }>
> {
  return db.lockEvent.findMany({
    where: { estimateId, lineItemId },
    orderBy: { createdAt: 'asc' },
    select: {
      kind: true,
      declaredScope: true,
      actorId: true,
      priorHolderId: true,
      createdAt: true,
    },
  });
}

/**
 * The enforcement rule itself: does a proposed write set touch anything frozen.
 *
 * Returns the offending locks rather than a boolean, because every refusal in
 * this feature has to be able to name what is locked and who locked it. A
 * refusal that just says no sends someone hunting through seventy-seven rows.
 */
export async function lockedWithin(
  db: PrismaClient,
  estimateId: string,
  envelope: LockEnvelope,
): Promise<LockInfo[]> {
  const ids = await resolveTarget(db, estimateId, envelope);
  const locks = await locksOn(db, ids);
  return [...locks.values()];
}
