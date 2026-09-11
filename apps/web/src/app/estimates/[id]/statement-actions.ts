'use server';

import { appendStatement, prisma } from '@repo/db';
import { requireUser } from '@/lib/rbac';

/**
 * Recording one assumption — the single write Oracle may reach. AEH-238.
 *
 * This module exists because of a boundary it deliberately narrows, and that is
 * worth reading before adding anything to it.
 *
 * AEH-259 built Oracle as a comprehension aid that changes nothing, and
 * asserted it with a test rather than trusting review: "the moment one write
 * path exists, that guarantee is gone and no amount of prompt wording restores
 * it." `Oracle.tsx` said the same in prose — Oracle may recommend an
 * assumption, it may not write one — and the affordance was a copy button.
 *
 * AEH-238 changes that, on purpose and with the reporter's agreement. What
 * survives is the part of the guarantee that was actually protecting anybody:
 * NO NUMBER A CLIENT SEES CAN MOVE BECAUSE OF ORACLE. Appending an assumption
 * changes no hours, no cards and no totals; it adds a sentence to a list, and
 * only when a person clicks the button. The estimator is the one writing — they
 * are just no longer retyping what is already on their screen.
 *
 * So this module is deliberately one function wide, and the no-write guard now
 * asserts that precisely rather than absolutely: Oracle may reach this and
 * nothing else. Do not add a second export here. If Oracle needs to change a
 * number, that is a different ticket and a different conversation.
 */

/**
 * Append an assumption Oracle proposed and a person accepted.
 *
 * `STEERED`, not `HUMAN`, and the distinction is the same one the line items
 * make: a person decided, a model wrote the words. Stamping it `HUMAN` would
 * claim the estimator phrased it; stamping it `CREW` would claim the estimating
 * council produced it. Neither is true.
 */
export async function recordSuggestedAssumption(
  estimateId: string,
  text: string,
): Promise<{ ok: boolean; reason?: string }> {
  await requireUser();

  // Deleted counts as missing. AEH-375.
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId, deletedAt: null },
    select: { status: true },
  });
  if (!est) return { ok: false, reason: 'Estimate not found' };
  if (est.status === 'FINALISED') {
    return { ok: false, reason: 'This estimate is finalised and cannot be edited' };
  }

  const wording = text.trim();
  if (wording.length === 0) return { ok: false, reason: 'There is nothing to record' };

  await appendStatement(prisma, {
    estimateId,
    kind: 'ASSUMPTION',
    text: wording,
    provenance: 'STEERED',
  });
  return { ok: true };
}
