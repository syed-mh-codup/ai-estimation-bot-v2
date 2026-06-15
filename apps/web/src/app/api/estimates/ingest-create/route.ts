import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import { createModelProvider } from '@repo/providers';
import { ingestFiles, type IngestFile } from '@repo/agents';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Create a DRAFT estimate from pasted text and/or uploaded client material
 * (PDF/DOCX/images/text). Returns the new id immediately; if files were
 * uploaded, ingestion (vision/OCR — slow) runs in the background and appends the
 * parsed text to the SOW. The client polls GET /[id]/ingest-status.
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

  // Read file bytes NOW — the File objects are only valid during this request;
  // the background task runs after we've returned.
  const files: IngestFile[] = await Promise.all(
    uploads.map(async (f) => ({
      filename: f.name,
      mimeType: f.type || 'application/octet-stream',
      bytes: new Uint8Array(await f.arrayBuffer()),
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
      sowHash: sha(pasted),
      status: 'DRAFT',
      configVersion: activeConfig?.version ?? 0,
      taxonomyVersionsPinned: {},
      promptVersionsPinned: {},
      modelConfig: {},
      agentState: {},
      ownerId: session.user.id,
      ingestStatus: hasFiles ? 'RUNNING' : 'IDLE',
      ingestStage: hasFiles ? 'Queued' : null,
      ingestPct: 0,
    },
    select: { id: true },
  });

  if (hasFiles) void executeIngest(estimate.id, pasted, files);

  return NextResponse.json({ id: estimate.id, ingesting: hasFiles }, { status: 202 });
}

async function executeIngest(id: string, pasted: string, files: IngestFile[]): Promise<void> {
  try {
    const { text } = await ingestFiles(files, {
      modelProvider: createModelProvider(),
      onProgress: async ({ stage, pct }) => {
        await prisma.estimate.update({ where: { id }, data: { ingestStage: stage, ingestPct: pct } });
      },
    });
    const combined = [pasted, text].filter((s) => s.trim().length > 0).join('\n\n');
    await prisma.estimate.update({
      where: { id },
      data: {
        sowText: combined,
        sowHash: sha(combined),
        ingestStatus: 'DONE',
        ingestStage: 'Done',
        ingestPct: 100,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.estimate.update({
      where: { id },
      data: { ingestStatus: 'FAILED', ingestStage: 'Failed', ingestError: msg.slice(0, 500) },
    });
  }
}
