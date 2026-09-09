import type {
  PrismaClient,
  StatementKind,
  StatementLock as StatementLockRow,
} from './generated/client/index.js';

/**
 * Locks on the narrative and the assumptions — AEH-238.
 *
 * The sibling of `ledger-locks.ts`, and read alongside it. Everything the
 * header there says about the coordinate system holds here: a lock and a
 * selection are the same declaration read in opposite directions, the
 * declaration is materialised to concrete ids when it is made rather than
 * evaluated live, and the enforcement rule is one line —
 *
 *     refuse when the selection intersects a lock; otherwise the write set is
 *     exactly the selection.
 *
 * ## Why this is a sibling and not a generic
 *
 * The algorithm here is the same algorithm, over a different table. It was
 * worth trying to share, and the sharing is worse: a generic over two Prisma
 * delegates loses the typed `where` and `select` that make the queries readable
 * and makes the orphan-field audit unable to attribute a single read. So the
 * shape is duplicated deliberately, in one file, next to the one it mirrors.
 *
 * What IS shared is the part a person sees: `lockHistoryFor` reads both kinds
 * of subject out of the one `LockEvent` table, so the hover story and the
 * three-state padlock have exactly one implementation.
 *
 * ## What differs, and it is only this
 *
 * There is no role axis. A statement is one sentence — a description and
 * nothing else — so `scope x role` does not describe it, and no role dimension
 * is invented for the sake of symmetry. The two scopes are "this statement" and
 * "this whole list".
 *
 * And the trap. `reconcileStatements` matches the submitted list to existing
 * rows BY TEXT, which means rewording a statement is a delete plus a create.
 * The foreign key from `StatementLock` cascades, so if a reworded save were
 * allowed to run, the lock would be deleted along with the row it was
 * protecting — silently, and looking exactly like an unlock nobody performed.
 * `lockedStatementTextsMissing` below is what stops that, and it has to be
 * asked BEFORE the reconcile.
 *
 * ## There is no `lockedStatementsWithin`
 *
 * `ledger-locks.ts` has `lockedWithin` because a buffer change declares an
 * envelope it never resolves itself. Nothing on this axis does that: a
 * statement edit resolves its own write set at dispatch and asks
 * `statementLocksOn` about the ids it got, and a list save asks the question
 * above instead. A mirror of `lockedWithin` was written here and deleted — it
 * had no caller, and an unused guard is worse than no guard, because it reads
 * as though something is checking.
 */

/** What a human pointed at. Neither value has a role dimension. */
export type StatementTarget =
  | { scope: 'STATEMENT'; id: string }
  | { scope: 'STATEMENT_LIST'; kind: StatementKind };

/**
 * A frozen statement, and who froze it.
 *
 * `Pick` from the generated row rather than a hand-written look-alike, for the
 * reason `LockInfo` states: the orphan-field audit attributes a read by the
 * receiver's type, and a look-alike would report live columns as orphans.
 */
export type StatementLockInfo = Pick<
  StatementLockRow,
  'statementId' | 'lockedById' | 'lockedAt' | 'declaredScope' | 'declaredTargetId'
>;

const LOCK_SELECT = {
  statementId: true,
  lockedById: true,
  lockedAt: true,
  declaredScope: true,
  declaredTargetId: true,
} as const;

/** `declaredTargetId` for a target: the statement id, or the kind. */
function targetId(target: StatementTarget): string {
  return target.scope === 'STATEMENT' ? target.id : target.kind;
}

/**
 * The concrete statement ids one declaration covers, right now.
 *
 * The single place the statement axis is interpreted, so a lock and a write set
 * cannot disagree about what "the assumptions" means. Scoped to `estimateId` in
 * both branches: a statement id from a stale client must not reach another
 * estimate's rows.
 */
export async function resolveStatementTarget(
  db: PrismaClient,
  estimateId: string,
  target: StatementTarget,
): Promise<string[]> {
  if (target.scope === 'STATEMENT') {
    const row = await db.estimateStatement.findFirst({
      where: { id: target.id, estimateId },
      select: { id: true },
    });
    return row ? [row.id] : [];
  }

  const rows = await db.estimateStatement.findMany({
    where: { estimateId, kind: target.kind },
    orderBy: { order: 'asc' },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Which of these statements are locked. Absent from the map means free. */
export async function statementLocksOn(
  db: PrismaClient,
  statementIds: string[],
): Promise<Map<string, StatementLockInfo>> {
  if (statementIds.length === 0) return new Map();
  const locks = await db.statementLock.findMany({
    where: { statementId: { in: statementIds } },
    select: LOCK_SELECT,
  });
  return new Map(locks.map((l) => [l.statementId, l]));
}

export type StatementLockWriteResult = {
  /** Statements frozen by this call. */
  locked: string[];
  /** Statements that were already frozen, so this call left them alone. */
  alreadyLocked: StatementLockInfo[];
};

/**
 * Freeze everything one declaration covers.
 *
 * Idempotent by construction, like `lockEnvelope`: `StatementLock` is unique on
 * `statementId`, so `skipDuplicates` cannot produce a second lock on one
 * statement even under two simultaneous overlapping calls. The losers are
 * reported rather than dropped.
 */
export async function lockStatements(
  db: PrismaClient,
  args: { estimateId: string; target: StatementTarget; actorId: string },
): Promise<StatementLockWriteResult> {
  const { estimateId, target, actorId } = args;
  const ids = await resolveStatementTarget(db, estimateId, target);
  if (ids.length === 0) return { locked: [], alreadyLocked: [] };

  const existing = await statementLocksOn(db, ids);
  const fresh = ids.filter((id) => !existing.has(id));
  if (fresh.length === 0) return { locked: [], alreadyLocked: [...existing.values()] };

  const declaredScope = target.scope;
  const declaredTargetId = targetId(target);

  await db.$transaction(async (tx) => {
    await tx.statementLock.createMany({
      data: fresh.map((statementId) => ({
        estimateId,
        statementId,
        declaredScope,
        declaredTargetId,
        lockedById: actorId,
      })),
      skipDuplicates: true,
    });
    await tx.lockEvent.createMany({
      data: fresh.map((statementId) => ({
        estimateId,
        statementId,
        kind: 'LOCKED' as const,
        declaredScope,
        declaredTargetId,
        actorId,
      })),
    });
  });

  return { locked: fresh, alreadyLocked: [...existing.values()] };
}

export type StatementUnlockResult = {
  /** Statements this call freed. */
  unlocked: string[];
  /** Locks held by somebody else, left in place. Empty when `override` was passed. */
  heldByOthers: StatementLockInfo[];
};

/**
 * Release everything one declaration covers.
 *
 * Same rule as the ledger: your own locks come off freely, anyone else's needs
 * `override`, and an overridden release is its own event kind rather than a
 * flag — it is the event an auditor is looking for, so it should be findable by
 * kind. Without `override`, other people's locks are reported and left alone,
 * which makes this a partial release rather than a refusal of the whole call.
 */
export async function unlockStatements(
  db: PrismaClient,
  args: { estimateId: string; target: StatementTarget; actorId: string; override?: boolean },
): Promise<StatementUnlockResult> {
  const { estimateId, target, actorId, override = false } = args;
  const ids = await resolveStatementTarget(db, estimateId, target);
  if (ids.length === 0) return { unlocked: [], heldByOthers: [] };

  const existing = await statementLocksOn(db, ids);
  if (existing.size === 0) return { unlocked: [], heldByOthers: [] };

  const mine = [...existing.values()].filter((l) => l.lockedById === actorId);
  const others = [...existing.values()].filter((l) => l.lockedById !== actorId);
  const releasing = override ? [...mine, ...others] : mine;
  if (releasing.length === 0) return { unlocked: [], heldByOthers: others };

  await db.$transaction(async (tx) => {
    await tx.statementLock.deleteMany({
      where: { statementId: { in: releasing.map((l) => l.statementId) } },
    });
    await tx.lockEvent.createMany({
      data: releasing.map((l) => ({
        estimateId,
        statementId: l.statementId,
        // Whose lock it was, not who clicked: releasing your own is UNLOCKED
        // even in a call that overrode somebody else's too.
        kind: l.lockedById === actorId ? ('UNLOCKED' as const) : ('OVERRIDDEN' as const),
        declaredScope: l.declaredScope,
        declaredTargetId: l.declaredTargetId,
        actorId,
        priorHolderId: l.lockedById,
      })),
    });
  });

  return {
    unlocked: releasing.map((l) => l.statementId),
    heldByOthers: override ? [] : others,
  };
}

/**
 * Every statement lock on one estimate, plus which whole lists are frozen.
 *
 * `listsFullyLocked` is DERIVED rather than stored, for the reason
 * `lockStateFor` gives: locking the list once and ticking every line by hand
 * should be indistinguishable, because they say the same thing. An empty list
 * is not locked — "every line is frozen" is vacuously true of nothing, and
 * reading that as locked would freeze a list nobody had written yet.
 */
export async function statementLockStateFor(
  db: PrismaClient,
  estimateId: string,
): Promise<{
  byStatement: Map<string, StatementLockInfo>;
  listsFullyLocked: Set<StatementKind>;
}> {
  const [locks, rows] = await Promise.all([
    db.statementLock.findMany({ where: { estimateId }, select: LOCK_SELECT }),
    db.estimateStatement.findMany({ where: { estimateId }, select: { id: true, kind: true } }),
  ]);

  const byStatement = new Map(locks.map((l) => [l.statementId, l]));
  const total = new Map<StatementKind, number>();
  const frozen = new Map<StatementKind, number>();
  for (const row of rows) {
    total.set(row.kind, (total.get(row.kind) ?? 0) + 1);
    if (byStatement.has(row.id)) frozen.set(row.kind, (frozen.get(row.kind) ?? 0) + 1);
  }

  const listsFullyLocked = new Set<StatementKind>();
  for (const [kind, count] of total) {
    if (count > 0 && frozen.get(kind) === count) listsFullyLocked.add(kind);
  }

  return { byStatement, listsFullyLocked };
}

/**
 * The list editor's guard: which locked statements the submitted list drops.
 *
 * THE function to understand in this file, because of what it defends against.
 * The narrative and the assumptions are edited as whole lists of text boxes,
 * and `reconcileStatements` matches what comes back to what exists BY TEXT. So
 * a person rewording a locked line does not produce an update — it produces a
 * delete of the locked row and a create of a new one, and the lock cascades
 * away with it. Nothing would refuse; the lock would simply cease to exist.
 *
 * So a locked statement's text must come back verbatim, and this returns the
 * ones that did not: reworded, or deleted outright. Both are the same refusal,
 * which is correct — a lock says this sentence is settled.
 *
 * Whitespace is trimmed before comparing, because the editor trims before
 * saving and a trailing space is not an edit anybody meant to make.
 */
export async function lockedStatementTextsMissing(
  db: PrismaClient,
  args: { estimateId: string; kind: StatementKind; texts: readonly string[] },
): Promise<Array<{ statementId: string; text: string; lockedById: string }>> {
  const { estimateId, kind, texts } = args;

  const locked = await db.statementLock.findMany({
    where: { estimateId, statement: { kind } },
    select: { statementId: true, lockedById: true, statement: { select: { text: true } } },
  });
  if (locked.length === 0) return [];

  // A multiset, not a set: two statements can carry identical text — two
  // specialists collating the same assumption — and if both are locked, the
  // submitted list has to still contain it twice.
  const remaining = new Map<string, number>();
  for (const t of texts) {
    const text = t.trim();
    if (text.length === 0) continue;
    remaining.set(text, (remaining.get(text) ?? 0) + 1);
  }

  const missing: Array<{ statementId: string; text: string; lockedById: string }> = [];
  for (const lock of locked) {
    const text = lock.statement.text;
    const left = remaining.get(text) ?? 0;
    if (left > 0) remaining.set(text, left - 1);
    else missing.push({ statementId: lock.statementId, text, lockedById: lock.lockedById });
  }
  return missing;
}
