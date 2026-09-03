import { NextResponse } from 'next/server';

import { prisma } from '@repo/db';

import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * What every artifact on this estimate is doing. AEH-239.
 *
 * Polled, like the run's status route, because generation is a durable Inngest
 * job rather than something streamed inside one request. The client stops
 * polling when nothing is RUNNING.
 *
 * `content` is NEVER selected. An assembled document is ~100KB, and this is
 * fetched every couple of seconds while one is generating — returning it would
 * make the poll heavier than the work it is reporting on.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: estimateId } = await params;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const artifacts = await prisma.estimateArtifact.findMany({
    where: { estimateId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      title: true,
      status: true,
      stage: true,
      pct: true,
      error: true,
      createdAt: true,
      finishedAt: true,
      artifactType: { select: { key: true, name: true } },
      // The section count is the honest denominator for the progress line —
      // "4 of 9 written" rather than a percentage nobody can check.
      _count: { select: { sections: true } },
    },
  });

  return NextResponse.json({
    artifacts: artifacts.map((a) => ({
      id: a.id,
      title: a.title,
      typeKey: a.artifactType.key,
      typeName: a.artifactType.name,
      status: a.status,
      stage: a.stage,
      pct: a.pct,
      error: a.error,
      sectionsWritten: a._count.sections,
      createdAt: a.createdAt,
      finishedAt: a.finishedAt,
    })),
  });
}
