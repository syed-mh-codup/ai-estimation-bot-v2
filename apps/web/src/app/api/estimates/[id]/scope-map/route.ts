import { NextResponse } from 'next/server';

import { prisma } from '@repo/db';
import { runCartographer } from '@repo/agents';

import { auth } from '@/lib/auth';
import { cartographerModelProvider } from '@/lib/cartographer-provider';

export const runtime = 'nodejs';

/**
 * Vercel Hobby's hard per-step ceiling, and the reason to say out loud that ONE
 * request here is ONE model call. The Cartographer reads a whole menu card in a
 * single turn; if that ever becomes a loop over cards it stops fitting.
 */
export const maxDuration = 300;

/**
 * Derive an estimate's dependency graph on demand. AEH-235.
 *
 * A plain route handler, not Inngest and not streamed.
 *
 * Not Inngest, for the reason the Oracle route gives: there is nothing durable
 * to resume, and the run/ingest progress columns are per-job-type, so a third
 * set on `Estimate` would be a worse trade than a synchronous call. Not
 * streamed either, unlike Oracle — a partial dependency graph is not something
 * you can render, so there is no interim state worth sending.
 *
 * On demand rather than part of a run because it uses a heavy model and most
 * estimates are never configured. Note what that costs: a re-run replaces every
 * card and therefore drops the graph, so it has to be asked for again. That is
 * the honest consequence of the cost decision, not an oversight — and if the
 * spend is ever judged worthwhile, calling `runCartographer` from the run's
 * persist step is the whole change.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: estimateId } = await params;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { id: true, _count: { select: { menuItems: true } } },
  });
  if (!estimate) return NextResponse.json({ error: 'Estimate not found' }, { status: 404 });
  if (estimate._count.menuItems === 0) {
    return NextResponse.json(
      { error: 'This estimate has no menu card yet. Run it first.' },
      { status: 409 },
    );
  }

  // Deliberately no `assertEditable`. A FINALISED estimate is the main presales
  // case for configuring scope, and nothing here writes to the estimate's own
  // numbers — it writes the dependency graph and the foundation flags, which
  // are what the configurator reads.

  const prompt = await prisma.promptVersion.findFirst({
    where: { kind: 'CARTOGRAPHER', active: true },
    orderBy: { version: 'desc' },
    select: { body: true, modelString: true },
  });
  if (!prompt) {
    // Not seeded. Worth its own message and status: the fix is a single
    // targeted command, and never the bootstrap seed, which would revert every
    // other live prompt to its two-sentence body.
    return NextResponse.json(
      { error: 'The Cartographer has no active prompt. Run pnpm db:seed:cartographer.' },
      { status: 503 },
    );
  }

  try {
    const result = await runCartographer({
      db: prisma,
      estimateId,
      modelProvider: cartographerModelProvider(),
      prompt,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    // The model returning something off-contract is a 502, not a 500: the
    // request was fine and the failure is upstream. Distinguishing them is what
    // makes "it broke" answerable without reading logs.
    const message = err instanceof Error ? err.message : 'Could not derive the dependency graph';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
