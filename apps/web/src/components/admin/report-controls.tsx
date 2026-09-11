import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * The filter-and-sort pattern both admin reports wear, built once.
 *
 * /admin/usage and /admin/oracle had the same two defects: a filter you could
 * only reach by clicking a table cell styled like a link that navigates, and no
 * sorting at all. The controls that fix it are shared so the two pages cannot
 * drift into two different answers to the same question. AEH-313.
 *
 * Everything here is server-rendered. Sorting is a link rather than a click
 * handler — a sort is a URL, so it is shareable, bookmarkable and survives a
 * reload, and it costs the page no client JavaScript. Only the filter row
 * itself is a client component, because the ticket asks filtering to apply on
 * change rather than on submit.
 */

export type SortDir = 'asc' | 'desc';
export type Sort<K extends string> = { key: K; dir: SortDir };

/**
 * Read `key.dir` out of a URL parameter, falling back whenever it is absent or
 * names something this table does not offer.
 *
 * Whitelisted rather than trusted. The key reaches a comparator and, on Oracle,
 * an ORDER BY built by hand — so an unrecognised value has to become the
 * default. It must never be an error page and must never be passed through.
 */
export function parseSort<K extends string>(
  raw: string | undefined,
  allowed: readonly K[],
  fallback: Sort<K>,
): Sort<K> {
  const [key, dir] = (raw ?? '').split('.');
  if (!allowed.includes(key as K)) return fallback;
  return { key: key as K, dir: dir === 'asc' ? 'asc' : 'desc' };
}

/**
 * The current URL with some parameters replaced. `null` drops one.
 *
 * Every control on these pages composes rather than replaces: changing a sort
 * keeps the filters, and clearing one filter keeps the others and keeps all
 * five sorts. That is the whole reason the old filtered view was unreadable —
 * you could only drop everything at once.
 */
export function hrefWith(
  path: string,
  params: Record<string, string | undefined>,
  overrides: Record<string, string | null> = {},
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...overrides })) {
    if (v !== null && v !== undefined && v !== '') next.set(k, v);
  }
  const qs = next.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * A sortable column heading.
 *
 * Clicking a new column starts it descending, because every quantity on these
 * reports is interesting from the top — the expensive agent, the busiest day.
 * Clicking the active column flips it.
 */
export function SortHead<K extends string>({
  label,
  sortKey,
  param,
  sort,
  path,
  params,
  align = 'left',
}: {
  label: string;
  sortKey: K;
  /** Which URL parameter this table's sort lives in. Each table owns its own. */
  param: string;
  sort: Sort<K>;
  path: string;
  params: Record<string, string | undefined>;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  const nextDir: SortDir = active && sort.dir === 'desc' ? 'asc' : 'desc';

  return (
    <th
      // Announced as the sort state rather than only drawn as a caret. The
      // caret below is aria-hidden precisely because this attribute says it.
      aria-sort={active ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}
      className={cn('eyebrow px-4 py-2.5 font-bold', align === 'right' && 'text-right')}
    >
      <Link
        href={hrefWith(path, params, { [param]: `${sortKey}.${nextDir}` })}
        scroll={false}
        className={cn(
          'inline-flex items-center gap-1 hover:text-ink',
          active ? 'text-ink' : 'text-ink-3',
        )}
      >
        {label}
        <span aria-hidden className={cn('text-[9px]', !active && 'opacity-0')}>
          {sort.dir === 'desc' ? '▼' : '▲'}
        </span>
      </Link>
    </th>
  );
}

/**
 * What the numbers on screen actually cover.
 *
 * Both dimensions the report counts, always against the unfiltered total, so a
 * filtered view can never be mistaken for the whole bill — which is exactly
 * what a 12.5px "Clear filter" naming nothing used to allow.
 */
export function ResultScope({
  filtered,
  calls,
  totalCalls,
  cost,
  totalCost,
  noun = 'calls',
}: {
  filtered: boolean;
  calls: number;
  totalCalls: number;
  cost: number;
  totalCost: number;
  noun?: string;
}) {
  const money = (v: number) => `$${v.toFixed(4)}`;
  return (
    <p className="text-[12.5px] text-ink-3" data-testid="report-scope">
      {filtered ? (
        <>
          <span className="num text-ink">{calls.toLocaleString()}</span> of{' '}
          <span className="num">{totalCalls.toLocaleString()}</span> {noun} ·{' '}
          <span className="num text-ink">{money(cost)}</span> of{' '}
          <span className="num">{money(totalCost)}</span>
        </>
      ) : (
        <>
          All <span className="num text-ink">{totalCalls.toLocaleString()}</span> {noun} ·{' '}
          <span className="num text-ink">{money(totalCost)}</span>
        </>
      )}
    </p>
  );
}

/**
 * One active filter, named and individually removable.
 *
 * Naming it is the point. The affordance this replaces said only "Clear
 * filter": it did not say what you were filtered to, and it dropped every
 * dimension at once.
 */
export function FilterChip({
  label,
  value,
  clearHref,
}: {
  label: string;
  value: string;
  clearHref: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-green-line bg-green-tint py-1 pr-1 pl-2.5 text-[12px] text-green-deep">
      <span className="text-ink-3">{label}</span>
      <span className="max-w-[220px] truncate font-semibold">{value}</span>
      <Link
        href={clearHref}
        scroll={false}
        aria-label={`Remove the ${label.toLowerCase()} filter`}
        className="rounded-full px-1.5 leading-none text-green hover:bg-green-line hover:text-green-deep"
      >
        ×
      </Link>
    </span>
  );
}

/**
 * The band the filters live in. A plain landmark, so both reports place their
 * controls, chips and scope line identically.
 */
export function ControlRow({ children }: { children: React.ReactNode }) {
  return (
    <section
      aria-label="Filters"
      data-testid="report-controls"
      className="mt-4 rounded-[10px] border border-line bg-surface-2 px-4 py-3"
    >
      {children}
    </section>
  );
}

/**
 * Said out loud only when a table is actually cut short.
 *
 * The cap was silent before, which made "the fifty most expensive" and "all of
 * them" look identical — and a sort control makes that worse, because a reader
 * would reasonably expect a re-sort to reach rows the cap never held.
 */
export function RowCap({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="mt-1.5 text-[11.5px] text-ink-4" data-testid="row-cap">
      Showing the top <span className="num">{shown}</span> of{' '}
      <span className="num">{total.toLocaleString()}</span>, by the sort above.
    </p>
  );
}
