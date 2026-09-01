import Link from 'next/link';
import { prisma, usageLabel } from '@repo/db';
import type { UsageKind } from '@repo/db';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

/**
 * The single report every model call feeds. Cost is recorded once on ModelUsage,
 * so the run crew, Oracle, ingestion and embedding are all answerable here —
 * per agent, per estimate, per run and per model.
 *
 * Read-only, like every other admin surface. There is no write action and no
 * reason to accept one.
 */
export default async function AdminUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ estimateId?: string }>;
}) {
  const { estimateId } = await searchParams;

  const rows = await prisma.modelUsage.findMany({
    where: estimateId ? { estimateId } : undefined,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      estimateId: true,
      runId: true,
      kind: true,
      model: true,
      promptTokens: true,
      completionTokens: true,
      costUsd: true,
      createdAt: true,
      estimate: { select: { id: true, title: true } },
    },
  });

  const sum = (acc: number, v: number | null) => acc + (v ?? 0);
  const byKind = new Map<UsageKind, { calls: number; tokens: number; cost: number; models: Set<string> }>();
  const byEstimate = new Map<string, { id: string; title: string; calls: number; tokens: number; cost: number; runs: Set<string | null> }>();
  const byModel = new Map<string, { calls: number; tokens: number; cost: number }>();
  const byRun = new Map<string, { calls: number; tokens: number; cost: number }>();

  let totalCalls = 0;
  let totalTokens = 0;
  let totalCost = 0;

  for (const row of rows) {
    totalCalls += 1;
    totalTokens += sum(0, row.promptTokens) + sum(0, row.completionTokens);
    totalCost += sum(0, row.costUsd);

    const kind = byKind.get(row.kind) ?? { calls: 0, tokens: 0, cost: 0, models: new Set<string>() };
    kind.calls += 1;
    kind.tokens += sum(0, row.promptTokens) + sum(0, row.completionTokens);
    kind.cost += sum(0, row.costUsd);
    if (row.model) kind.models.add(row.model);
    byKind.set(row.kind, kind);

    if (row.estimateId) {
      const est = byEstimate.get(row.estimateId) ?? {
        id: row.estimateId,
        title: row.estimate?.title ?? row.estimateId,
        calls: 0,
        tokens: 0,
        cost: 0,
        runs: new Set<string | null>(),
      };
      est.calls += 1;
      est.tokens += sum(0, row.promptTokens) + sum(0, row.completionTokens);
      est.cost += sum(0, row.costUsd);
      if (row.runId) est.runs.add(row.runId);
      byEstimate.set(row.estimateId, est);
    }

    if (row.model) {
      const m = byModel.get(row.model) ?? { calls: 0, tokens: 0, cost: 0 };
      m.calls += 1;
      m.tokens += sum(0, row.promptTokens) + sum(0, row.completionTokens);
      m.cost += sum(0, row.costUsd);
      byModel.set(row.model, m);
    }

    if (row.runId) {
      const run = byRun.get(row.runId) ?? { calls: 0, tokens: 0, cost: 0 };
      run.calls += 1;
      run.tokens += sum(0, row.promptTokens) + sum(0, row.completionTokens);
      run.cost += sum(0, row.costUsd);
      byRun.set(row.runId, run);
    }
  }

  const money = (v: number) => (v > 0 ? `$${v.toFixed(4)}` : '—');

  const kindRows = [...byKind.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const estimateRows = [...byEstimate.values()].sort((a, b) => b.cost - a.cost);
  const modelRows = [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const runRows = [...byRun.entries()].sort((a, b) => b[1].cost - a[1].cost);

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
        <Stat label="Total spend" value={money(totalCost)} />
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
            <span key="m" className="num">{money(v.cost)}</span>,
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
          body={estimateRows.map((e) => [
            <Link key="e" href={`/admin/usage?estimateId=${e.id}`} className="font-semibold text-ink hover:text-green hover:underline">
              {e.title}
            </Link>,
            <span key="c" className="num">{e.calls.toLocaleString()}</span>,
            <span key="t" className="num">{e.tokens.toLocaleString()}</span>,
            <span key="m" className="num">{money(e.cost)}</span>,
            <span key="r" className="num">{e.runs.size}</span>,
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
            <span key="x" className="num">{money(v.cost)}</span>,
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
              <span key="x" className="num">{money(v.cost)}</span>,
            ])}
          />
        </Section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className="eyebrow text-ink-3">{label}</div>
      <div className="num mt-1 text-[22px] font-medium text-ink">{value}</div>
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
