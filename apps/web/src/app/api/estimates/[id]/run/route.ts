import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import { createModelProvider } from '@repo/providers';
import { runEstimate } from '@repo/agents';
import { auth } from '@/lib/auth';

// The run makes several sequential LLM calls — needs the Node runtime, never
// cached, and (in `next dev` / a long-lived Node server) the detached promise
// below keeps executing after we return 202.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Kick off an estimate run in the background and return immediately. Progress is
 * written to the Estimate row (runStatus/runStage/runPct) so the client can poll
 * GET /status and survive a page reload. Guards against a double-run.
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

  // Mark RUNNING up front so a reload (or a second click) sees it immediately.
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

  // Fire-and-forget: do NOT await. The promise outlives the request in a
  // long-lived Node process (dev + `next start`). A queue would be needed for a
  // serverless/multi-instance deploy.
  void executeRun(id);

  return NextResponse.json({ status: 'RUNNING' }, { status: 202 });
}

async function executeRun(id: string): Promise<void> {
  try {
    await runEstimate(id, {
      db: prisma,
      modelProvider: createModelProvider(),
      onProgress: async ({ stage, pct }) => {
        await prisma.estimate.update({ where: { id }, data: { runStage: stage, runPct: pct } });
      },
    });
    await prisma.estimate.update({
      where: { id },
      data: { runStatus: 'DONE', runStage: 'Done', runPct: 100, runFinishedAt: new Date() },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.estimate.update({
      where: { id },
      data: {
        runStatus: 'FAILED',
        runStage: 'Failed',
        runError: msg.slice(0, 500),
        runFinishedAt: new Date(),
      },
    });
  }
}
