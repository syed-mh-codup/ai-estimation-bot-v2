'use client';

import { useState, useTransition } from 'react';
import { setCustodian, setDueAt } from './actions';

export type CustodianOption = { id: string; label: string };

/**
 * Who is answerable for this estimate right now. Optimistic like the rest of
 * the rail — the change applies immediately, and a rejected save reverts and
 * says why (handing custody to a disabled account is the one the server
 * refuses).
 *
 * Deliberately a plain <select> rather than the searchable Combobox: this list
 * is the team, not a third-party model catalogue, and it is short.
 */
export function CustodianField({
  estimateId,
  initialCustodianId,
  options,
  isFinalised,
}: {
  estimateId: string;
  initialCustodianId: string | null;
  options: CustodianOption[];
  isFinalised: boolean;
}) {
  const [custodianId, setId] = useState(initialCustodianId);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const label = options.find((o) => o.id === custodianId)?.label;

  if (isFinalised) {
    return <span>{label ?? 'Unassigned'}</span>;
  }

  const commit = (next: string | null) => {
    const prev = custodianId;
    setId(next);
    setError(null);
    startTransition(async () => {
      try {
        await setCustodian(estimateId, next);
      } catch (e) {
        setId(prev);
        setError(e instanceof Error ? e.message : 'Could not save');
      }
    });
  };

  return (
    <>
      <select
        value={custodianId ?? ''}
        onChange={(e) => commit(e.target.value === '' ? null : e.target.value)}
        aria-label="Custodian"
        className="w-full rounded border border-line bg-surface px-1 py-0.5 text-[11.5px] text-ink focus:border-green focus:outline-none"
        data-testid="custodian-select"
      >
        <option value="">Unassigned</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p className="mt-1 text-[11px] text-brick" data-testid="custodian-error">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The deadline. A date, not a datetime — see the schema comment on `dueAt`.
 *
 * Saving on change rather than on blur: a native date picker fires change when
 * a day is clicked, and a person who has just picked a date considers
 * themselves finished.
 */
export function DueDateField({
  estimateId,
  initialDueAt,
  relativeLabel,
  isFinalised,
}: {
  estimateId: string;
  initialDueAt: string | null;
  /** Server-rendered "due in 3 days" for the initial value, so first paint
   *  matches the dashboard exactly instead of recomputing against a client
   *  clock that may sit in a different day. */
  relativeLabel: string | null;
  isFinalised: boolean;
}) {
  const [value, setValue] = useState(initialDueAt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (isFinalised) {
    return <span className="num">{value || '—'}</span>;
  }

  const commit = (next: string) => {
    const prev = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      try {
        await setDueAt(estimateId, next === '' ? null : next);
      } catch (e) {
        setValue(prev);
        setError(e instanceof Error ? e.message : 'Could not save');
      }
    });
  };

  // The relative label is only honest while the date is the one the server
  // rendered; after an edit the page revalidates and brings a fresh one.
  const showRelative = relativeLabel && value === (initialDueAt ?? '');

  return (
    <>
      <input
        type="date"
        value={value}
        onChange={(e) => commit(e.target.value)}
        aria-label="Due date"
        className="num w-full rounded border border-line bg-surface px-1 py-0.5 text-[11.5px] text-ink focus:border-green focus:outline-none"
        data-testid="due-date-input"
      />
      {showRelative && (
        <p className="mt-0.5 text-[11px] text-ink-4" data-testid="due-relative">
          {relativeLabel}
        </p>
      )}
      {error && (
        <p className="mt-1 text-[11px] text-brick" data-testid="due-date-error">
          {error}
        </p>
      )}
    </>
  );
}
