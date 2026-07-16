'use client';

import { useState, useTransition } from 'react';
import { Plus, X } from 'lucide-react';

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
      <ul className="list-disc space-y-1 pl-5 text-sm text-gray-800" data-testid={testid}>
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    );
  }

  return (
    <div data-testid={testid}>
      <ul className="space-y-1.5">
        {items.map((t, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-gray-400" aria-hidden />
            <textarea
              value={t}
              rows={1}
              onChange={(e) => editAt(i, e.target.value)}
              onBlur={commit}
              className="min-w-0 flex-1 resize-none rounded-md border border-transparent px-1.5 py-1 text-sm text-gray-800 hover:border-gray-200 focus:border-indigo-300 focus:bg-white focus:outline-none"
              data-testid={`${testid}-item-${i}`}
            />
            <button
              type="button"
              onClick={() => removeAt(i)}
              title="Remove"
              className="mt-1 text-gray-300 hover:text-red-600"
              data-testid={`${testid}-remove-${i}`}
            >
              <X className="h-4 w-4" />
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={add}
        className="mt-2 inline-flex items-center gap-1 rounded-md border border-dashed border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-gray-800"
        data-testid={`${testid}-add`}
      >
        <Plus className="h-3.5 w-3.5" /> {addLabel}
      </button>
      {error && <p className="mt-1 text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
