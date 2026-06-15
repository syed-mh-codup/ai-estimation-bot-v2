import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Reload-safe ingestion status for the new-estimate page poller. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const est = await prisma.estimate.findUnique({
    where: { id },
    select: { ingestStatus: true, ingestStage: true, ingestPct: true, ingestError: true },
  });
  if (!est) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({
    ingestStatus: est.ingestStatus,
    ingestStage: est.ingestStage,
    ingestPct: est.ingestPct,
    ingestError: est.ingestError,
  });
}
