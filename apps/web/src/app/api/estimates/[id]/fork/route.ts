import { NextResponse } from 'next/server';
import { prisma, forkEstimate, type LineageKind } from '@repo/db';
import { auth } from '@/lib/auth';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = new Set<LineageKind>(['SUCCESSOR', 'BRANCH']);

/**
 * Header that separates the parent's brief from anything attached at fork time.
 *
 * The ingest already appends what it parses to whatever `sowText` holds — it
 * joins `est.sowText` with the new text — so the fork does not need a second
 * append path. What it needs is for the seam to be VISIBLE, because the whole
 * reason a successor keeps the original brief is that a change request only
 * means something read against the document it changes. Without a marker the
 * Librarian sees one undifferentiated wall and cannot tell which sentence
 * supersedes which.
 */
function revisedMaterialHeader(): string {
  const on = new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return `\n\n── Revised material, added ${on} ──`;
}

/**
 * Fork an estimate into a successor or a branch. AEH-236.
 *
 * A route rather than a server action because of the documents: this is the
 * same shape as creating an estimate — multipart in, an id back immediately,
 * ingestion continuing in the background — so it reuses `ingest-create`'s whole
 * path, including the `/ingest-status` poll the client already knows how to
 * drive. A server action would have had to reinvent all of it.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id: parentId } = await params;
  const form = await req.formData();
  const title = (form.get('title') as string | null)?.trim() ?? '';
  const kindRaw = (form.get('kind') as string | null)?.trim() ?? '';
  const steer = (form.get('steer') as string | null)?.trim() ?? '';
  const uploads = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

  if (!KINDS.has(kindRaw as LineageKind)) {
    return NextResponse.json({ error: 'Choose whether this is a successor or a branch.' }, { status: 400 });
  }

  // Read the bytes now: the File objects are only valid for the life of this
  // request, and the ingest runs long after it has returned. `order` is the
  // index in `form.getAll`, which preserves the order the client appended them
  // — the same chain `ingest-create` depends on, for the same reason: the
  // documents are concatenated in reading order and a contract read after three
  // decks of background is read differently from one read before them.
  const files = await Promise.all(
    uploads.map(async (f, order) => ({
      filename: f.name,
      mimeType: f.type || 'application/octet-stream',
      bytes: Buffer.from(await f.arrayBuffer()),
      order,
    })),
  );

  const result = await forkEstimate(prisma, {
    parentId,
    title,
    kind: kindRaw as LineageKind,
    steer: steer || null,
    ownerId: session.user.id,
  });

  // A refusal is a 409 with the reason the copy itself gave — "that estimate is
  // being estimated right now" is something a person can act on, and inventing
  // a generic message here would throw away the only useful half.
  if (result.kind === 'refused') {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  if (files.length > 0) {
    // Read back rather than reconstruct: the header has to land on exactly what
    // the copy wrote, and Prisma has no string-concat update to do it in place.
    // @deleted-ok reads the fork just created, not the parent — a brand-new
    // row cannot be deleted, and `forkEstimate` already refused a deleted
    // parent. AEH-375.
    const est = await prisma.estimate.findUniqueOrThrow({
      where: { id: result.estimateId },
      select: { sowText: true },
    });
    await prisma.estimate.update({
      where: { id: result.estimateId },
      data: {
        sowText: est.sowText + revisedMaterialHeader(),
        ingestStatus: 'RUNNING',
        ingestStage: 'Queued',
        ingestPct: 0,
        uploadedFiles: { create: files },
      },
    });
    await inngest.send({
      name: 'estimate/ingest.requested',
      data: { estimateId: result.estimateId },
    });
  }

  return NextResponse.json(
    { id: result.estimateId, ingesting: files.length > 0, counts: result.counts },
    { status: 201 },
  );
}
