import {
  lockedStatementTextsMissing,
  lockedWithin,
  locksOn,
  prisma,
  resolveTarget,
  type RoleKind,
  type StatementKind,
} from '@repo/db';

/**
 * The refusal half of ledger locks — AEH-238.
 *
 * `packages/db/src/ledger-locks.ts` answers what is frozen; this decides what
 * that forbids and says so in words a reviewer can act on. Every refusal here
 * names the rows and who holds them, deliberately: a lock error that only says
 * no sends somebody hunting through seventy-seven rows for the one that stopped
 * them.
 *
 * KNOWN GAP, and read this before writing another one. A guard that THROWS from
 * inside a `'use server'` action does not deliver any of that wording in a
 * production build — React's Flight client keeps only a digest and hands the
 * browser "An error occurred in the Server Components render…". So these
 * sentences are legible in `next dev` and in the server log, and nowhere a
 * deployed reviewer can see them. The shape that fixes it is to return the
 * reason rather than throw it, with the action returning a `MutationOutcome` —
 * see `setItemEnabled`, which is where it was reported. Every guard in this
 * file still throws: their refusals are reachable, and when one is reported it
 * wants that same treatment, not a reworded message.
 *
 * Note that the e2e suite cannot catch this class of bug — it runs `pnpm dev`,
 * where the real message comes through. Verifying a refusal's WORDING needs
 * `next build && next start`.
 *
 * These live outside `actions.ts` because that module is `'use server'`, where
 * every export must be an async function — a synchronous helper added there
 * breaks the build of every route importing anything from the file, which is
 * the AEH-253 regression. They are async anyway, but the boundary is worth
 * keeping: guards are policy, actions are the surface.
 *
 * What a lock freezes, and what it deliberately does not:
 *
 *   frozen   a row's hours, its description, its existence; a card's existence
 *            (deletion, merging); a card's title once every row on it is frozen
 *   free     placement — `sectionId` and `order` are presentational, and a
 *            reviewer tidying the board is not editing anybody's numbers
 *   free     a card's ENABLEMENT — switching it in or out of the estimate
 *
 * That last line was the other way round until it was challenged, and the
 * argument is worth keeping: a lock is a statement about a line, that its hours
 * and its description are settled. Disabling a card leaves both exactly as they
 * were; what it edits is the estimate's composition. Reading a lock as "these
 * hours must keep counting toward the total" imports a claim about the estimate
 * that nobody makes by locking a row — and it made the single most casual
 * action in the editor refuse on nearly every card of a well-locked estimate.
 */

/**
 * Renders "Alice" / "you" for a message, resolving names by id.
 *
 * Takes the one field it needs rather than a `LockInfo`, because it now serves
 * statement locks too and those are a different row type. Its callers still
 * hold the full lock, which is where the audit sees the rest of it read.
 */
async function describeHolders(
  locks: Array<{ lockedById: string }>,
  actorId?: string,
): Promise<string> {
  const ids = [...new Set(locks.map((l) => l.lockedById))];
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, email: true },
  });
  const label = (id: string): string => {
    if (id === actorId) return 'you';
    const u = users.find((x) => x.id === id);
    return u ? (u.name ?? u.email) : 'a former colleague';
  };
  // Counted per holder, because "3 locked by Alice" is the actionable form when
  // a whole card slice is frozen by one person.
  const counts = new Map<string, number>();
  for (const l of locks) counts.set(l.lockedById, (counts.get(l.lockedById) ?? 0) + 1);
  return [...counts.entries()].map(([id, n]) => `${n} by ${label(id)}`).join(', ');
}

/** Throws when this row is frozen. Guards hours, description and deletion. */
export async function assertLineItemUnlocked(lineItemId: string, actorId?: string): Promise<void> {
  const locks = await locksOn(prisma, [lineItemId]);
  const lock = locks.get(lineItemId);
  if (!lock) return;
  const who = await describeHolders([lock], actorId);
  throw new Error(`This line is locked (${who}) and cannot be changed. Unlock it first.`);
}

/**
 * Throws when a card's role slice is frozen and somebody tries to add to it.
 *
 * A new row is not a change to a locked row, so this needs saying: what a lock
 * asserts is that a slice of work is settled, and appending an hour to a frozen
 * DEV slice moves the card's DEV total just as surely as editing one of its
 * rows would. Refusing is the reading that makes the lock mean what a person
 * thought it meant when they set it.
 */
export async function assertCardRoleAcceptsNewLine(
  menuItemId: string,
  role: RoleKind,
  actorId?: string,
): Promise<void> {
  const item = await prisma.menuItem.findUnique({
    where: { id: menuItemId },
    select: { estimateId: true },
  });
  if (!item) throw new Error('Menu item not found');
  const ids = await resolveTarget(prisma, item.estimateId, {
    target: { scope: 'CARD', id: menuItemId },
    roles: [role],
  });
  const locks = await locksOn(prisma, ids);
  if (locks.size === 0) return;
  const who = await describeHolders([...locks.values()], actorId);
  throw new Error(
    `${role} on this card is locked (${who}), so a new ${role} line cannot be added to it. Unlock it first.`,
  );
}

/**
 * Throws when a card carries any locked row. Guards deletion and merging, which
 * would destroy locked rows through the back door.
 *
 * Switching the card off is NOT guarded here, and that exclusion is the point.
 * It once was, on the reasoning that removing the card removes those hours from
 * the estimate's totals — but a lock is a statement about a LINE: its hours and
 * its description are settled. Enabling or disabling a card edits neither. It
 * changes what the estimate is made of, which is not a claim anybody made by
 * locking a row. Deletion is different in kind: the row itself stops existing.
 */
export async function assertCardStructureUnlocked(menuItemId: string, actorId?: string): Promise<void> {
  const locks = await prisma.ledgerLock.findMany({
    where: { lineItem: { menuItemId } },
    select: {
      lineItemId: true,
      lockedById: true,
      lockedAt: true,
      declaredScope: true,
      declaredTargetId: true,
    },
  });
  if (locks.length === 0) return;
  const who = await describeHolders(locks, actorId);
  throw new Error(
    `This card holds ${locks.length} locked line${locks.length === 1 ? '' : 's'} (${who}), so it cannot be deleted or merged. Unlock them first.`,
  );
}

/**
 * Throws only when EVERY row on the card is frozen.
 *
 * Narrower than the structural guard, and the asymmetry is the point. A title
 * describes the whole card, so locking one role's slice says nothing about it —
 * but a card whose every row is settled is settled, name included.
 *
 * Derived rather than stored, so locking a card once and ticking its four roles
 * over four separate afternoons reach the same state, which they should.
 */
export async function assertCardTitleUnlocked(menuItemId: string, actorId?: string): Promise<void> {
  const rows = await prisma.roleLineItem.findMany({
    where: { menuItemId },
    select: { id: true },
  });
  // Vacuously true of nothing: an empty card is not a locked card.
  if (rows.length === 0) return;
  const locks = await locksOn(
    prisma,
    rows.map((r) => r.id),
  );
  if (locks.size !== rows.length) return;
  const who = await describeHolders([...locks.values()], actorId);
  throw new Error(`Every line on this card is locked (${who}), so its title cannot be changed.`);
}

/**
 * Throws when a role's buffer is about to move while rows of that role are
 * frozen.
 *
 * `setEstimateTaxPct` is a bulk hour change wearing different clothes: it
 * recomputes `taxedHours` for every row of the role. Letting it through would
 * rewrite frozen hours without ever touching a guarded action, which is the
 * quietest way this whole mechanism could have failed.
 */
export async function assertRoleUnlockedForBuffer(
  estimateId: string,
  role: RoleKind,
  actorId?: string,
): Promise<void> {
  // The enforcement rule stated directly: does this declaration intersect a
  // lock. A buffer move's declaration is the whole estimate narrowed to one
  // role, which is exactly an envelope.
  const locks = await lockedWithin(prisma, estimateId, {
    target: { scope: 'ESTIMATE' },
    roles: [role],
  });
  if (locks.length === 0) return;
  const who = await describeHolders(locks, actorId);
  throw new Error(
    `${locks.length} ${role} line${locks.length === 1 ? ' is' : 's are'} locked (${who}). Changing the ${role} buffer would re-tax them, so it is refused until they are unlocked.`,
  );
}

/**
 * Throws when a list save would drop or reword a locked statement. AEH-238.
 *
 * THE guard on the statement axis, and the reason it looks nothing like the
 * others. `reconcileStatements` matches the submitted list to existing rows BY
 * TEXT, so rewording a locked line is a delete plus a create — and the lock's
 * foreign key cascades. Without this, a person could rewrite a frozen assumption
 * and the lock would vanish along with the row it was protecting: no error, no
 * event, and a lock nobody removed.
 *
 * So it runs BEFORE the reconcile, and it asks the only question that catches
 * both cases: does every locked line's text still come back. Reworded and
 * deleted are the same refusal, which is right — a lock says this sentence is
 * settled.
 */
export async function assertStatementListEditable(
  estimateId: string,
  kind: StatementKind,
  texts: readonly string[],
  actorId?: string,
): Promise<void> {
  const missing = await lockedStatementTextsMissing(prisma, { estimateId, kind, texts });
  if (missing.length === 0) return;
  const who = await describeHolders(missing, actorId);
  const label = kind === 'NARRATIVE' ? 'narrative line' : 'assumption';
  throw new Error(
    `${missing.length} locked ${label}${
      missing.length === 1 ? '' : 's'
    } (${who}) would be reworded or removed by this save, so it was refused. Unlock ${
      missing.length === 1 ? 'it' : 'them'
    } first.`,
  );
}

/**
 * Throws when a full re-run is asked for while anything on the estimate is
 * frozen.
 *
 * A run deletes every scope scenario, every line item and every menu item
 * before writing the new set, so the first re-run after somebody locks their
 * work would destroy it. Refusing is the same rule the engine follows — a
 * declaration that intersects a lock is refused rather than partially applied —
 * applied to the widest declaration there is.
 *
 * This is checked where the run is DISPATCHED, not inside the persist step. By
 * the time the transaction runs, several minutes of model calls have been paid
 * for and the estimate has been sitting in RUNNING; refusing there would be
 * both expensive and confusing.
 */
export async function assertEstimateUnlockedForRerun(estimateId: string): Promise<void> {
  // Statements as well as rows, and that is not symmetry for its own sake: a
  // run calls `replaceStatements`, which deletes both lists wholesale before
  // writing the new ones. A locked assumption would be destroyed by a re-run
  // exactly as surely as a locked line item.
  const [locks, statementLocks] = await Promise.all([
    prisma.ledgerLock.findMany({
      where: { estimateId },
      select: {
        lineItemId: true,
        lockedById: true,
        lockedAt: true,
        declaredScope: true,
        declaredTargetId: true,
      },
    }),
    prisma.statementLock.findMany({ where: { estimateId }, select: { lockedById: true } }),
  ]);
  if (locks.length === 0 && statementLocks.length === 0) return;

  const who = await describeHolders([...locks, ...statementLocks]);
  const parts = [
    locks.length > 0 ? `${locks.length} line${locks.length === 1 ? '' : 's'}` : null,
    statementLocks.length > 0
      ? `${statementLocks.length} statement${statementLocks.length === 1 ? '' : 's'}`
      : null,
  ].filter((p): p is string => p !== null);

  throw new Error(
    `${parts.join(' and ')} on this estimate ${
      locks.length + statementLocks.length === 1 ? 'is' : 'are'
    } locked (${who}). A re-run rebuilds every card and both statement lists from scratch and would discard them, so it is refused. Unlock them, or re-run a copy.`,
  );
}
