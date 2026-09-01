import Link from 'next/link';
import { prisma } from '@repo/db';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

/**
 * Every Oracle conversation, across every estimate.
 *
 * Two jobs. The obvious one is oversight: users are told their conversations
 * are saved and readable by an admin, and this is where that is true.
 *
 * The more useful one is a feedback loop. What people ask Oracle is a direct
 * record of what the pipeline failed to make clear on its own — a run of
 * questions about where a card's hours came from says the menu card is not
 * explaining itself, and that is a product signal nothing else in this app
 * surfaces.
 *
 * Read-only throughout. There is no compose box and no action behind one: an
 * admin may read an investigation and may never write into it.
 */
export default async function AdminOraclePage({
  searchParams,
}: {
  searchParams: Promise<{ estimateId?: string; userId?: string }>;
}) {
  const { estimateId, userId } = await searchParams;

  const threads = await prisma.oracleThread.findMany({
    where: { ...(estimateId ? { estimateId } : {}), ...(userId ? { userId } : {}) },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      estimate: { select: { id: true, title: true } },
      user: { select: { id: true, email: true, name: true } },
      _count: { select: { messages: true } },
    },
  });

  // Thread spend comes from ModelUsage, grouped in the database, rather than
  // from joining every assistant message and adding it up here. ModelUsage is
  // the one home for AI spend — reading Oracle's cost through the message rows
  // would leave this page on a second, parallel path to the same numbers, which
  // is exactly what AEH-286 collapsed. Bounded by threads x models on screen.
  const spend = await prisma.modelUsage.groupBy({
    by: ['threadId', 'model'],
    where: { threadId: { in: threads.map((t) => t.id) } },
    _sum: { promptTokens: true, completionTokens: true, costUsd: true },
    // `_all` counts turns, `costUsd` counts the priced ones. A turn the provider
    // reported nothing for is not a turn that cost nothing, and must not render
    // as a zero somebody then adds up — so the cost cell shows "—" unless at
    // least one turn in the thread actually came back priced.
    _count: { _all: true, costUsd: true },
  });

  type ThreadSpend = { tokens: number; cost: number; priced: number; models: Set<string> };
  const spendByThread = new Map<string, ThreadSpend>();
  for (const g of spend) {
    if (!g.threadId) continue;
    const s =
      spendByThread.get(g.threadId) ?? { tokens: 0, cost: 0, priced: 0, models: new Set<string>() };
    s.tokens += (g._sum.promptTokens ?? 0) + (g._sum.completionTokens ?? 0);
    s.cost += g._sum.costUsd ?? 0;
    s.priced += g._count.costUsd;
    if (g.model) s.models.add(g.model);
    spendByThread.set(g.threadId, s);
  }

  const filtered = !!estimateId || !!userId;

  return (
    <div data-testid="admin-oracle">
      <Heading level={1}>Oracle</Heading>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Every conversation an estimator has had with Oracle. Read-only — a thread is one
        person&apos;s record of working something out, and nobody can post into someone
        else&apos;s. What gets asked here is also the clearest signal of what the pipeline is
        failing to explain on its own.
      </p>

      {filtered && (
        <p className="mt-2.5 text-[12.5px]">
          <Link href="/admin/oracle" className="text-green hover:underline">
            ← Clear filter
          </Link>
        </p>
      )}

      {threads.length === 0 ? (
        <div
          className="mt-6 rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center"
          data-testid="oracle-threads-empty"
        >
          <div className="font-serif text-[20px] text-ink">No conversations yet</div>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-ink-3">
            {filtered
              ? 'Nothing matches this filter.'
              : 'Oracle appears on the estimate screen, bottom right. Threads show up here once somebody asks it something.'}
          </p>
        </div>
      ) : (
        <Card className="mt-5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="oracle-threads-table">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Thread</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Estimate</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Asked by</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Turns</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Tokens</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Cost</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Model</th>
                </tr>
              </thead>
              <tbody>
                {threads.map((t) => {
                  // A thread with no usage rows at all is absent from the map,
                  // which renders as "—" throughout rather than as zero.
                  const s = spendByThread.get(t.id);
                  const tokens = s?.tokens ?? 0;
                  const cost = s?.cost ?? 0;
                  const priced = s?.priced ?? 0;
                  const models = [...(s?.models ?? [])].sort();

                  return (
                    <tr
                      key={t.id}
                      className="border-b border-line-soft last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/oracle/${t.id}`}
                          className="font-semibold text-ink hover:text-green hover:underline"
                          data-testid={`oracle-thread-link-${t.id}`}
                        >
                          {t.title}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/oracle?estimateId=${t.estimate.id}`}
                          className="text-ink-2 hover:text-green hover:underline"
                        >
                          {t.estimate.title}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/oracle?userId=${t.user.id}`}
                          className="text-ink-2 hover:text-green hover:underline"
                        >
                          {t.user.name ?? t.user.email}
                        </Link>
                      </td>
                      <td className="num px-4 py-3 text-right text-ink-2">{t._count.messages}</td>
                      <td className="num px-4 py-3 text-right text-ink-2">
                        {tokens > 0 ? tokens.toLocaleString() : '—'}
                      </td>
                      <td className="num px-4 py-3 text-right text-ink-2">
                        {priced > 0 ? `$${cost.toFixed(4)}` : '—'}
                      </td>
                      <td className="px-4 py-3">
                        {models.length === 0 ? (
                          <span className="text-ink-4">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {models.map((m) => (
                              <Pill key={m} dot={false} className="num text-[11px]">
                                {m}
                              </Pill>
                            ))}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
