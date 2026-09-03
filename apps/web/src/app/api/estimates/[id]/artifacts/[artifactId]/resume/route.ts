import { NextResponse } from 'next/server';

import { prisma } from '@repo/db';

import { auth } from '@/lib/auth';
import { inngest, EVENT_ARTIFACT } from '@/lib/inngest';

export const runtime = 'nodejs';

/**
 * Pick a failed generation up where it stopped. AEH-239.
 *
 * The whole point of writing sections to their own rows as they land is that a
 * failure part-way keeps them — but until this existed there was no way to use
 * that. Pressing Generate again creates a NEW artifact with a new id, so the
 * sections already written belong to the old row and every one is paid for
 * again. That made the checkpointing invisible exactly when it mattered.
 *
 * Resuming re-fires the same event against the SAME artifact id. `runArtifact`
 * then reuses the stored outline rather than re-planning — critical, since a
 * fresh plan would rename the sections and orphan the finished ones — and skips
 * any section that already has a row.
 *
 * Only a FAILED artifact can be resumed. A RUNNING one is already being worked
 * on and a second event would have two functions writing the same rows; a DONE
 * one has nothing to resume, and re-running it is a fresh generation.
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
  if (!artifact || artifact.estimateId !== estimateId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (artifact.status !== 'FAILED') {
    return NextResponse.json(
      { error: `Only a failed document can be resumed — this one is ${artifact.status}.` },
      { status: 409 },
    );
  }

  // Flipped back to RUNNING before the event goes out, so the page shows
  // progress on the very next poll rather than sitting on "failed" until the
  // first step reports.
  await prisma.estimateArtifact.update({
    where: { id: artifactId },
    data: { status: 'RUNNING', stage: 'Queued', error: null, finishedAt: null },
  });

  await inngest.send({ name: EVENT_ARTIFACT, data: { artifactId } });

  return NextResponse.json({ artifactId, resumed: true });
}
