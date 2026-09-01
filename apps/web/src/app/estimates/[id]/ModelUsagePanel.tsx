import Link from 'next/link';
import { prisma, usageLabel } from '@repo/db';
import { Eyebrow } from '@/components/ui/card';
import { requireAdmin } from '@/lib/rbac';

/**
 * What this estimate has cost to produce, all in — every model call across every
 * re-run, read from the one ModelUsage table. Admin-only, like its Oracle
 * sibling, because spend is an oversight number rather than an estimator's
 * working surface.
 *
 * Broken down per agent on the spot, not just totalled. "Which agent is burning
 * the money" is the question this data exists to answer, and answering it one
 * click away on /admin/usage means it goes unanswered — the Specialist council
 * being four calls per requirement is the assumption everyone repeats and nobody
 * has checked. The full report still owns per-run, per-model and the trend.
 *
 * Aggregated in the database. A run writes roughly `8 + 4 x requirements` rows,
 * so reading them back to add up four numbers would make the panel slower every
 * time somebody re-runs.
 *
 * The page gates on role before rendering this; the requireAdmin below is the
 * gate that actually holds, since a server component is reachable independently
 * of the branch that chose to render it.
 */
export async function ModelUsagePanel({ estimateId }: { estimateId: string }) {
  await requireAdmin();

  const where = { estimateId };
  const sums = { promptTokens: true, completionTokens: true, costUsd: true } as const;
  // `_all` counts calls, `costUsd` counts the priced ones — the difference is
  // how many calls the total below absorbed as zero.
  const counts = { _all: true, costUsd: true } as const;

  const [totals, byKind, runs] = await Promise.all([
    prisma.modelUsage.aggregate({ where, _sum: sums, _count: counts }),
    prisma.modelUsage.groupBy({
      by: ['kind'],
      where,
      _sum: { costUsd: true },
      _count: { _all: true },
    }),
    prisma.modelUsage.groupBy({ by: ['runId'], where }),
  ]);

  const calls = totals._count._all;
  const cost = totals._sum.costUsd ?? 0;
  const tokens = (totals._sum.promptTokens ?? 0) + (totals._sum.completionTokens ?? 0);
  // Same rule as the full report: a null cost is unknown, not free, so a total
  // that absorbed one says so rather than presenting itself as the whole bill.
  const unpriced = calls - totals._count.costUsd;
  const runCount = runs.filter((r) => r.runId !== null).length;

  const kindRows = byKind
    .map((k) => ({ kind: k.kind, cost: k._sum.costUsd ?? 0, calls: k._count._all }))
    .sort((a, b) => b.cost - a.cost);

  const money = (v: number) => (v > 0 ? `$${v.toFixed(4)}` : '—');

  return (
    <section
      className="rounded-[10px] border border-line bg-surface p-4"
      data-testid="model-usage-panel"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Model spend</Eyebrow>
        {runCount > 0 && (
          <span className="num text-[11px] text-ink-4" data-testid="model-usage-runs">
            {runCount} {runCount === 1 ? 'run' : 'runs'}
          </span>
        )}
      </div>

      {calls === 0 ? (
        <p className="mt-2 text-[12px] text-ink-3">No model calls recorded for this estimate yet.</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
            <Stat label="Total cost" value={money(cost)} />
            <Stat label="Calls" value={calls.toLocaleString()} />
            <Stat label="Tokens" value={tokens.toLocaleString()} />
            <Stat label="Runs" value={runCount} />
          </div>

          {unpriced > 0 && (
            <p className="mt-3 border-t border-line-soft pt-2.5 text-[12px] text-ink-3">
              <span className="num text-ink-2">{unpriced}</span> of{' '}
              <span className="num text-ink-2">{calls}</span> calls reported no cost — actual spend
              is higher.
            </p>
          )}

          <div className="mt-3 border-t border-line-soft pt-2.5" data-testid="model-usage-by-agent">
            <div className="eyebrow">Per agent</div>
            <ul className="mt-1.5 space-y-1">
              {kindRows.map((k) => (
                <li
                  key={k.kind}
                  className="flex items-baseline justify-between gap-2 text-[12px] text-ink-2"
                >
                  <span>
                    {usageLabel(k.kind)}
                    <span className="num ml-1.5 text-[11px] text-ink-4">×{k.calls}</span>
                  </span>
                  <span className="num text-ink">{money(k.cost)}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      <Link
        href={`/admin/usage?estimateId=${estimateId}`}
        className="mt-2.5 inline-block text-[11.5px] text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
      >
        Full usage breakdown →
      </Link>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="num mt-0.5 text-[15px] text-ink">{value}</div>
    </div>
  );
}
