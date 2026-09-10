import { NextResponse } from 'next/server';
import { Prisma, prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import type { ProposalDTO, ReconciliationDTO } from '@/app/estimates/[id]/reconcile-dto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type PayloadRow = { role: string; title: string; baseHours: number; taxedHours: number };

/**
 * The newest reconciliation on this estimate, for the review to poll. AEH-236.
 *
 * Its own route rather than a field on `/status`, because a pass has a status of
 * its own: an estimate can legitimately have never run AND be reconciling, and
 * borrowing `runStatus` would make those two indistinguishable.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const rec = await prisma.estimateReconciliation.findFirst({
    where: { estimateId: id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      stage: true,
      pct: true,
      error: true,
      prompt: true,
      posture: true,
      reasoning: true,
      triageReasoning: true,
      triagedCardIds: true,
      createdAt: true,
      appliedAt: true,
      proposals: {
        orderBy: { title: 'asc' },
        select: {
          id: true,
          menuItemId: true,
          kind: true,
          title: true,
          rationale: true,
          supersedesMenuItemIds: true,
          hoursBefore: true,
          hoursAfter: true,
          decision: true,
          // `payload` is deliberately named here. It is the one column on this
          // model that can be large, and a default select would drag every
          // proposal's rows across on every poll.
          payload: true,
        },
      },
    },
  });
  if (!rec) return NextResponse.json({ reconciliation: null });

  const proposals: ProposalDTO[] = rec.proposals.map((p) => ({
    id: p.id,
    menuItemId: p.menuItemId,
    kind: p.kind,
    title: p.title,
    rationale: p.rationale,
    supersedes: p.supersedesMenuItemIds,
    delta: (p.hoursAfter ?? 0) - (p.hoursBefore ?? 0),
    decision: p.decision,
    rows: ((p.payload as { rows?: PayloadRow[] } | null)?.rows ?? []).map((r) => ({
      role: r.role,
      title: r.title,
      baseHours: r.baseHours,
      taxedHours: r.taxedHours,
    })),
  }));

  // Asked as a COUNT rather than by selecting the column. `requirements` holds
  // every requirement the Librarian found, which on a real brief is tens of
  // kilobytes, and this route is polled every two seconds — the same reason
  // `payload` above is named explicitly rather than left to a default select.
  // Only a failed pass can be resumed, so only a failed pass is asked.
  const briefAlreadyRead =
    rec.status === 'FAILED' &&
    (await prisma.estimateReconciliation.count({
      where: { id: rec.id, requirements: { not: Prisma.DbNull } },
    })) > 0;

  const dto: ReconciliationDTO = {
    id: rec.id,
    status: rec.status,
    stage: rec.stage,
    pct: rec.pct,
    error: rec.error,
    prompt: rec.prompt,
    posture: rec.posture,
    reasoning: rec.reasoning,
    triageReasoning: rec.triageReasoning,
    triagedCount: rec.triagedCardIds.length,
    briefAlreadyRead,
    proposals,
    createdAt: rec.createdAt.toISOString(),
    appliedAt: rec.appliedAt?.toISOString() ?? null,
  };
  return NextResponse.json({ reconciliation: dto });
}
