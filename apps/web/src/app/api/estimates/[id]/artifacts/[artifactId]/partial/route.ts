import { NextResponse } from 'next/server';

import { prisma } from '@repo/db';
import type { ArtifactOutline } from '@repo/shared';

import { auth } from '@/lib/auth';
import { assemblePartialArtifact } from '@/lib/artifact-partial';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The sections of a generating document, assembled so they can be read. AEH-326.
 *
 * Alongside the status route rather than part of it, and deliberately so. The
 * status route is polled every two seconds and never selects a section's body
 * for that exact reason; this one selects every body it can find. Merging them
 * would put ~100KB on a two-second poll to answer a question nobody asks twice
 * a second — "is this any good" is asked once, and then again when a few more
 * sections have landed.
 *
 * ## Why it is worth an endpoint
 *
 * A generation takes minutes and `content` stays null until the final assemble
 * step, so until then the only way to read the first section was to pull the
 * rows out of the database by hand. The judgement it supports is the expensive
 * one: a document whose first section is wrong will be wrong for ten more
 * sections, and the run can be stopped.
 *
 * Nothing is stored and nothing is written. The rows are already there.
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
      estimateId: true,
      title: true,
      outline: true,
      artifactType: { select: { name: true } },
      estimate: { select: { title: true } },
      sections: {
        orderBy: { order: 'asc' },
        select: { sectionId: true, title: true, html: true },
      },
    },
  });
  // Checked rather than assumed: an artifact id belonging to another estimate
  // must not be readable through this estimate's URL. Same guard as the status
  // route next door, and it matters more here — this one returns the prose.
  if (!artifact || artifact.estimateId !== estimateId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Cast rather than re-validate, as the status route does: this JSON was
  // written by the outline step after passing ArtifactOutlineSchema, and a
  // parse failure here would deny someone a readable document that is
  // generating perfectly well. Only the count is used.
  const outline = (artifact.outline ?? null) as ArtifactOutline | null;

  // Not refused when the artifact has finished. A section can land and the run
  // finish between the poll that offered this and the click that fetches it, and
  // handing back an error at that moment would be a bug the reader cannot tell
  // from a broken feature. The finished document is what the page shows anyway.
  const partial = assemblePartialArtifact({
    title: artifact.title,
    estimateTitle: artifact.estimate.title,
    typeName: artifact.artifactType.name,
    planned: outline?.sections.length ?? 0,
    rows: artifact.sections,
  });

  return NextResponse.json(partial);
}
