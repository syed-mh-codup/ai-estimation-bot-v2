import Link from 'next/link';
import { prisma, usageLabel, USAGE_PROFILES } from '@repo/db';
import type { Prisma, UsageKind } from '@repo/db';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { FilterFields } from '@/components/admin/filter-fields';
import {
  ControlRow,
  FilterChip,
  ResultScope,
  RowCap,
  SortHead,
  hrefWith,
  parseSort,
  type Sort,
} from '@/components/admin/report-controls';
import { SpendTrend } from './SpendTrend';

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
 * number of calls. The filters added in AEH-313 keep that rule: each narrows an
 * already-bounded query and none of them introduces a read of the whole table.
 *
 * A null cost is "the provider told us nothing", which is a different fact from
 * "this call was free". Summing it as zero would quietly understate the bill, so
 * every total that absorbs one also reports how many it absorbed.
 */

/** Rendered rows are capped; the active sort is what ranks them. */
const MAX_ROWS = 50;
const TREND_DAYS = 30;
/**
 * A date range widens the trend past its default window, but not without limit:
 * the per-day query is bounded by DAYS, and a range of "everything" would grow
 * with the age of the install rather than with anything on screen.
 */
const MAX_TREND_DAYS = 366;

const PATH = '/admin/usage';

type TrendRow = {
  day: string;
  calls: number;
  cost: number;
  tokens: number;
  unpriced: number;
};

/**
 * The sort vocabularies, per table, whitelisted.
 *
 * The estimate table deliberately has no `name`: an estimate's name is a title
 * on another table, and this page fetches titles only for the rows that survive
 * the cap. Offering a title sort would mean joining every estimate that has ever
 * been costed in order to rank fifty of them.
 */
const AGENT_SORTS = ['name', 'calls', 'tokens', 'cost'] as const;
const ESTIMATE_SORTS = ['calls', 'tokens', 'cost', 'runs'] as const;
const MODEL_SORTS = ['name', 'calls', 'tokens', 'cost'] as const;
const RUN_SORTS = ['name', 'calls', 'tokens', 'cost'] as const;
const DAY_SORTS = ['day', 'calls', 'tokens', 'cost', 'unpriced'] as const;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sort a COMPLETE rollup, before the cap is applied.
 *
 * This is not an ORDER BY, and it cannot be one. The four tables on this page
 * are two projections each of two groupings — agent and model are both rollups
 * of `groupBy(['kind','model'])`, estimate and run both of
 * `groupBy(['estimateId','runId'])` — so the figure being sorted on does not
 * exist as a column in the query that produces it.
 *
 * What matters is the guarantee, and the guarantee holds: those groupings carry
 * no `take`, so the set being sorted here is every row, and the cap is applied
 * afterwards. The hazard worth naming is the other order — sorting rows that
 * have ALREADY been cut would rank the fifty most expensive among themselves,
 * so "calls ascending" would return the least-called of the priciest and
 * present it as the least-called overall. Sort first, cap second, always.
 */
function sortRows<T, K extends string>(
  rows: T[],
  sort: Sort<K>,
  value: (row: T, key: K) => number | string,
): T[] {
  const mul = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = value(a, sort.key);
    const bv = value(b, sort.key);
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv));
    return cmp * mul;
  });
}

export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{
    estimateId?: string;
    kind?: string;
    model?: string;
    from?: string;
    to?: string;
    sortAgent?: string;
    sortEstimate?: string;
    sortModel?: string;
    sortRun?: string;
    sortDay?: string;
  }>;
}) {
  const sp = await searchParams;

  // ─── Filters, each validated before it reaches a query ─────────────────────
  const estimateId = sp.estimateId || '';
  // Whitelisted against the usage vocabulary, not trusted. This value is cast to
  // the Postgres enum in the trend statement below, where an unrecognised string
  // is not an empty result but a failed statement.
  const kind = (USAGE_PROFILES.some((p) => p.kind === sp.kind) ? sp.kind : '') as UsageKind | '';
  const model = sp.model || '';
  const from = DAY_RE.test(sp.from ?? '') ? sp.from! : '';
  const to = DAY_RE.test(sp.to ?? '') ? sp.to! : '';

  const filtered = !!(estimateId || kind || model || from || to);

  // The live parameters, so every sort link and every chip composes with the
  // current view instead of replacing it.
  const params: Record<string, string | undefined> = {
    estimateId: estimateId || undefined,
    kind: kind || undefined,
    model: model || undefined,
    from: from || undefined,
    to: to || undefined,
    sortAgent: sp.sortAgent,
    sortEstimate: sp.sortEstimate,
    sortModel: sp.sortModel,
    sortRun: sp.sortRun,
    sortDay: sp.sortDay,
  };

  const agentSort = parseSort(sp.sortAgent, AGENT_SORTS, { key: 'cost', dir: 'desc' });
  const estimateSort = parseSort(sp.sortEstimate, ESTIMATE_SORTS, { key: 'cost', dir: 'desc' });
  const modelSort = parseSort(sp.sortModel, MODEL_SORTS, { key: 'cost', dir: 'desc' });
  const runSort = parseSort(sp.sortRun, RUN_SORTS, { key: 'cost', dir: 'desc' });
  const daySort = parseSort(sp.sortDay, DAY_SORTS, { key: 'day', dir: 'desc' });

  // Inclusive of the whole end day: a range typed as "the 3rd to the 3rd" means
  // that day, not the single instant midnight begins it.
  const fromTs = from ? `${from}T00:00:00.000Z` : null;
  const toTs = to ? `${to}T23:59:59.999Z` : null;

  const where: Prisma.ModelUsageWhereInput = {
    ...(estimateId ? { estimateId } : {}),
    ...(kind ? { kind } : {}),
    ...(model ? { model } : {}),
    ...(fromTs || toTs
      ? {
          createdAt: {
            ...(fromTs ? { gte: new Date(fromTs) } : {}),
            ...(toTs ? { lte: new Date(toTs) } : {}),
          },
        }
      : {}),
  };

  const sums = { promptTokens: true, completionTokens: true, costUsd: true } as const;
  // `_all` counts calls; `costUsd` counts only the ones that came back priced,
  // so `_all - costUsd` is exactly how many the totals absorbed as zero.
  const counts = { _all: true, costUsd: true } as const;
  // Every filter is bound as a plain value, NOT spliced in as a Prisma.sql
  // fragment. A fragment has to survive an `instanceof Sql` check inside the
  // client, and the copy of the client this page bundles is not always the copy
  // the fragment was built from — when it isn't, the fragment is silently bound
  // as a parameter and Postgres rejects `FROM "ModelUsage" $1` with a syntax
  // error. A null-safe predicate needs no fragment at all, so the whole hazard
  // goes away. Adding three more dimensions here is precisely where that would
  // have re-detonated, so all four follow the same shape.
  const filterId = estimateId || null;
  const filterKind = kind || null;
  const filterModel = model || null;
  // The trend window is bounded by DAYS, never by calls. Without a range that is
  // the default window; with one it widens to the range, capped.
  const trendLimit = from || to ? MAX_TREND_DAYS : TREND_DAYS;

  const [byKindModel, byEstimateRun, totals, editTotals, trend, modelVocab] = await Promise.all([
    // Bounded by the kind x model vocabulary. Feeds both the per-agent and the
    // per-model table — they are two projections of the same grouping.
    prisma.modelUsage.groupBy({ by: ['kind', 'model'], where, _sum: sums, _count: counts }),
    // Bounded by the number of runs, not calls. Feeds per-estimate, per-run, and
    // the distinct-run count per estimate.
    prisma.modelUsage.groupBy({ by: ['estimateId', 'runId'], where, _sum: sums, _count: counts }),
    prisma.modelUsage.aggregate({ where, _sum: sums, _count: counts }),
    // Steered-edit spend, as ONE aggregate rather than a grouping — AEH-238.
    //
    // A re-price is charged to SPECIALIST_DEV and the rest of the council, the
    // same kinds a run uses, so the per-agent table cannot separate them. This
    // says how much of the bill came from somebody steering. Deliberately not
    // grouped by `ledgerEditId`: that is unbounded in the number of edits, and
    // this page exists not to read every row back.
    prisma.modelUsage.aggregate({
      where: { ...where, ledgerEditId: { not: null } },
      _sum: sums,
      _count: counts,
    }),
    // Prisma cannot group by a date truncation, and bucketing in JS would mean
    // reading every row back — the thing this page exists not to do.
    prisma.$queryRaw<TrendRow[]>`
      SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS day,
             COUNT(*)::int AS calls,
             COALESCE(SUM("costUsd"), 0)::float8 AS cost,
             (COALESCE(SUM("promptTokens"), 0) + COALESCE(SUM("completionTokens"), 0))::float8 AS tokens,
             (COUNT(*) FILTER (WHERE "costUsd" IS NULL))::int AS unpriced
      FROM "ModelUsage"
      WHERE (${filterId}::text IS NULL OR "estimateId" = ${filterId})
        AND (${filterKind}::text IS NULL OR "kind" = ${filterKind}::"UsageKind")
        AND (${filterModel}::text IS NULL OR "model" = ${filterModel})
        AND (${fromTs}::timestamptz IS NULL OR "createdAt" >= ${fromTs}::timestamptz)
        AND (${toTs}::timestamptz IS NULL OR "createdAt" <= ${toTs}::timestamptz)
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT ${trendLimit}
    `,
    // The model filter's own vocabulary, deliberately UNFILTERED: a list built
    // from the current view would offer exactly the one model already selected,
    // leaving no way back to any other. Bounded by the model vocabulary, which
    // is the same bound the per-model table already runs under.
    prisma.modelUsage.groupBy({ by: ['model'] }),
  ]);

  const totalCalls = totals._count._all;
  const totalCost = totals._sum.costUsd ?? 0;
  const totalIn = totals._sum.promptTokens ?? 0;
  const totalOut = totals._sum.completionTokens ?? 0;
  const totalTokens = totalIn + totalOut;
  const unpricedCalls = totalCalls - totals._count.costUsd;

  // What the whole bill is, so a filtered view can state its scope against it
  // and can never be read as the total. Only worth a second round trip when
  // there is actually a filter narrowing the first one.
  const overall = filtered
    ? await prisma.modelUsage.aggregate({ _sum: { costUsd: true }, _count: { _all: true } })
    : totals;
  const overallCalls = overall._count._all;
  const overallCost = overall._sum.costUsd ?? 0;

  // ─── Per agent, and per model: two rollups of one grouping ─────────────────
  // Carried in and out separately rather than pre-added. Output is priced
  // several times higher than input, so a single Tokens figure cannot tell an
  // agent burning money on long completions from one reading a large context —
  // the one ratio that explains a bill. Display-only: these have been separate
  // columns since AEH-286, and every total here was always an addition done in
  // this file. AEH-313.
  type Agg = {
    calls: number;
    unpriced: number;
    promptTokens: number;
    completionTokens: number;
    cost: number;
  };
  const blank = (): Agg => ({
    calls: 0,
    unpriced: 0,
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
  });
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
    a.promptTokens += g._sum.promptTokens ?? 0;
    a.completionTokens += g._sum.completionTokens ?? 0;
    a.cost += g._sum.costUsd ?? 0;
    return a;
  };
  const tokensOf = (v: Agg) => v.promptTokens + v.completionTokens;

  const byKind = new Map<UsageKind, Agg & { models: Set<string> }>();
  const byModel = new Map<string, Agg>();
  for (const g of byKindModel) {
    const k = byKind.get(g.kind) ?? { ...blank(), models: new Set<string>() };
    add(k, g);
    if (g.model) k.models.add(g.model);
    byKind.set(g.kind, k);

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

  const kindRows = sortRows(
    [...byKind.entries()].map(([kind, v]) => ({ kind, name: usageLabel(kind), ...v })),
    agentSort,
    (r, k) => (k === 'name' ? r.name : k === 'calls' ? r.calls : k === 'tokens' ? tokensOf(r) : r.cost),
  );

  const modelAll = sortRows(
    [...byModel.entries()].map(([name, v]) => ({ name, ...v })),
    modelSort,
    (r, k) => (k === 'name' ? r.name : k === 'calls' ? r.calls : k === 'tokens' ? tokensOf(r) : r.cost),
  );
  const modelRows = modelAll.slice(0, MAX_ROWS);

  const runAll = sortRows(
    [...byRun.entries()].map(([id, v]) => ({ id, ...v })),
    runSort,
    (r, k) => (k === 'name' ? r.id : k === 'calls' ? r.calls : k === 'tokens' ? tokensOf(r) : r.cost),
  );
  const runRows = runAll.slice(0, MAX_ROWS);

  const estimateAll = sortRows(
    [...byEstimate.entries()].map(([id, v]) => ({ id, ...v })),
    estimateSort,
    (r, k) =>
      k === 'calls' ? r.calls : k === 'tokens' ? tokensOf(r) : k === 'runs' ? r.runs.size : r.cost,
  );
  const estimateRows = estimateAll.slice(0, MAX_ROWS);

  // Titles only for the rows that will actually render, and for the chip. The
  // chip's estimate is fetched by the same query so a filter arrived at from an
  // estimate outside the cap still names itself rather than showing a raw id.
  //
  // Deliberately NOT filtered by `deletedAt`: the money was spent and the bill
  // was real, so deleting an estimate must not quietly shrink a historical
  // cost figure. This is the one place a deleted estimate still counts, and it
  // is marked rather than hidden so nobody hunts for a row they cannot open —
  // the chip included, which is why the flag is selected here and not at the
  // call sites.
  const titleIds = [...new Set([...estimateRows.map((r) => r.id), ...(estimateId ? [estimateId] : [])])];
  // @deleted-ok the spend happened and the bill was real; hiding it would
  // shrink a historical cost figure. AEH-375.
  const titles = new Map(
    (
      await prisma.estimate.findMany({
        where: { id: { in: titleIds } },
        select: { id: true, title: true, deletedAt: true },
      })
    ).map((e) => [e.id, e.deletedAt ? `${e.title} (deleted)` : e.title]),
  );

  // The window selection stays in the statement (most recent N days); this only
  // reorders what came back. Sorting the window in SQL would change WHICH days
  // are returned — "cost ascending" would fetch the cheapest days in history
  // rather than the cheapest of the window on screen.
  const trendRows = sortRows(trend, daySort, (r, k) =>
    k === 'day' ? r.day : k === 'calls' ? r.calls : k === 'tokens' ? r.tokens : k === 'unpriced' ? r.unpriced : r.cost,
  );
  // The chart always reads left to right in time, whatever the table above is
  // sorted by — a chronological axis that reorders itself is not a trend.
  const trendPoints = [...trend]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((d) => ({ day: d.day, cost: d.cost, tokens: d.tokens }));

  const windowLabel = from || to ? `${from || 'the beginning'} to ${to || 'today'}` : `last ${TREND_DAYS} days`;

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

  const modelOptions = modelVocab
    .map((m) => m.model)
    .filter((m): m is string => !!m)
    .sort()
    .map((m) => ({ value: m, label: m }));

  return (
    <div data-testid="admin-usage">
      <Heading level={1}>Model usage</Heading>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Every model call, costed once, in one place. Spend is per estimate, per
        agent, per run and per model — the feedback loop for prompt edits and
        model swaps.
      </p>

      <ControlRow>
        <FilterFields
          path={PATH}
          params={params}
          selects={[
            {
              param: 'kind',
              label: 'Agent',
              value: kind,
              allLabel: 'All agents',
              options: USAGE_PROFILES.map((p) => ({ value: p.kind, label: p.label })),
            },
            {
              param: 'model',
              label: 'Model',
              value: model,
              allLabel: 'All models',
              options: modelOptions,
            },
          ]}
          dateRange={{ fromParam: 'from', toParam: 'to', from, to }}
        />

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {/* The estimate filter keeps arriving by link from an estimate's own
              spend panel, which is the only place that knows which estimate you
              mean. What changes is that it now says so: a chip that names the
              estimate and drops only itself, rather than a 12.5px "Clear filter"
              that named nothing and dropped everything. */}
          {estimateId && (
            <FilterChip
              label="Estimate"
              value={titles.get(estimateId) ?? estimateId}
              clearHref={hrefWith(PATH, params, { estimateId: null })}
            />
          )}
          <ResultScope
            filtered={filtered}
            calls={totalCalls}
            totalCalls={overallCalls}
            cost={totalCost}
            totalCost={overallCost}
          />
        </div>
      </ControlRow>

      {filtered && totalCalls === 0 ? (
        <div
          className="mt-6 rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center"
          data-testid="usage-empty"
        >
          <div className="font-serif text-[20px] text-ink">No calls match this filter</div>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-ink-3">
            Widen the date range, or clear a filter above, to see spend again.
          </p>
        </div>
      ) : (
        <>
          <Section title={`Trend (${windowLabel})`}>
            <p className="text-[12.5px] text-ink-3">
              Cost and tokens read together say what a spike was. Cost climbing
              while tokens stay flat is a model swap; both climbing together is a
              prompt that got longer.
            </p>
            <SpendTrend points={trendPoints} />
          </Section>

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
            <Stat
              label="Total tokens"
              value={totalTokens.toLocaleString()}
              hint={
                totalTokens > 0
                  ? `${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`
                  : undefined
              }
            />
            <Stat label="Total calls" value={totalCalls.toLocaleString()} />
            <Stat
              label="Of that, steering"
              value={
                (editTotals._sum.costUsd ?? 0) > 0
                  ? `$${(editTotals._sum.costUsd ?? 0).toFixed(4)}`
                  : '—'
              }
              hint={`${editTotals._count._all.toLocaleString()} calls inside a steered edit`}
            />
          </div>

          <Section title="Per agent">
            <Table
              testid="usage-by-agent"
              heads={[
                <SortHead key="a" label="Agent" sortKey="name" param="sortAgent" sort={agentSort} path={PATH} params={params} />,
                <SortHead key="c" label="Calls" sortKey="calls" param="sortAgent" sort={agentSort} path={PATH} params={params} />,
                <SortHead key="t" label="Tokens" sortKey="tokens" param="sortAgent" sort={agentSort} path={PATH} params={params} />,
                <SortHead key="m" label="Cost" sortKey="cost" param="sortAgent" sort={agentSort} path={PATH} params={params} />,
                <th key="mods" className="eyebrow px-4 py-2.5 font-bold">Models</th>,
              ]}
              body={kindRows.map((v) => [
                <span key="k">{v.name}</span>,
                <span key="c" className="num">{v.calls.toLocaleString()}</span>,
                <Tokens key="t" prompt={v.promptTokens} completion={v.completionTokens} />,
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
              heads={[
                <th key="e" className="eyebrow px-4 py-2.5 font-bold">Estimate</th>,
                <SortHead key="c" label="Calls" sortKey="calls" param="sortEstimate" sort={estimateSort} path={PATH} params={params} />,
                <SortHead key="t" label="Tokens" sortKey="tokens" param="sortEstimate" sort={estimateSort} path={PATH} params={params} />,
                <SortHead key="m" label="Cost" sortKey="cost" param="sortEstimate" sort={estimateSort} path={PATH} params={params} />,
                <SortHead key="r" label="Runs" sortKey="runs" param="sortEstimate" sort={estimateSort} path={PATH} params={params} />,
              ]}
              body={estimateRows.map((v) => [
                <Link
                  key="e"
                  href={hrefWith(PATH, params, { estimateId: v.id })}
                  className="font-semibold text-ink hover:text-green hover:underline"
                >
                  {titles.get(v.id) ?? v.id}
                </Link>,
                <span key="c" className="num">{v.calls.toLocaleString()}</span>,
                <Tokens key="t" prompt={v.promptTokens} completion={v.completionTokens} />,
                <span key="m" className="num">
                  {money(v.cost)}
                  {unpricedNote(v)}
                </span>,
                <span key="r" className="num">{v.runs.size}</span>,
              ])}
              cap={<RowCap shown={MAX_ROWS} total={estimateAll.length} />}
            />
          </Section>

          <Section title="Per model">
            <Table
              testid="usage-by-model"
              heads={[
                <SortHead key="m" label="Model" sortKey="name" param="sortModel" sort={modelSort} path={PATH} params={params} />,
                <SortHead key="c" label="Calls" sortKey="calls" param="sortModel" sort={modelSort} path={PATH} params={params} />,
                <SortHead key="t" label="Tokens" sortKey="tokens" param="sortModel" sort={modelSort} path={PATH} params={params} />,
                <SortHead key="x" label="Cost" sortKey="cost" param="sortModel" sort={modelSort} path={PATH} params={params} />,
              ]}
              body={modelRows.map((v) => [
                <span key="m" className="num">{v.name}</span>,
                <span key="c" className="num">{v.calls.toLocaleString()}</span>,
                <Tokens key="t" prompt={v.promptTokens} completion={v.completionTokens} />,
                <span key="x" className="num">
                  {money(v.cost)}
                  {unpricedNote(v)}
                </span>,
              ])}
              cap={<RowCap shown={MAX_ROWS} total={modelAll.length} />}
            />
          </Section>

          <Section title={`Per day (${windowLabel})`}>
            <p className="mb-2.5 text-[12.5px] text-ink-3">
              The exact daily figures the chart above draws, plus how many calls
              each day reported no cost at all.
            </p>
            <Table
              testid="usage-by-day"
              heads={[
                <SortHead key="d" label="Day" sortKey="day" param="sortDay" sort={daySort} path={PATH} params={params} />,
                <SortHead key="c" label="Calls" sortKey="calls" param="sortDay" sort={daySort} path={PATH} params={params} />,
                <SortHead key="t" label="Tokens" sortKey="tokens" param="sortDay" sort={daySort} path={PATH} params={params} />,
                <SortHead key="x" label="Cost" sortKey="cost" param="sortDay" sort={daySort} path={PATH} params={params} />,
                <SortHead key="u" label="Unpriced" sortKey="unpriced" param="sortDay" sort={daySort} path={PATH} params={params} />,
              ]}
              body={trendRows.map((d) => [
                <span key="d" className="num">{d.day}</span>,
                <span key="c" className="num">{d.calls.toLocaleString()}</span>,
                <span key="t" className="num">{Math.round(d.tokens).toLocaleString()}</span>,
                <span key="x" className="num">{money(d.cost)}</span>,
                <span key="u" className="num text-ink-3">{d.unpriced > 0 ? d.unpriced : '—'}</span>,
              ])}
            />
          </Section>

          {/* Always present, not only inside a filtered view. A section that
              appears when you filter and vanishes when you clear is an
              unlabelled hint that the page changed shape underneath you, and
              the grouping it reads was already being fetched either way. */}
          <Section title="Per run">
            <Table
              testid="usage-by-run"
              heads={[
                <SortHead key="r" label="Run" sortKey="name" param="sortRun" sort={runSort} path={PATH} params={params} />,
                <SortHead key="c" label="Calls" sortKey="calls" param="sortRun" sort={runSort} path={PATH} params={params} />,
                <SortHead key="t" label="Tokens" sortKey="tokens" param="sortRun" sort={runSort} path={PATH} params={params} />,
                <SortHead key="x" label="Cost" sortKey="cost" param="sortRun" sort={runSort} path={PATH} params={params} />,
              ]}
              body={runRows.map((v) => [
                <span key="r" className="num font-mono text-[11px]">{v.id}</span>,
                <span key="c" className="num">{v.calls.toLocaleString()}</span>,
                <Tokens key="t" prompt={v.promptTokens} completion={v.completionTokens} />,
                <span key="x" className="num">
                  {money(v.cost)}
                  {unpricedNote(v)}
                </span>,
              ])}
              cap={<RowCap shown={MAX_ROWS} total={runAll.length} />}
            />
          </Section>
        </>
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

/**
 * A token count, split.
 *
 * The total stays the number you read; the split sits under it as secondary
 * text. Cost deliberately does NOT get the same treatment — OpenRouter reports
 * one figure per call and an in/out cost split could only be derived from a
 * price table that goes stale underneath old rows and would not reconcile with
 * the billed total wherever caching or a surcharge is in play. AEH-313.
 */
function Tokens({ prompt, completion }: { prompt: number; completion: number }) {
  const total = prompt + completion;
  return (
    <span className="num">
      {total.toLocaleString()}
      {total > 0 && (
        <span className="block text-[11px] text-ink-4">
          {prompt.toLocaleString()} in / {completion.toLocaleString()} out
        </span>
      )}
    </span>
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
  cap,
}: {
  testid: string;
  heads: React.ReactNode[];
  body: React.ReactNode[][];
  cap?: React.ReactNode;
}) {
  return (
    <>
      <Card className="mt-2.5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]" data-testid={testid}>
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left">{heads}</tr>
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
      {cap}
    </>
  );
}
