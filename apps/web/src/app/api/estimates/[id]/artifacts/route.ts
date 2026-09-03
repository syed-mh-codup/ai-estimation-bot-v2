import { NextResponse } from 'next/server';

import { prisma } from '@repo/db';

import { auth } from '@/lib/auth';
import { inngest, EVENT_ARTIFACT } from '@/lib/inngest';

export const runtime = 'nodejs';

/**
 * Ask for a supporting document. AEH-239.
 *
 * Enqueue and return, unlike the Cartographer's route next door — and the
 * difference is the whole architecture. Deriving a graph is one model call a
 * user watches for under a minute, so it streams. A document is ~25k output
 * tokens, which cannot be produced inside one 300s invocation with Vercel Pro
 * ruled out, so it becomes N+2 durable Inngest steps and the client polls the
 * row, exactly as it does for a run.
 *
 * The row is created HERE, before the event fires, for two reasons that both
 * matter from the very first step: generation needs an id to attribute spend
 * to (one artifact is N+2 billed calls), and it needs somewhere to report
 * progress that the client can already be watching.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: estimateId } = await params;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    artifactTypeKey?: unknown;
    inputs?: unknown;
  };
  if (typeof body.artifactTypeKey !== 'string') {
    return NextResponse.json({ error: 'Which artifact type?' }, { status: 400 });
  }

  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { id: true, title: true },
  });
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });

  const type = await prisma.artifactType.findUnique({
    where: { key: body.artifactTypeKey },
    select: {
      id: true,
      name: true,
      enabled: true,
      versions: {
        where: { active: true },
        orderBy: { version: 'desc' },
        take: 1,
        select: { version: true },
      },
    },
  });
  if (!type) return NextResponse.json({ error: 'No such artifact type' }, { status: 404 });
  if (!type.enabled) {
    return NextResponse.json(
      { error: 'That artifact type is archived. Restore it in admin to generate from it.' },
      { status: 409 },
    );
  }

  const active = type.versions[0];
  if (!active) {
    // Not reachable through the UI — createArtifactType makes the type and its
    // active v1 in one transaction — but a type with no active version cannot
    // generate anything, and saying so beats a foreign-key error from a step.
    return NextResponse.json(
      { error: 'That artifact type has no active version.' },
      { status: 503 },
    );
  }

  // Deliberately no `assertEditable`, matching the scope-map route. A FINALISED
  // estimate is the main presales case for producing a document from it, and
  // nothing here writes to the estimate's own numbers.

  // Already running? Return it rather than starting a second. Generation is
  // N+2 paid model calls, and a double-clicked button should not cost twice.
  const running = await prisma.estimateArtifact.findFirst({
    where: { estimateId, artifactTypeId: type.id, status: { in: ['IDLE', 'RUNNING'] } },
    select: { id: true },
  });
  if (running) {
    return NextResponse.json({ artifactId: running.id, alreadyRunning: true });
  }

  const artifact = await prisma.estimateArtifact.create({
    data: {
      estimateId,
      artifactTypeId: type.id,
      // Snapshotted now, not read later: the document must be able to say what
      // produced it even after the type has been edited half a dozen times, and
      // an edit mid-generation must not switch prompts underneath it.
      typeVersion: active.version,
      title: type.name,
      inputs: (body.inputs ?? undefined) as never,
      status: 'RUNNING',
      stage: 'Queued',
      pct: 0,
      startedAt: new Date(),
      createdBy: session.user.email ?? null,
    },
    select: { id: true },
  });

  await inngest.send({ name: EVENT_ARTIFACT, data: { artifactId: artifact.id } });

  return NextResponse.json({ artifactId: artifact.id });
}
