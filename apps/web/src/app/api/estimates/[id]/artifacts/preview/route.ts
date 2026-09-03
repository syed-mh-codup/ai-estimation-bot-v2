import { NextResponse } from 'next/server';

import { corpusSection, prisma } from '@repo/db';
import { previewArtifactOutline } from '@repo/agents';

import { auth } from '@/lib/auth';
import { artifactModelProvider } from '@/lib/artifact-provider';

export const runtime = 'nodejs';

/**
 * One model call: comfortably inside the ceiling, and the reason this can be a
 * plain request where generation cannot.
 */
export const maxDuration = 300;

/**
 * Plan a document without writing it. AEH-239.
 *
 * This is here because nothing is seeded. Every artifact type is authored by
 * hand, which means a brief is arrived at by iterating — and the alternative to
 * a dry run is committing to nine sections of generation to discover the plan
 * was wrong. One call and a couple of thousand tokens answers it in seconds.
 *
 * Synchronous, unlike generation, because it IS one call. No artifact row is
 * created, so a preview leaves nothing behind to clean up.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: estimateId } = await params;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { artifactTypeKey?: unknown };
  if (typeof body.artifactTypeKey !== 'string') {
    return NextResponse.json({ error: 'Which artifact type?' }, { status: 400 });
  }

  const type = await prisma.artifactType.findUnique({
    where: { key: body.artifactTypeKey },
    select: {
      id: true,
      versions: {
        where: { active: true },
        orderBy: { version: 'desc' },
        take: 1,
        select: { version: true },
      },
    },
  });
  const active = type?.versions[0];
  if (!type || !active) {
    return NextResponse.json({ error: 'No such artifact type' }, { status: 404 });
  }

  try {
    const preview = await previewArtifactOutline({
      db: prisma,
      estimateId,
      artifactTypeId: type.id,
      typeVersion: active.version,
      modelProvider: artifactModelProvider(),
    });

    // Section keys are resolved to their display labels HERE rather than in the
    // panel, because the panel is a client component and the catalogue lives in
    // @repo/db — importing it there would pull Prisma into the browser bundle.
    // Retired keys keep their raw form on purpose: they have no profile left to
    // look up, and the raw key is what an author needs to recognise and untick.
    return NextResponse.json({
      ...preview,
      empty: preview.empty.map((key) => ({ key, label: corpusSection(key).label })),
    });
  } catch (err) {
    // The messages this throws are written for the person reading them — "every
    // section this artifact reads is empty on this estimate" is the actual
    // answer, and flattening it to a 500 would waste it.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not plan the document' },
      { status: 422 },
    );
  }
}
