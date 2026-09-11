import Link from 'next/link';
import { prisma } from '@repo/db';
import type { Prisma } from '@repo/db';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { FilterFields } from '@/components/admin/filter-fields';
import {
  ControlRow,
  ResultScope,
  RowCap,
  SortHead,
  parseSort,
  type Sort,
} from '@/components/admin/report-controls';

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

/** The list is cut; the active sort is what decides which rows survive. */
const TAKE = 200;
const PATH = '/admin/oracle';

const THREAD_SORTS = ['thread', 'estimate', 'user', 'turns', 'tokens', 'cost', 'updated'] as const;
type ThreadSort = (typeof THREAD_SORTS)[number];

/** The two keys that do not live on OracleThread at all. See the note below. */
const SPEND_SORTS = new Set<ThreadSort>(['tokens', 'cost']);

type RankedThread = { id: string };

export default async function AdminOraclePage({
  searchParams,
}: {
  searchParams: Promise<{ estimateId?: string; userId?: string; sort?: string }>;
}) {
  const sp = await searchParams;
  const estimateId = sp.estimateId || '';
  const userId = sp.userId || '';
  const filtered = !!(estimateId || userId);

  const sort = parseSort<ThreadSort>(sp.sort, THREAD_SORTS, { key: 'updated', dir: 'desc' });
  const params: Record<string, string | undefined> = {
    estimateId: estimateId || undefined,
    userId: userId || undefined,
    sort: sp.sort,
  };

  const where: Prisma.OracleThreadWhereInput = {
    ...(estimateId ? { estimateId } : {}),
    ...(userId ? { userId } : {}),
  };

  /**
   * Sorting by spend has to invert the query, and that is not a flourish.
   *
   * This page shows the top `TAKE` threads and the cap is applied IN the query,
   * so whatever orders the query decides which threads exist on screen at all.
   * Tokens and cost, though, do not live on OracleThread — they are sums over
   * ModelUsage, fetched afterwards for the threads already chosen. Ordering
   * those in JS would rank the 200 most recently updated among themselves and
   * call the winner the most expensive conversation, which for any install with
   * more than 200 threads is simply false.
   *
   * So when the sort is a spend column, ModelUsage is grouped FIRST, ranked, cut
   * to `TAKE`, and the threads are fetched from those ids.
   *
   * The ordering is fully parameterised rather than assembled: the key picks
   * between two aggregate expressions and the direction is a ±1 multiplier, so
   * there is no interpolated SQL and, crucially, no `Prisma.sql` fragment. A
   * fragment must survive an `instanceof Sql` check inside the client, and the
   * copy of the client a page bundles is not always the copy the fragment was
   * built from — the same trap /admin/usage carries a long comment about.
   */
  const filterEstimate = estimateId || null;
  const filterUser = userId || null;
  const ascending = sort.dir === 'asc';
  const byTokens = sort.key === 'tokens';

  const ranked = SPEND_SORTS.has(sort.key)
    ? await prisma.$queryRaw<RankedThread[]>`
        SELECT u."threadId" AS id
        FROM "ModelUsage" u
        JOIN "OracleThread" t ON t."id" = u."threadId"
        WHERE (${filterEstimate}::text IS NULL OR t."estimateId" = ${filterEstimate})
          AND (${filterUser}::text IS NULL OR t."userId" = ${filterUser})
        GROUP BY 1
        ORDER BY (CASE WHEN ${ascending}::boolean THEN 1 ELSE -1 END) *
                 (CASE WHEN ${byTokens}::boolean
                       THEN (COALESCE(SUM(u."promptTokens"), 0) + COALESCE(SUM(u."completionTokens"), 0))::float8
                       ELSE COALESCE(SUM(u."costUsd"), 0)::float8 END),
                 MAX(t."updatedAt") DESC
        LIMIT ${TAKE}
      `
    : null;

  const select = {
    id: true,
    title: true,
    updatedAt: true,
    estimate: { select: { id: true, title: true } },
    user: { select: { id: true, email: true, name: true } },
    _count: { select: { messages: true } },
  } as const;

  const [found, totalThreads, scopedThreads, scopedSpend, overallSpend, estimateVocab, userVocab] =
    await Promise.all([
      ranked
        ? prisma.oracleThread.findMany({ where: { id: { in: ranked.map((r) => r.id) } }, select })
        : prisma.oracleThread.findMany({ where, orderBy: orderFor(sort), take: TAKE, select }),
      prisma.oracleThread.count(),
      prisma.oracleThread.count({ where }),
      // One row each. Oracle spend is read from ModelUsage, never by joining the
      // message rows and adding them up — ModelUsage is the one home for AI
      // spend, and a second path to the same number is exactly what AEH-286
      // collapsed.
      // `threadId: { not: null }` is stated rather than left to the relation
      // filter. An empty `is: {}` is the unfiltered case, and whether that
      // reads as "the relation exists" or as "no constraint at all" decides
      // whether this total is Oracle's spend or the entire bill — far too load
      // -bearing a difference to leave to an implicit.
      prisma.modelUsage.aggregate({
        where: { threadId: { not: null }, ...(filtered ? { thread: { is: where } } : {}) },
        _sum: { costUsd: true },
      }),
      prisma.modelUsage.aggregate({
        where: { threadId: { not: null } },
        _sum: { costUsd: true },
      }),
      // The filter vocabularies, deliberately UNFILTERED — a list built from the
      // current view would offer only the value already selected, leaving no way
      // back to any other. Bounded by distinct estimates and users that have a
      // thread, which is far smaller than either table.
      prisma.oracleThread.groupBy({ by: ['estimateId'] }),
      prisma.oracleThread.groupBy({ by: ['userId'] }),
    ]);

  // `findMany` with an `in` returns its own order, so the ranking computed in
  // the database has to be reapplied rather than assumed.
  const order = new Map((ranked ?? []).map((r, i) => [r.id, i]));
  const threads = ranked
    ? [...found].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    : found;

  // Thread spend comes from ModelUsage, grouped in the database. Bounded by
  // threads x models on screen.
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

  // In and out kept apart, not pre-added: output is priced several times higher
  // than input, so one Tokens figure hides the ratio that explains the bill.
  // AEH-313.
  type ThreadSpend = {
    promptTokens: number;
    completionTokens: number;
    cost: number;
    priced: number;
    models: Set<string>;
  };
  const spendByThread = new Map<string, ThreadSpend>();
  for (const g of spend) {
    if (!g.threadId) continue;
    const s = spendByThread.get(g.threadId) ?? {
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      priced: 0,
      models: new Set<string>(),
    };
    s.promptTokens += g._sum.promptTokens ?? 0;
    s.completionTokens += g._sum.completionTokens ?? 0;
    s.cost += g._sum.costUsd ?? 0;
    s.priced += g._count.costUsd;
    if (g.model) s.models.add(g.model);
    spendByThread.set(g.threadId, s);
  }

  const vocabIds = {
    estimates: estimateVocab.map((e) => e.estimateId).filter((v): v is string => !!v),
    users: userVocab.map((u) => u.userId).filter((v): v is string => !!v),
  };
  const [estimateNames, userNames] = await Promise.all([
    prisma.estimate.findMany({
      where: { id: { in: vocabIds.estimates } },
      select: { id: true, title: true },
      orderBy: { title: 'asc' },
    }),
    prisma.user.findMany({
      where: { id: { in: vocabIds.users } },
      select: { id: true, name: true, email: true },
      orderBy: { email: 'asc' },
    }),
  ]);

  const head = (label: string, key: ThreadSort, align?: 'right') => (
    <SortHead
      key={key}
      label={label}
      sortKey={key}
      param="sort"
      sort={sort}
      path={PATH}
      params={params}
      align={align}
    />
  );

  return (
    <div data-testid="admin-oracle">
      <Heading level={1}>Oracle</Heading>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Every conversation an estimator has had with Oracle. Read-only — a thread is one
        person&apos;s record of working something out, and nobody can post into someone
        else&apos;s. What gets asked here is also the clearest signal of what the pipeline is
        failing to explain on its own.
      </p>

      <ControlRow>
        <FilterFields
          path={PATH}
          params={params}
          selects={[
            {
              param: 'estimateId',
              label: 'Estimate',
              value: estimateId,
              allLabel: 'All estimates',
              options: estimateNames.map((e) => ({ value: e.id, label: e.title })),
            },
            {
              param: 'userId',
              label: 'Asked by',
              value: userId,
              allLabel: 'Everyone',
              options: userNames.map((u) => ({ value: u.id, label: u.name ?? u.email })),
            },
          ]}
        />
        <div className="mt-2.5">
          <ResultScope
            filtered={filtered}
            calls={scopedThreads}
            totalCalls={totalThreads}
            cost={scopedSpend._sum.costUsd ?? 0}
            totalCost={overallSpend._sum.costUsd ?? 0}
            noun="conversations"
          />
        </div>
      </ControlRow>

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
        <>
          <Card className="mt-5 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]" data-testid="oracle-threads-table">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-left">
                    {head('Thread', 'thread')}
                    {head('Estimate', 'estimate')}
                    {head('Asked by', 'user')}
                    {head('Turns', 'turns', 'right')}
                    {head('Tokens', 'tokens', 'right')}
                    {head('Cost', 'cost', 'right')}
                    <th className="eyebrow px-4 py-2.5 font-bold">Model</th>
                    {head('Updated', 'updated', 'right')}
                  </tr>
                </thead>
                <tbody>
                  {threads.map((t) => {
                    // A thread with no usage rows at all is absent from the map,
                    // which renders as "—" throughout rather than as zero.
                    const s = spendByThread.get(t.id);
                    const promptTokens = s?.promptTokens ?? 0;
                    const completionTokens = s?.completionTokens ?? 0;
                    const tokens = promptTokens + completionTokens;
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
                        {/* Both of these used to FILTER this page while looking
                            exactly like the thread link beside them, which
                            navigates — three identical-looking links per row,
                            two of which did something else entirely. Filtering
                            now lives in the control row above, so every link in
                            a row goes where it appears to go. */}
                        <td className="px-4 py-3">
                          <Link
                            href={`/estimates/${t.estimate.id}`}
                            className="text-ink-2 hover:text-green hover:underline"
                          >
                            {t.estimate.title}
                          </Link>
                        </td>
                        <td className="px-4 py-3">
                          <Link
                            href="/admin/users"
                            className="text-ink-2 hover:text-green hover:underline"
                          >
                            {t.user.name ?? t.user.email}
                          </Link>
                        </td>
                        <td className="num px-4 py-3 text-right text-ink-2">{t._count.messages}</td>
                        <td className="num px-4 py-3 text-right text-ink-2">
                          {tokens > 0 ? (
                            <>
                              {tokens.toLocaleString()}
                              <span className="block text-[11px] text-ink-4">
                                {promptTokens.toLocaleString()} in /{' '}
                                {completionTokens.toLocaleString()} out
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
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
                        <td className="num px-4 py-3 text-right text-[12px] text-ink-3">
                          {t.updatedAt.toISOString().slice(0, 10)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <RowCap shown={TAKE} total={scopedThreads} />
          {/* A spend sort ranks ModelUsage, so a conversation with no usage row
              has nothing to rank and never enters the list. Saying so beats a
              reader counting rows and concluding the others were deleted. */}
          {ranked && threads.length < TAKE && scopedThreads > threads.length && (
            <p className="mt-1.5 text-[11.5px] text-ink-4" data-testid="oracle-unranked">
              <span className="num">{(scopedThreads - threads.length).toLocaleString()}</span>{' '}
              {scopedThreads - threads.length === 1 ? 'conversation has' : 'conversations have'} no
              recorded spend, so this sort cannot rank{' '}
              {scopedThreads - threads.length === 1 ? 'it' : 'them'}.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** The sorts that CAN be an ORDER BY, because the column is on the thread. */
function orderFor(sort: Sort<ThreadSort>): Prisma.OracleThreadOrderByWithRelationInput {
  switch (sort.key) {
    case 'thread':
      return { title: sort.dir };
    case 'estimate':
      return { estimate: { title: sort.dir } };
    case 'user':
      return { user: { name: sort.dir } };
    case 'turns':
      return { messages: { _count: sort.dir } };
    default:
      return { updatedAt: sort.dir };
  }
}
