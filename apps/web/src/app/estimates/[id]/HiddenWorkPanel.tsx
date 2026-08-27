import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { requireUser } from '@/lib/rbac';
import { Eyebrow } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * Risks the Detective raised that nobody costed.
 *
 * Lives in the sticky rail rather than hanging off RunControls, which collapses
 * to a single quiet line the moment a menu card exists — that is, exactly when
 * the estimator is doing the reviewing. Sitting beside the Finalise button is
 * also the point: this is the list that button waits on.
 *
 * Known flags never appear here. Those were costed automatically and are already
 * cards in the ledger, marked Inferred. What is left is what the pipeline could
 * not price on its own and refused to guess at.
 */

/** Throws if the estimate is missing or finalised — edits are locked after that. */
async function assertOpen(estimateId: string): Promise<void> {
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { status: true },
  });
  if (!est) throw new Error('Estimate not found');
  if (est.status === 'FINALISED') throw new Error('This estimate is finalised and cannot be edited');
}

async function markCovered(formData: FormData) {
  'use server';
  await requireUser();
  const id = formData.get('findingId');
  const estimateId = formData.get('estimateId');
  if (typeof id !== 'string' || typeof estimateId !== 'string') return;
  await assertOpen(estimateId);

  await prisma.hiddenWorkFinding.updateMany({
    where: { id, estimateId, outcome: 'OPEN' },
    data: { outcome: 'COVERED' },
  });
  revalidatePath(`/estimates/${estimateId}`);
}

/**
 * Turn a raised risk into a card the estimator then costs by hand.
 *
 * The card is created empty rather than pre-filled. There is no honest number to
 * put in it — that is precisely why this finding reached a person instead of
 * being costed automatically — and inventing one is the habit this whole ticket
 * removed. It is marked `injected` because the work still is inferred: the
 * source material never asked for it, whoever ends up paying for it should be
 * able to see that, and the analysis depends on the distinction holding.
 */
async function costIt(formData: FormData) {
  'use server';
  await requireUser();
  const id = formData.get('findingId');
  const estimateId = formData.get('estimateId');
  if (typeof id !== 'string' || typeof estimateId !== 'string') return;
  await assertOpen(estimateId);

  const finding = await prisma.hiddenWorkFinding.findFirst({
    where: { id, estimateId, outcome: 'OPEN' },
    select: { riskFlag: true, taxonomyKey: true, claim: true },
  });
  if (!finding) return;

  const max = await prisma.menuItem.aggregate({
    where: { estimateId, sectionId: null },
    _max: { order: true },
  });

  const card = await prisma.menuItem.create({
    data: {
      estimateId,
      title: finding.claim.slice(0, 120),
      taxonomyKey: finding.taxonomyKey ?? 'custom',
      enabled: true,
      injected: true,
      order: (max._max.order ?? -1) + 1,
    },
    select: { id: true },
  });

  await prisma.hiddenWorkFinding.update({
    where: { id },
    data: { outcome: 'ACCEPTED', menuItemId: card.id },
  });
  revalidatePath(`/estimates/${estimateId}`);
}

/**
 * Walk away from a risk, on the record.
 *
 * The reason is required, and that is the whole design. An estimator under time
 * pressure will always be able to clear this list; what stops that being the
 * same as the risk never having been raised is that clearing it writes down who
 * decided and why. It is also the interesting half of the analysis — what a team
 * repeatedly declines to cost says more than what it accepts.
 */
async function dismiss(formData: FormData) {
  'use server';
  const user = await requireUser();
  const id = formData.get('findingId');
  const estimateId = formData.get('estimateId');
  const reason = (formData.get('reason') as string | null)?.trim();
  if (typeof id !== 'string' || typeof estimateId !== 'string' || !reason) return;
  await assertOpen(estimateId);

  await prisma.hiddenWorkFinding.updateMany({
    where: { id, estimateId, outcome: 'OPEN' },
    data: {
      outcome: 'DISMISSED',
      dismissReason: reason,
      dismissedById: user.id,
      dismissedAt: new Date(),
    },
  });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function HiddenWorkPanel({
  estimateId,
  isFinalised,
}: {
  estimateId: string;
  isFinalised: boolean;
}) {
  const findings = await prisma.hiddenWorkFinding.findMany({
    where: { estimateId },
    orderBy: [{ outcome: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      riskFlag: true,
      claim: true,
      citation: true,
      outcome: true,
      dismissReason: true,
      dismissedAt: true,
      dismissedById: true,
    },
  });
  if (findings.length === 0) return null;

  // Who walked away from a risk is half of the record. Resolved by id here
  // rather than stored as an email so a rename stays correct.
  const dismisserIds = [
    ...new Set(findings.map((f) => f.dismissedById).filter((v): v is string => v !== null)),
  ];
  const dismissers = dismisserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: dismisserIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const nameOf = (id: string | null): string | null => {
    if (!id) return null;
    const u = dismissers.find((d) => d.id === id);
    return u ? (u.name ?? u.email) : null;
  };

  const open = findings.filter((f) => f.outcome === 'OPEN');
  const settled = findings.filter((f) => f.outcome !== 'OPEN');

  return (
    <div
      className={`rounded-[10px] border bg-surface px-4 py-3.5 ${
        open.length > 0 ? 'border-bronze-line' : 'border-line'
      }`}
      data-testid="hidden-work-panel"
    >
      <Eyebrow>Flagged risk</Eyebrow>

      {open.length === 0 ? (
        <p className="mt-1.5 text-[12px] text-ink-3">
          <span className="num">{settled.length}</span> resolved. Nothing outstanding.
        </p>
      ) : (
        <p className="mt-1.5 text-[12px] text-ink-3">
          Implied by the source material and not costed. The estimator council would not price
          these without a name it recognised, so they need a decision.
        </p>
      )}

      <ul className="mt-2.5 flex flex-col gap-3">
        {open.map((f) => (
          <li key={f.id} className="border-t border-line-soft pt-2.5 first:border-t-0 first:pt-0">
            <div className="num text-[11px] font-bold tracking-[0.07em] text-bronze-ink uppercase">
              {f.riskFlag}
            </div>
            <p className="mt-0.5 text-[12.5px] leading-snug text-ink-2">{f.claim}</p>
            <p className="mt-0.5 text-[11.5px] text-ink-4">{f.citation}</p>

            {!isFinalised && (
              <div className="mt-1.5 flex flex-col gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  <form action={costIt}>
                    <input type="hidden" name="findingId" value={f.id} />
                    <input type="hidden" name="estimateId" value={estimateId} />
                    <Button type="submit" size="sm" data-testid={`cost-${f.id}`}>
                      Cost it
                    </Button>
                  </form>
                  <form action={markCovered}>
                    <input type="hidden" name="findingId" value={f.id} />
                    <input type="hidden" name="estimateId" value={estimateId} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="outline"
                      data-testid={`covered-${f.id}`}
                    >
                      Already covered
                    </Button>
                  </form>
                </div>
                <form action={dismiss} className="flex gap-1.5">
                  <input type="hidden" name="findingId" value={f.id} />
                  <input type="hidden" name="estimateId" value={estimateId} />
                  <Input
                    name="reason"
                    required
                    placeholder="Not costing it because…"
                    className="h-8 px-2 text-[12px]"
                    aria-label={`Reason for dismissing ${f.riskFlag}`}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="quiet"
                    data-testid={`dismiss-${f.id}`}
                  >
                    Dismiss
                  </Button>
                </form>
              </div>
            )}
          </li>
        ))}
      </ul>

      {settled.length > 0 && open.length > 0 && (
        <div className="mt-3 border-t border-dashed border-line pt-2.5 text-[11.5px] text-ink-3">
          <span className="num">{settled.length}</span> already resolved
        </div>
      )}

      {settled.some((f) => f.outcome === 'DISMISSED') && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {settled
            .filter((f) => f.outcome === 'DISMISSED')
            .map((f) => (
              <li key={f.id} className="text-[11.5px] leading-snug text-ink-3">
                <span className="num text-ink-4">{f.riskFlag}</span> — {f.dismissReason}
                {(nameOf(f.dismissedById) || f.dismissedAt) && (
                  <span className="block text-ink-4">
                    {nameOf(f.dismissedById)}
                    {nameOf(f.dismissedById) && f.dismissedAt ? ' · ' : ''}
                    {f.dismissedAt ? f.dismissedAt.toISOString().slice(0, 10) : ''}
                  </span>
                )}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
