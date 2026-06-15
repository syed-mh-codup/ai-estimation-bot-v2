import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kick off an estimate run. Marks the estimate RUNNING (so a reload/second click
 * sees it immediately and is guarded), then emits an Inngest event — the durable
 * `estimate-run` function executes the pipeline and writes progress back to the
 * Estimate row, which GET /status polls. Returns immediately.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const est = await prisma.estimate.findUnique({ where: { id }, select: { id: true, runStatus: true } });
  if (!est) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (est.runStatus === 'RUNNING') {
    return NextResponse.json({ error: 'already running' }, { status: 409 });
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

  await inngest.send({ name: 'estimate/run.requested', data: { estimateId: id } });

  return NextResponse.json({ status: 'RUNNING' }, { status: 202 });
}
