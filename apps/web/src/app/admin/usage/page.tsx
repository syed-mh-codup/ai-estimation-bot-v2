import Link from 'next/link';
import { Prisma, prisma, usageLabel } from '@repo/db';
import type { UsageKind } from '@repo/db';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

/**
 * The single report every model call feeds. Cost is recorded once on ModelUsage,
 * so the run crew, Oracle, ingestion and preset embedding are all answerable
 * here — per agent, per estimate, per run, per model and over time.
 *
 * Read-only, like every other admin surface. There is no write action and no
 * reason to accept one.
 *
 * Everything is aggregated IN THE DATABASE rather than by reading rows. A run
 * writes roughly `8 + 4 x requirements` rows, so this table is the fastest
 * growing one in the schema and a `findMany` here would be reading the whole
 * bill to print a summary of it. Every query below is bounded by something
 * small — the kind/model vocabulary, or the number of runs — never by the
 * number of calls.
 *
 * A null cost is "the provider told us nothing", which is a different fact from
 * "this call was free". Summing it as zero would quietly understate the bill, so
 * every total that absorbs one also reports how many it absorbed.
 */

/** Rendered rows are capped; spend is what ranks them, so the cap keeps the top. */
const MAX_ROWS = 50;
const TREND_DAYS = 30;

type TrendRow = { day: string; calls: number; cost: number; unpriced: number };

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ estimateId?: string }>;
}) {
  const { estimateId } = await searchParams;

  const where = estimateId ? { estimateId } : {};
  const sums = { promptTokens: true, completionTokens: true, costUsd: true } as const;
  // `_all` counts calls; `costUsd` counts only the ones that came back priced,
  // so `_all - costUsd` is exactly how many the totals absorbed as zero.
  const counts = { _all: true, costUsd: true } as const;
  const estimateFilter = estimateId
    ? Prisma.sql`WHERE "estimateId" = ${estimateId}`
    : Prisma.empty;

  const [byKindModel, byEstimateRun, totals, trend] = await Promise.all([
    // Bounded by the kind x model vocabulary. Feeds both the per-agent and the
    // per-model table — they are two projections of the same grouping.
    prisma.modelUsage.groupBy({ by: ['kind', 'model'], where, _sum: sums, _count: counts }),
    // Bounded by the number of runs, not calls. Feeds per-estimate, per-run, and
    // the distinct-run count per estimate.
    prisma.modelUsage.groupBy({ by: ['estimateId', 'runId'], where, _sum: sums, _count: counts }),
    prisma.modelUsage.aggregate({ where, _sum: sums, _count: counts }),
    // Prisma cannot group by a date truncation, and bucketing in JS would mean
    // reading every row back — the thing this page exists not to do.
    prisma.$queryRaw<TrendRow[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS calls,
             COALESCE(SUM("costUsd"), 0)::float8 AS cost,
             (COUNT(*) FILTER (WHERE "costUsd" IS NULL))::int AS unpriced
      FROM "ModelUsage"
      ${estimateFilter}
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${TREND_DAYS}
    `,
  ]);

  const totalCalls = totals._count._all;
  const totalCost = totals._sum.costUsd ?? 0;
  const totalTokens = (totals._sum.promptTokens ?? 0) + (totals._sum.completionTokens ?? 0);
  const unpricedCalls = totalCalls - totals._count.costUsd;

  // ─── Per agent, and per model: two rollups of one grouping ─────────────────
  type Agg = { calls: number; unpriced: number; tokens: number; cost: number };
  const blank = (): Agg => ({ calls: 0, unpriced: 0, tokens: 0, cost: 0 });
  // Structural, so the same rollup serves both groupings — their `by` tuples
  // differ but the aggregate shape this reads is identical.
  type Grouped = {
    _count: { _all: number; costUsd: number };
    _sum: {
      promptTokens: number | null;
      completionTokens: number | null;
      costUsd: number | null;
    };
  };
  const add = (a: Agg, g: Grouped) => {
    a.calls += g._count._all;
    a.unpriced += g._count._all - g._count.costUsd;
    a.tokens += (g._sum.promptTokens ?? 0) + (g._sum.completionTokens ?? 0);
    a.cost += g._sum.costUsd ?? 0;
    return a;
  };

  const byKind = new Map<UsageKind, Agg & { models: Set<string> }>();
  const byModel = new Map<string, Agg>();
  for (const g of byKindModel) {
    const kind = byKind.get(g.kind) ?? { ...blank(), models: new Set<string>() };
    add(kind, g);
    if (g.model) kind.models.add(g.model);
    byKind.set(g.kind, kind);

    // A null model is still real spend and stays in the per-kind total, but it
    // cannot be a row in a table keyed by model name.
    if (g.model) byModel.set(g.model, add(byModel.get(g.model) ?? blank(), g));
  }

  // ─── Per estimate, and per run: two rollups of the other grouping ──────────
  const byEstimate = new Map<string, Agg & { runs: Set<string> }>();
  const byRun = new Map<string, Agg>();
  for (const g of byEstimateRun) {
    if (g.estimateId) {
      const est = byEstimate.get(g.estimateId) ?? { ...blank(), runs: new Set<string>() };
      add(est, g);
      if (g.runId) est.runs.add(g.runId);
      byEstimate.set(g.estimateId, est);
    }
    if (g.runId) byRun.set(g.runId, add(byRun.get(g.runId) ?? blank(), g));
  }

  const kindRows = [...byKind.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const modelRows = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, MAX_ROWS);
  const runRows = [...byRun.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, MAX_ROWS);
  const estimateRanked = [...byEstimate.entries()]
    .sort((a, b) => b[1].cost - a[1].cost)
    .slice(0, MAX_ROWS);

  // Titles only for the rows that will actually render.
  const titles = new Map(
    (
      await prisma.estimate.findMany({
        where: { id: { in: estimateRanked.map(([id]) => id) } },
        select: { id: true, title: true },
      })
    ).map((e) => [e.id, e.title]),
  );

  const money = (v: number) => (v > 0 ? `$${v.toFixed(4)}` : '—');
  const unpricedNote = (v: Agg) =>
    v.unpriced > 0 ? (
      <span
        className="ml-1 text-[11px] text-ink-4"
        title={`${v.unpriced} of ${v.calls} calls reported no cost`}
      >
        +{v.unpriced} unpriced
      </span>
    ) : null;

  return (
    <div data-testid="admin-usage">
      <Heading level={1}>Model usage</Heading>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Every model call, costed once, in one place. Spend is per estimate, per
        agent, per run and per model — the feedback loop for prompt edits and
        model swaps.
      </p>

      {estimateId && (
        <p className="mt-2.5 text-[12.5px]">
          <Link href="/admin/usage" className="text-green hover:underline">
            ← Clear filter
          </Link>
        </p>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Total spend"
          value={money(totalCost)}
          hint={
            unpricedCalls > 0
              ? `${unpricedCalls.toLocaleString()} of ${totalCalls.toLocaleString()} calls unpriced — actual spend is higher`
              : undefined
          }
        />
        <Stat label="Total tokens" value={totalTokens.toLocaleString()} />
        <Stat label="Total calls" value={totalCalls.toLocaleString()} />
      </div>

      <Section title="Per agent">
        <Table
          testid="usage-by-agent"
          heads={['Agent', 'Calls', 'Tokens', 'Cost', 'Models']}
          body={kindRows.map(([kind, v]) => [
            <span key="k">{usageLabel(kind)}</span>,
            <span key="c" className="num">{v.calls.toLocaleString()}</span>,
            <span key="t" className="num">{v.tokens.toLocaleString()}</span>,
            <span key="m" className="num">
              {money(v.cost)}
              {unpricedNote(v)}
            </span>,
            <div key="mods" className="flex flex-wrap gap-1">
              {[...v.models].sort().map((m) => (
                <Pill key={m} dot={false} className="num text-[11px]">{m}</Pill>
              ))}
            </div>,
          ])}
        />
      </Section>

      <Section title="Per estimate">
        <Table
          testid="usage-by-estimate"
          heads={['Estimate', 'Calls', 'Tokens', 'Cost', 'Runs']}
          body={estimateRanked.map(([id, v]) => [
            <Link key="e" href={`/admin/usage?estimateId=${id}`} className="font-semibold text-ink hover:text-green hover:underline">
              {titles.get(id) ?? id}
            </Link>,
            <span key="c" className="num">{v.calls.toLocaleString()}</span>,
            <span key="t" className="num">{v.tokens.toLocaleString()}</span>,
            <span key="m" className="num">
              {money(v.cost)}
              {unpricedNote(v)}
            </span>,
            <span key="r" className="num">{v.runs.size}</span>,
          ])}
        />
      </Section>

      <Section title="Per model">
        <Table
          testid="usage-by-model"
          heads={['Model', 'Calls', 'Tokens', 'Cost']}
          body={modelRows.map(([model, v]) => [
            <span key="m" className="num">{model}</span>,
            <span key="c" className="num">{v.calls.toLocaleString()}</span>,
            <span key="t" className="num">{v.tokens.toLocaleString()}</span>,
            <span key="x" className="num">
              {money(v.cost)}
              {unpricedNote(v)}
            </span>,
          ])}
        />
      </Section>

      <Section title={`Per day (last ${TREND_DAYS})`}>
        <p className="mb-2.5 text-[12.5px] text-ink-3">
          Whether spend is trending up. A prompt edit or a model swap that doubles
          the bill shows up here as a step, not as a surprise at the end of the month.
        </p>
        <Table
          testid="usage-by-day"
          heads={['Day', 'Calls', 'Cost', 'Unpriced']}
          body={trend.map((d) => [
            <span key="d" className="num">{d.day}</span>,
            <span key="c" className="num">{d.calls.toLocaleString()}</span>,
            <span key="x" className="num">{money(d.cost)}</span>,
            <span key="u" className="num text-ink-3">{d.unpriced > 0 ? d.unpriced : '—'}</span>,
          ])}
        />
      </Section>

      {estimateId && runRows.length > 0 && (
        <Section title="Per run">
          <Table
            testid="usage-by-run"
            heads={['Run', 'Calls', 'Tokens', 'Cost']}
            body={runRows.map(([runId, v]) => [
              <span key="r" className="num font-mono text-[11px]">{runId}</span>,
              <span key="c" className="num">{v.calls.toLocaleString()}</span>,
              <span key="t" className="num">{v.tokens.toLocaleString()}</span>,
              <span key="x" className="num">
                {money(v.cost)}
                {unpricedNote(v)}
              </span>,
            ])}
          />
        </Section>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="eyebrow text-ink-3">{label}</div>
      <div className="num mt-1 text-[22px] font-medium text-ink">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-ink-4">{hint}</div>}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5">
      <Heading level={2}>{title}</Heading>
      {children}
    </div>
  );
}

function Table({
  testid,
  heads,
  body,
}: {
  testid: string;
  heads: string[];
  body: React.ReactNode[][];
}) {
  return (
    <Card className="mt-2.5 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]" data-testid={testid}>
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left">
              {heads.map((h) => (
                <th key={h} className="eyebrow px-4 py-2.5 font-bold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.length === 0 ? (
              <tr>
                <td colSpan={heads.length} className="px-4 py-6 text-center text-ink-3">
                  No usage recorded yet.
                </td>
              </tr>
            ) : (
              body.map((cells, i) => (
                <tr key={i} className="border-b border-line-soft last:border-0 hover:bg-surface-2">
                  {cells.map((cell, j) => (
                    <td key={j} className="px-4 py-3 text-ink-2">{cell}</td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
