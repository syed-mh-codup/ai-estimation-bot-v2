import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Reload-safe run status for the client poller. Returns the persisted run state
 * plus the menu-item count so the UI knows when to refresh into the Menu Card.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const { id } = await params;
  const est = await prisma.estimate.findUnique({
    where: { id },
    select: {
      runStatus: true,
      runStage: true,
      runPct: true,
      runError: true,
      status: true,
      _count: { select: { menuItems: true } },
    },
  });
  if (!est) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({
    runStatus: est.runStatus,
    runStage: est.runStage,
    runPct: est.runPct,
    runError: est.runError,
    status: est.status,
    menuItemCount: est._count.menuItems,
  });
}
