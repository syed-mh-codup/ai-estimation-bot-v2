import { NextResponse } from 'next/server';

import { prisma } from '@repo/db';

import { auth } from '@/lib/auth';
import { inngest, EVENT_ARTIFACT_CANCEL } from '@/lib/inngest';

export const runtime = 'nodejs';

/**
 * Stop a generation that is running. AEH-321.
 *
 * ## Why this needed to exist
 *
 * A generation is minutes of sequential paid model calls, and until now the
 * only way to end a bad one was to watch it spend. That is worst exactly when
 * you most want out: you can see from the first section that the plan is wrong,
 * and there are nine more coming.
 *
 * ## Cancelled is FAILED, deliberately
 *
 * `RunStatus` has no CANCELLED member and this does not add one. Not to avoid
 * the migration, but because FAILED already means precisely what is wanted
 * here: work stopped part-way, sections written so far are kept, and the row is
 * resumable and deletable. A CANCELLED status would have to re-earn all three,
 * and every `switch` on status would grow a branch that behaved identically to
 * the one next to it. The distinction that actually matters to a person is
 * carried where they will read it — `stage` and `error`.
 *
 * ## The row is settled here, not by the function
 *
 * Two reasons. The page polls every two seconds and must not sit on "writing
 * sections" after you have pressed Stop. And Inngest does not promise to run
 * `onFailure` for a cancellation, so relying on it would risk a row stuck on
 * RUNNING forever with nothing coming to move it. `onFailure` is guarded to
 * only touch rows still marked RUNNING, so it cannot overwrite this.
 *
 * ## Stopping is not instant
 *
 * Inngest cancels BETWEEN steps: a section already talking to the model runs to
 * completion first. So a click lands within about one section. Nothing is lost
 * when it does — that section is written like any other and the row can be
 * resumed from it.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; artifactId: string }> },
) {
  const { id: estimateId, artifactId } = await params;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const artifact = await prisma.estimateArtifact.findUnique({
    where: { id: artifactId },
    select: { id: true, estimateId: true, status: true },
  });
  // Checked rather than assumed, same as the status route: an artifact id
  // belonging to another estimate must not be stoppable through this URL.
  if (!artifact || artifact.estimateId !== estimateId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (artifact.status !== 'RUNNING' && artifact.status !== 'IDLE') {
    return NextResponse.json(
      { error: `Only a generating document can be stopped — this one is ${artifact.status}.` },
      { status: 409 },
    );
  }

  const who = session.user.email ?? session.user.name ?? 'someone';

  // Guarded on status so two people pressing Stop at once produce one result,
  // and so a generation that finished in the gap between the read above and
  // this write is not retroactively marked stopped.
  const settled = await prisma.estimateArtifact.updateMany({
    where: { id: artifactId, status: { in: ['RUNNING', 'IDLE'] } },
    data: {
      status: 'FAILED',
      stage: 'Stopped',
      error: `Stopped from the app by ${who}. The sections written before it stopped are kept — resume to carry on from there.`,
      finishedAt: new Date(),
    },
  });
  if (settled.count === 0) {
    return NextResponse.json(
      { error: 'That document finished before it could be stopped.' },
      { status: 409 },
    );
  }

  await inngest.send({ name: EVENT_ARTIFACT_CANCEL, data: { artifactId } });

  return NextResponse.json({ artifactId, stopped: true });
}
