import { NextResponse } from 'next/server';
import { prisma, rerunBlock, rerunBlockMessage } from '@repo/db';
import { auth } from '@/lib/auth';
import { inngest } from '@/lib/inngest';
import { assertEstimateUnlockedForRerun } from '@/lib/lock-guards';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kick off an estimate run. Marks the estimate RUNNING (so a reload/second click
 * sees it immediately and is guarded), then emits an Inngest event — the durable
 * `estimate-run` function executes the pipeline and writes progress back to the
 * Estimate row, which GET /status polls. Returns immediately.
 *
 * Refuses while anything on the estimate is locked. The pipeline's persist step
 * deletes every scope scenario, line item and menu item before writing the new
 * set, so the first re-run after somebody froze their work would discard it.
 *
 * The check belongs HERE rather than in the persist step, and the ordering
 * matters: by the time that transaction runs, several minutes of model calls
 * have been paid for and the estimate has been sitting in RUNNING. Refusing at
 * dispatch costs nothing and is the only point at which the answer is still
 * useful. AEH-238.
 *
 * Refuses for lineage on the same reasoning. That same destructive persist is
 * what makes a re-run unsafe on an estimate other estimates depend on — see
 * `rerunBlock`. AEH-236.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const est = await prisma.estimate.findUnique({ where: { id }, select: { id: true, runStatus: true } });
  if (!est) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // `code`, not just a message. Both this and the refusals below are 409, and
   // the client has to tell them apart: "somebody else already started it" is
   // fine and the poller takes over, while a refusal must stop the optimistic
   // RUNNING state and say why. Matching on the message string would work until
   // somebody rewords it. AEH-236.
  if (est.runStatus === 'RUNNING') {
    return NextResponse.json({ code: 'ALREADY_RUNNING', error: 'already running' }, { status: 409 });
  }

  // Lineage, before the lock check only because it is one query and needs no
  // try/catch. AEH-236.
  const family = await prisma.estimate.findMany({ select: { id: true, parentId: true } });
  const blocked = rerunBlock(family, id);
  if (blocked) {
    return NextResponse.json(
      { code: 'REFUSED', error: rerunBlockMessage(blocked) },
      { status: 409 },
    );
  }

  try {
    await assertEstimateUnlockedForRerun(id);
  } catch (err) {
    // 409 rather than 403: nothing is wrong with the caller's permissions, the
    // estimate is in a state that forbids this. The message names the locks and
    // who holds them, so it is passed through verbatim for the client to show.
    return NextResponse.json(
      {
        code: 'REFUSED',
        error: err instanceof Error ? err.message : 'This estimate has locked lines',
      },
      { status: 409 },
    );
  }

  await prisma.estimate.update({
    where: { id },
    data: {
      runStatus: 'RUNNING',
      runStage: 'Queued',
      runPct: 0,
      runError: null,
      runStartedAt: new Date(),
      runFinishedAt: null,
    },
  });

  // A fresh id per run so ModelUsage rows can answer "what did THIS run cost"
  // even across re-runs of the same estimate.
  const runId = crypto.randomUUID();
  await inngest.send({ name: 'estimate/run.requested', data: { estimateId: id, runId } });

  return NextResponse.json({ status: 'RUNNING' }, { status: 202 });
}
