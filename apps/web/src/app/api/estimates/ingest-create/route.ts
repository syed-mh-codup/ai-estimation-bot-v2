import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { inngest } from '@/lib/inngest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';


/**
 * Create a DRAFT estimate from pasted text and/or uploaded client material.
 * Uploaded bytes are persisted to UploadedFile (so the durable ingest function
 * can read them after this request returns — required on serverless), then an
 * Inngest event triggers background parsing. Returns the new id immediately.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const form = await req.formData();
  const title = (form.get('title') as string | null)?.trim();
  const pasted = (form.get('sowText') as string | null)?.trim() ?? '';
  const uploads = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0);

  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  if (!pasted && uploads.length === 0) {
    return NextResponse.json({ error: 'provide pasted text or at least one file' }, { status: 400 });
  }

  // Read bytes now — the File objects are only valid during this request.
  const files = await Promise.all(
    uploads.map(async (f) => ({
      filename: f.name,
      mimeType: f.type || 'application/octet-stream',
      bytes: Buffer.from(await f.arrayBuffer()),
    })),
  );

  const activeConfig = await prisma.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const hasFiles = files.length > 0;
  const estimate = await prisma.estimate.create({
    data: {
      title,
      sowText: pasted,
      status: 'DRAFT',
      configVersion: activeConfig?.version ?? 0,
      agentState: {},
      ownerId: session.user.id,
      ingestStatus: hasFiles ? 'RUNNING' : 'IDLE',
      ingestStage: hasFiles ? 'Queued' : null,
      ingestPct: 0,
      uploadedFiles: hasFiles
        ? { create: files.map((f) => ({ filename: f.filename, mimeType: f.mimeType, bytes: f.bytes })) }
        : undefined,
    },
    select: { id: true },
  });

  if (hasFiles) {
    await inngest.send({ name: 'estimate/ingest.requested', data: { estimateId: estimate.id } });
  }

  return NextResponse.json({ id: estimate.id, ingesting: hasFiles }, { status: 202 });
}
