import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { requireUser } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { JumpLink } from './JumpLink';

/**
 * Risks the Detective raised that nobody costed.
 *
 * A section of the document, beside Narrative and Assumptions — not a card in
 * the rail. Those three are the same thing in three voices: the crew's readings
 * of the brief. The narrative says what the work is, the assumptions say what is
 * being taken for granted, and this says what could be wrong with both.
 *
 * It earns the width. A finding carries a citation into the source material and
 * three decisions — cost it, say it is already covered, or dismiss it with a
 * written reason — and that reason is a free-text field somebody has to compose
 * a sentence in. Against a 280px rail it was the narrowest column on the screen
 * holding the heaviest decision on it. AEH-377.
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
    <CollapsibleSection
      id="risk"
      className={`mt-3.5 scroll-mt-4 ${open.length > 0 ? 'border-bronze-line' : ''}`}
      storageKey={`est:${estimateId}:risk`}
      title="Flagged risk"
      meta={
        open.length > 0 ? (
          <span className="rounded-full border border-bronze-line bg-bronze-tint px-2.5 py-0.5 text-[11px] font-semibold text-bronze-ink">
            <span className="num">{open.length}</span> need{open.length === 1 ? 's' : ''} a decision
          </span>
        ) : (
          <span className="text-ink-4">
            <span className="num">{settled.length}</span> resolved
          </span>
        )
      }
      data-testid="hidden-work-panel"
    >
      {open.length === 0 ? (
        <p className="text-[12.5px] text-ink-3">
          <span className="num">{settled.length}</span> resolved. Nothing outstanding.
        </p>
      ) : (
        <p className="max-w-[78ch] text-[12.5px] leading-relaxed text-ink-3">
          Implied by the source material and deliberately not costed. The estimator council would
          not price these without a name it recognised, so each one needs a person.
        </p>
      )}

      <ul className="mt-3 flex flex-col gap-4">
        {open.map((f) => (
          <li key={f.id} className="border-t border-line-soft pt-3.5 first:border-t-0 first:pt-0">
            <div className="num text-[11px] font-bold tracking-[0.07em] text-bronze-ink uppercase">
              {f.riskFlag}
            </div>
            <p className="mt-1 max-w-[82ch] text-[13px] leading-relaxed text-ink-2">{f.claim}</p>
            {/* Where the claim came from, and a way back to it. The section has
                to be opened as well as scrolled to — a deep link that lands on a
                collapsed block shows the reader nothing, which is the bug
                AEH-259 fixed for the Oracle's own quote jumps. */}
            <p className="mt-1 max-w-[82ch] text-[11.5px] leading-relaxed text-ink-4">
              {f.citation}{' '}
              <JumpLink to="sow" className="whitespace-nowrap text-green hover:underline">
                Statement of work &#8599;
              </JumpLink>
            </p>

            {!isFinalised && (
              // One row on a wide screen, wrapping to two when it has to. The
              // dismissal reason keeps a real measure either way: it is a
              // sentence somebody has to compose, and it used to be typed into
              // a box narrower than the words going in it.
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
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
                  <Button type="submit" size="sm" variant="outline" data-testid={`covered-${f.id}`}>
                    Already covered
                  </Button>
                </form>
                <form action={dismiss} className="flex min-w-[280px] flex-1 gap-2">
                  <input type="hidden" name="findingId" value={f.id} />
                  <input type="hidden" name="estimateId" value={estimateId} />
                  <Input
                    name="reason"
                    required
                    placeholder="Not costing it because…"
                    className="h-8 px-2.5 text-[12.5px]"
                    aria-label={`Reason for dismissing ${f.riskFlag}`}
                  />
                  <Button type="submit" size="sm" variant="quiet" data-testid={`dismiss-${f.id}`}>
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

      {/* Folded away rather than listed. A decision somebody already took is
          record, not work, and it should not compete with the ones still open —
          but "why did nobody cost this" is exactly the question asked three
          weeks later, so it stays one click away rather than disappearing. */}
      {settled.some((f) => f.outcome === 'DISMISSED') && (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11.5px] text-ink-3 hover:text-green">
            <span className="group-open:hidden">Show what was dismissed, and why</span>
            <span className="hidden group-open:inline">Hide the dismissed</span>
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {settled
              .filter((f) => f.outcome === 'DISMISSED')
              .map((f) => (
                <li key={f.id} className="max-w-[82ch] text-[11.5px] leading-relaxed text-ink-3">
                  <span className="num text-ink-4">{f.riskFlag}</span> — {f.dismissReason}
                  {(nameOf(f.dismissedById) || f.dismissedAt) && (
                    <span className="text-ink-4">
                      {' · '}
                      {nameOf(f.dismissedById)}
                      {nameOf(f.dismissedById) && f.dismissedAt ? ' · ' : ''}
                      {f.dismissedAt ? f.dismissedAt.toISOString().slice(0, 10) : ''}
                    </span>
                  )}
                </li>
              ))}
          </ul>
        </details>
      )}
    </CollapsibleSection>
  );
}
