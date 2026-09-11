'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * The two repeating rule lists on the config screen: complexity bands, and
 * delivery-overhead cards.
 *
 * Both were one raw-JSON textarea each until AEH-348, which is why they are the
 * only interactive part of an otherwise server-rendered form — a list you can
 * add to and remove from needs a client to do the adding and removing.
 *
 * The inputs are UNCONTROLLED on purpose. State here tracks only which rows
 * exist; what is typed into them lives in the DOM and is read back by the server
 * action from `FormData`. Controlled inputs would re-render the whole list on
 * every keystroke to buy nothing — nothing on this screen reacts to a digit.
 *
 * That makes the `key` load-bearing rather than decorative. Each row carries an
 * id that never changes, so removing the second of four unmounts exactly that
 * row and leaves the other three's DOM — and therefore their edits — untouched.
 * Keyed by array index, React would keep the first three nodes and drop the
 * last, and every value below the removed row would appear to shift up by one.
 *
 * Repeated `name`s rather than indexed ones (`thresholdMin` four times, not
 * `threshold.0.min`): `FormData.getAll` returns them in document order, so the
 * server action zips the columns back into rows by position without either side
 * having to agree on an index that a removal would renumber.
 */

/** Percent-of-hours fields share these bounds; the engine rejects anything else. */
const PCT = { min: 0, max: 100, step: 0.1 } as const;

function RemoveRowButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button
      type="button"
      variant="quiet"
      size="icon"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="shrink-0 hover:text-brick"
    >
      <X className="h-3.5 w-3.5" aria-hidden />
    </Button>
  );
}

function AddRowButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <Button type="button" variant="dashed" size="sm" full onClick={onClick} className="mt-2.5">
      <Plus className="h-3.5 w-3.5" aria-hidden />
      {children}
    </Button>
  );
}

/** Empty means "nothing configured", which is a real answer and not an error. */
function EmptyRow({ children }: { children: string }) {
  return (
    <p className="rounded-[8px] border border-dashed border-line px-3 py-3 text-center text-[12px] text-ink-3">
      {children}
    </p>
  );
}

// ─── Complexity bands ────────────────────────────────────────────────────────

export interface ThresholdRow {
  minCount: number;
  maxCount: number;
  score: number;
}

interface KeyedThreshold extends ThresholdRow {
  rowId: number;
}

export function ThresholdRows({ initial }: { initial: ThresholdRow[] }) {
  const [rows, setRows] = useState<KeyedThreshold[]>(() =>
    initial.map((row, i) => ({ ...row, rowId: i })),
  );
  const [nextId, setNextId] = useState(initial.length);

  function add() {
    setRows((prev) => [...prev, { rowId: nextId, minCount: 0, maxCount: 0, score: 1 }]);
    setNextId((n) => n + 1);
  }

  return (
    <div data-testid="threshold-rows">
      {rows.length === 0 ? (
        <EmptyRow>
          No bands. Every estimate scores 1 for integrations until one is added.
        </EmptyRow>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_1fr_32px] gap-2 px-1">
            <span className="eyebrow">From</span>
            <span className="eyebrow">To</span>
            <span className="eyebrow">Score</span>
            <span />
          </div>
          {rows.map((row, i) => (
            <div key={row.rowId} className="grid grid-cols-[1fr_1fr_1fr_32px] items-center gap-2">
              <Input
                type="number"
                name="thresholdMin"
                defaultValue={row.minCount}
                min={0}
                step={1}
                required
                aria-label={`Band ${i + 1} from integration count`}
                className="num"
              />
              <Input
                type="number"
                name="thresholdMax"
                defaultValue={row.maxCount}
                min={0}
                step={1}
                required
                aria-label={`Band ${i + 1} to integration count`}
                className="num"
              />
              <Input
                type="number"
                name="thresholdScore"
                defaultValue={row.score}
                min={1}
                max={5}
                step={0.1}
                required
                aria-label={`Band ${i + 1} complexity score`}
                className="num"
              />
              <RemoveRowButton
                label={`Remove band ${i + 1}`}
                onClick={() => setRows((prev) => prev.filter((r) => r.rowId !== row.rowId))}
              />
            </div>
          ))}
        </div>
      )}
      <AddRowButton onClick={add}>Add a band</AddRowButton>
    </div>
  );
}

// ─── Delivery overhead ───────────────────────────────────────────────────────

export interface OverheadRow {
  title: string;
  taxonomyKey: string;
  devPct: number | null;
  qaPct: number | null;
  pmPct: number | null;
  baPct: number | null;
}

interface KeyedOverhead extends OverheadRow {
  rowId: number;
}

const ROLE_FIELDS = [
  { name: 'overheadDevPct', label: 'DEV', of: 'devPct' },
  { name: 'overheadQaPct', label: 'QA', of: 'qaPct' },
  { name: 'overheadPmPct', label: 'PM', of: 'pmPct' },
  { name: 'overheadBaPct', label: 'BA', of: 'baPct' },
] as const;

export function OverheadRows({
  initial,
  taxonomyKeys,
}: {
  initial: OverheadRow[];
  /** Suggestions only — the field accepts a key that is not on this list. */
  taxonomyKeys: string[];
}) {
  const [rows, setRows] = useState<KeyedOverhead[]>(() =>
    initial.map((row, i) => ({ ...row, rowId: i })),
  );
  const [nextId, setNextId] = useState(initial.length);

  function add() {
    setRows((prev) => [
      ...prev,
      {
        rowId: nextId,
        title: '',
        taxonomyKey: '',
        devPct: null,
        qaPct: null,
        pmPct: null,
        baPct: null,
      },
    ]);
    setNextId((n) => n + 1);
  }

  return (
    <div data-testid="overhead-rows">
      <datalist id="overhead-taxonomy-keys">
        {taxonomyKeys.map((key) => (
          <option key={key} value={key} />
        ))}
      </datalist>

      {rows.length === 0 ? (
        <EmptyRow>No overhead cards. Estimates will price only the work a SOW names.</EmptyRow>
      ) : (
        <div className="space-y-2.5">
          {rows.map((row, i) => (
            <div key={row.rowId} className="rounded-[8px] border border-line-soft p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  name="overheadTitle"
                  defaultValue={row.title}
                  placeholder="Code Review"
                  required
                  aria-label={`Overhead ${i + 1} title`}
                />
                <Input
                  name="overheadKey"
                  defaultValue={row.taxonomyKey}
                  placeholder="process.code-review"
                  list="overhead-taxonomy-keys"
                  required
                  aria-label={`Overhead ${i + 1} taxonomy key`}
                  className="num text-[12.5px]"
                />
                <RemoveRowButton
                  label={`Remove overhead ${i + 1}`}
                  onClick={() => setRows((prev) => prev.filter((r) => r.rowId !== row.rowId))}
                />
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {ROLE_FIELDS.map((field) => (
                  <label key={field.name} className="flex items-center gap-1.5">
                    <span className="eyebrow w-7 shrink-0">{field.label}</span>
                    <Input
                      type="number"
                      name={field.name}
                      // Empty, not 0. A blank box means this role is charged
                      // nothing and gets no card; a 0 would mean a card costing
                      // nothing, which is a row on a client's estimate for no
                      // hours. The server action keeps that distinction.
                      defaultValue={row[field.of] ?? ''}
                      placeholder="—"
                      min={PCT.min}
                      max={PCT.max}
                      step={PCT.step}
                      aria-label={`Overhead ${i + 1} ${field.label} percent`}
                      className="num px-2 py-1 text-[12.5px]"
                    />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <AddRowButton onClick={add}>Add an overhead card</AddRowButton>
    </div>
  );
}
