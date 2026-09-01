import Link from 'next/link';
import { prisma } from '@repo/db';
import { Eyebrow } from '@/components/ui/card';
import { requireAdmin } from '@/lib/rbac';

/**
 * What this estimate has cost to produce, all in — every model call across every
 * re-run, read from the one ModelUsage table. Admin-only, like its Oracle
 * sibling, because spend is an oversight number rather than an estimator's
 * working surface.
 *
 * The page gates on role before rendering this; the requireAdmin below is the
 * gate that actually holds, since a server component is reachable independently
 * of the branch that chose to render it.
 */
export async function ModelUsagePanel({ estimateId }: { estimateId: string }) {
  await requireAdmin();

  const rows = await prisma.modelUsage.findMany({
    where: { estimateId },
    select: { costUsd: true, promptTokens: true, completionTokens: true, runId: true },
  });

  const cost = rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const tokens = rows.reduce(
    (sum, r) => sum + (r.promptTokens ?? 0) + (r.completionTokens ?? 0),
    0,
  );
  const runs = new Set(rows.map((r) => r.runId).filter(Boolean)).size;

  return (
    <div
      className="rounded-[10px] border border-line bg-surface px-4 py-3.5"
      data-testid="model-usage-panel"
    >
      <Eyebrow>Model spend</Eyebrow>

      {rows.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-3">No model calls recorded for this estimate yet.</p>
      ) : (
        <div className="mt-2 space-y-1 text-[12.5px]">
          <div className="flex items-baseline justify-between">
            <span className="text-ink-3">Total cost</span>
            <span className="num text-ink">{cost > 0 ? `$${cost.toFixed(4)}` : '—'}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-ink-3">Tokens</span>
            <span className="num text-ink">{tokens.toLocaleString()}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <span className="text-ink-3">Runs</span>
            <span className="num text-ink">{runs}</span>
          </div>
        </div>
      )}

      <Link
        href={`/admin/usage?estimateId=${estimateId}`}
        className="mt-2.5 inline-block text-[11.5px] text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
      >
        Full usage breakdown →
      </Link>
    </div>
  );
}
