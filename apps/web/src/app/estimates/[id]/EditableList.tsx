'use client';

import { useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Editable bullet list for the estimate's narrative / assumptions (both are
 * String[] on the model). Add, edit-in-place, and remove entries; the whole
 * list persists on each change via the provided action. Optimistic with
 * revert-on-error.
 */
export function EditableList({
  estimateId,
  initialItems,
  action,
  isFinalised,
  addLabel,
  testid,
}: {
  estimateId: string;
  initialItems: string[];
  action: (estimateId: string, items: string[]) => Promise<void>;
  isFinalised: boolean;
  addLabel: string;
  testid: string;
}) {
  const [items, setItems] = useState<string[]>(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const persist = (next: string[]) => {
    const prev = items;
    setItems(next);
    startTransition(async () => {
      try {
        await action(estimateId, next);
      } catch (e) {
        setItems(prev);
        setError(e instanceof Error ? e.message : 'Could not save');
      }
    });
  };

  const editAt = (i: number, value: string) => setItems((prev) => prev.map((x, j) => (j === i ? value : x)));
  const commit = () => persist(items);
  const removeAt = (i: number) => persist(items.filter((_, j) => j !== i));
  const add = () => setItems((prev) => [...prev, '']);

  if (isFinalised) {
    return (
      <ul className="space-y-2" data-testid={testid}>
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="mt-[9px] h-[5px] w-[5px] shrink-0 rounded-full bg-green-line" aria-hidden />
            <span className="text-[13.5px] leading-relaxed text-ink-2">{t}</span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div data-testid={testid}>
      <ul>
        {items.map((t, i) => (
          <li key={i} className="group flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2">
            <span
              className="mt-[9px] h-[5px] w-[5px] shrink-0 rounded-full bg-green-line group-hover:bg-green"
              aria-hidden
            />
            <textarea
              value={t}
              rows={1}
              onChange={(e) => editAt(i, e.target.value)}
              onBlur={commit}
              className="-mx-1.5 -my-0.5 min-w-0 flex-1 resize-none rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[13.5px] leading-relaxed text-ink-2 hover:border-line hover:bg-surface focus:border-green focus:bg-surface focus:outline-none"
              data-testid={`${testid}-item-${i}`}
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              title="Remove"
              aria-label="Remove"
              className="mt-0.5 shrink-0 p-0.5 text-ink-4 opacity-0 group-hover:opacity-100 hover:text-brick"
              data-testid={`${testid}-remove-${i}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <Button variant="dashed" size="xs" className="mt-1.5" onClick={add} data-testid={`${testid}-add`}>
        <Plus className="h-3 w-3" /> {addLabel}
      </Button>
      {error && <p className="mt-1.5 text-xs font-medium text-brick">{error}</p>}
    </div>
  );
}
