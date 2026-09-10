/**
 * Keeping the carried marks honest. AEH-236.
 *
 * A forked row arrives marked `carriedIntact`, meaning it still says exactly
 * what it said on the parent. The margin rule draws a solid line for that and a
 * dashed one once it has moved — and the difference is load-bearing, because on
 * an estimate whose parent has been quoted to a client, "was in that price and
 * has since changed" is the single most useful thing the ledger can tell you.
 *
 * Which makes a MISSED write path worse than no mark at all: a row that quietly
 * changed while still drawing a solid rule is the ledger lying about the one
 * thing it was added to say. So the clearing lives here, in one function, and
 * every write path calls it rather than each remembering its own
 * `carriedIntact: false`. `carriage.test.ts` walks the paths and asserts it.
 *
 * `carriedFromId` is never cleared by any of this. Where a row CAME FROM is a
 * fact about the past and stays true however much the row changes; only the
 * claim that it still matches is revocable.
 */
import type { Prisma, PrismaClient } from './generated/client/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Mark rows, and the cards holding them, as no longer matching the parent.
 *
 * Cards are marked as well as rows — never instead of them — because row
 * identity does not survive a re-price. `applyRegionReplace` deletes the pinned
 * rows and creates fresh ones, so a card whose rows were all replaced has no
 * carried row left to consult; without the card-level mark it would read as
 * brand-new work rather than as amended work that came from somewhere.
 *
 * Pass `cardIds` directly for the writes that change a card's CONTENTS without
 * changing any surviving row: adding a line, deleting one, moving one between
 * cards. The card no longer matches even though every remaining row still does.
 */
export async function markAmended(
  db: Db,
  target: { lineItemIds?: string[]; cardIds?: string[] },
): Promise<void> {
  const lineItemIds = target.lineItemIds?.filter(Boolean) ?? [];
  const explicitCards = target.cardIds?.filter(Boolean) ?? [];
  if (lineItemIds.length === 0 && explicitCards.length === 0) return;

  const cardIds = new Set(explicitCards);

  if (lineItemIds.length > 0) {
    // Read the owning cards BEFORE the rows are touched. On the delete paths
    // this is the last moment the link exists at all.
    const owners = await db.roleLineItem.findMany({
      where: { id: { in: lineItemIds } },
      select: { menuItemId: true },
    });
    for (const o of owners) cardIds.add(o.menuItemId);

    await db.roleLineItem.updateMany({
      // `carriedIntact: true` in the filter is not an optimisation. Without it
      // this rewrites every row in the envelope on every edit, and each write
      // bumps `updatedAt` — which is half the region fingerprint the steered
      // edit engine compares to detect a concurrent change. Clearing a flag
      // that is already clear would report the ledger as having moved
      // underneath a job that was only ever looking at itself.
      where: { id: { in: lineItemIds }, carriedIntact: true },
      data: { carriedIntact: false },
    });
  }

  if (cardIds.size > 0) {
    await db.menuItem.updateMany({
      where: { id: { in: [...cardIds] }, carriedIntact: true },
      data: { carriedIntact: false },
    });
  }
}

/**
 * The same, for prose.
 *
 * Statements have no card to fall back on, so unlike the ledger there is no
 * durable layer beneath this one — and that is the honest shape for prose. A
 * reworded assumption IS new text, not an amended version of old text.
 */
export async function markStatementsAmended(db: Db, statementIds: string[]): Promise<void> {
  const ids = statementIds.filter(Boolean);
  if (ids.length === 0) return;
  await db.estimateStatement.updateMany({
    where: { id: { in: ids }, carriedIntact: true },
    data: { carriedIntact: false },
  });
}
