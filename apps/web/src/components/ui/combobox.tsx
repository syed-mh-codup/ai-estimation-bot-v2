'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ComboboxOption = {
  value: string;
  label: string;
  /** Quiet second line — context length, price, whatever distinguishes it. */
  hint?: string;
};

/**
 * A searchable single-select over a long list.
 *
 * Hand-rolled rather than pulled from Radix, which has no combobox; the four
 * unused Radix packages already installed here do not fit either. Kept small
 * and in the house style.
 *
 * Two behaviours matter more than the picker itself, and both are about not
 * trapping the person using it:
 *
 * 1. `value` is always selectable even when it is not in `options`. A saved
 *    model that OpenRouter has since delisted must not silently become
 *    something else the moment somebody opens the form and saves.
 * 2. An empty `options` list falls back to a plain text input. The list is
 *    fetched from a third party, and an admin must never be unable to edit a
 *    prompt because that fetch failed.
 */
export function Combobox({
  name,
  value,
  options,
  id,
  placeholder,
  emptyHint,
  'data-testid': testId,
}: {
  name: string;
  value: string;
  options: ComboboxOption[];
  id?: string;
  placeholder?: string;
  /** Shown when the list could not be loaded and this degrades to free text. */
  emptyHint?: string;
  'data-testid'?: string;
}) {
  const [selected, setSelected] = useState(value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    searchRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // The current value first, and present even when the catalogue has dropped it.
  const items = useMemo(() => {
    const known = options.some((o) => o.value === selected);
    const current: ComboboxOption[] = known
      ? []
      : [{ value: selected, label: selected, hint: 'currently saved — not in the live list' }];
    return [...current, ...options];
  }, [options, selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 60);
    return items
      .filter((o) => o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
      .slice(0, 60);
  }, [items, query]);

  if (options.length === 0) {
    return (
      <div data-testid={testId}>
        <input
          id={id}
          name={name}
          defaultValue={value}
          placeholder={placeholder}
          className="num w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-green focus:outline-none"
          data-testid={testId ? `${testId}-fallback` : undefined}
        />
        {emptyHint && <p className="mt-1 text-[11.5px] text-bronze-ink">{emptyHint}</p>}
      </div>
    );
  }

  const selectedOption = items.find((o) => o.value === selected);

  return (
    <div ref={rootRef} className="relative" data-testid={testId}>
      {/* The form posts this; the button is only the interface to it. */}
      <input type="hidden" name={name} value={selected} />

      <button
        type="button"
        id={id}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-left text-[13px] text-ink hover:border-ink-4 focus:border-green focus:outline-none"
        data-testid={testId ? `${testId}-trigger` : undefined}
      >
        <span className="num truncate">{selected || placeholder}</span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
      </button>

      {selectedOption?.hint && (
        <p className="mt-1 text-[11.5px] text-ink-3">{selectedOption.hint}</p>
      )}

      {open && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_16px_48px_rgba(35,33,27,0.18)]">
          <div className="flex items-center gap-2 border-b border-line-soft px-2.5 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models…"
              className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-4 focus:outline-none"
              data-testid={testId ? `${testId}-search` : undefined}
            />
          </div>

          <ul role="listbox" className="max-h-[280px] overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-[12.5px] text-ink-3">Nothing matches that.</li>
            )}
            {filtered.map((o) => (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === selected}
                  onClick={() => {
                    setSelected(o.value);
                    setOpen(false);
                    setQuery('');
                  }}
                  className={cn(
                    'flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-surface-2',
                    o.value === selected && 'bg-green-tint',
                  )}
                  data-testid={`combobox-option-${o.value}`}
                >
                  <Check
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0 text-green',
                      o.value !== selected && 'invisible',
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0">
                    <span className="num block truncate text-[12.5px] text-ink">{o.value}</span>
                    {o.hint && <span className="block text-[11px] text-ink-3">{o.hint}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
