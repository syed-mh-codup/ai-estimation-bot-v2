import { NextResponse } from 'next/server';

import { prisma } from '@repo/db';
import type { ArtifactOutline } from '@repo/shared';

import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live state of ONE generating artifact. AEH-239.
 *
 * Separate from the per-estimate status route next door, which deliberately
 * returns a thin row per artifact for the rail card. This one is polled by a
 * single open artifact page and carries the thing that makes a real progress
 * view possible: the outline, and which of its sections have actually landed.
 *
 * The outline is what makes this better than a percentage. It is persisted
 * before any section is written, so once planning is done the UI knows exactly
 * how many sections there will be AND what each is called — the steps are named
 * rather than guessed, and "4 of 9 written" is a counted fact.
 *
 * `content` is never selected. The assembled document is ~100KB and this is
 * fetched every couple of seconds.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; artifactId: string }> },
) {
  const { id: estimateId, artifactId } = await params;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const artifact = await prisma.estimateArtifact.findUnique({
    where: { id: artifactId },
    select: {
      id: true,
      estimateId: true,
      status: true,
      stage: true,
      pct: true,
      error: true,
      outline: true,
      sections: { orderBy: { order: 'asc' }, select: { sectionId: true } },
    },
  });
  // Checked rather than assumed: an artifact id belonging to another estimate
  // must not be readable through this estimate's URL.
  if (!artifact || artifact.estimateId !== estimateId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Cast rather than re-validate: this JSON was written by the outline step
  // after passing ArtifactOutlineSchema, so it is already the right shape, and
  // a parse failure here would break a progress view over a document that is
  // generating perfectly well.
  const outline = (artifact.outline ?? null) as ArtifactOutline | null;

  return NextResponse.json({
    status: artifact.status,
    stage: artifact.stage,
    pct: artifact.pct,
    error: artifact.error,
    title: outline?.title ?? null,
    sections: (outline?.sections ?? []).map((s) => ({ id: s.id, title: s.title })),
    written: artifact.sections.map((s) => s.sectionId),
  });
}
