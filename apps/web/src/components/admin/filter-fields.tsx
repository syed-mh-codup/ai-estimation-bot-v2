'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Select } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * The controls in the filter row. The only client component either report
 * needs, and it exists for one reason: the ticket asks filtering to apply on
 * change rather than on submit, and a `<form>` that auto-submits on change is a
 * click handler wearing a costume.
 *
 * /admin/usage shipped zero client JavaScript before this, so this is a real
 * architectural change to it rather than a detail. It is kept to the smallest
 * possible island: the selects and the date inputs. The chips, the scope line,
 * every sortable heading and all five tables stay server-rendered.
 *
 * The current parameters arrive as a prop rather than from `useSearchParams`.
 * That hook opts a route into client-side search-param access and wants a
 * Suspense boundary around it to prerender; the server already has these values
 * and handing them down keeps the boundary out of the page entirely.
 *
 * AEH-313.
 */

export type FilterSelect = {
  /** The URL parameter this control owns. */
  param: string;
  label: string;
  value: string;
  /** What the empty option reads as — "All agents", not "None". */
  allLabel: string;
  options: { value: string; label: string }[];
};

export type FilterDateRange = {
  fromParam: string;
  toParam: string;
  from: string;
  to: string;
};

export function FilterFields({
  path,
  params,
  selects,
  dateRange,
}: {
  path: string;
  params: Record<string, string | undefined>;
  selects: FilterSelect[];
  dateRange?: FilterDateRange;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function apply(changes: Record<string, string>) {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...params, ...changes })) {
      if (v !== undefined && v !== '') next.set(k, v);
    }
    const qs = next.toString();
    startTransition(() => {
      // `replace`, not `push`: narrowing a report is refining one view, and a
      // back button that walks every intermediate filter state is a back button
      // nobody can use to leave the page.
      router.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    });
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-end gap-x-4 gap-y-2.5 transition-opacity',
        pending && 'opacity-60',
      )}
      data-testid="filter-fields"
      // Announced while the new view is being fetched, so a slow filter is not
      // silence. The visual cue above is opacity alone, which says nothing to a
      // screen reader.
      aria-busy={pending}
    >
      {selects.map((s) => (
        <label key={s.param} className="block">
          <span className="eyebrow mb-1 block">{s.label}</span>
          <Select
            value={s.value}
            data-testid={`filter-${s.param}`}
            onChange={(e) => apply({ [s.param]: e.target.value })}
          >
            <option value="">{s.allLabel}</option>
            {s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </label>
      ))}

      {dateRange && (
        <div className="flex items-end gap-2">
          <label className="block">
            <span className="eyebrow mb-1 block">From</span>
            <input
              type="date"
              value={dateRange.from}
              max={dateRange.to || undefined}
              data-testid="filter-from"
              onChange={(e) => apply({ [dateRange.fromParam]: e.target.value })}
              className="num rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] text-ink focus:border-green focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="eyebrow mb-1 block">To</span>
            <input
              type="date"
              value={dateRange.to}
              min={dateRange.from || undefined}
              data-testid="filter-to"
              onChange={(e) => apply({ [dateRange.toParam]: e.target.value })}
              className="num rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] text-ink focus:border-green focus:outline-none"
            />
          </label>
        </div>
      )}
    </div>
  );
}
