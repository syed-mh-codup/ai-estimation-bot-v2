'use client';

import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/card';
import { useLedger } from './ledger-context';
import { approveLedgerEdit, discardLedgerEdit, revertLedgerEdit } from './edit-actions';
import { hoursDelta, isEditInFlight, isRevertible, type LedgerEditDTO } from './edit-dto';

/**
 * What the steered edits are doing, in context — AEH-238.
 *
 * Sits with the ledger rather than on a page of its own, deliberately. A
 * background job that shows nothing is worse UX than the blocking call it
 * replaced: the person needs to see which card is being re-priced, how many are
 * queued behind it, and what changed when it lands, without leaving the thing
 * they are editing.
 *
 * It also carries the two decisions a background job cannot ask for — approving
 * or discarding a proposal that was parked because the region moved — and the
 * one-level revert.
 */

function statusWords(e: LedgerEditDTO): string {
  switch (e.status) {
    case 'QUEUED':
      return 'Queued';
    case 'RUNNING':
      return e.stage ?? 'Working';
    case 'PENDING_CONFLICT':
      return 'Someone changed this while it ran';
    case 'APPLIED':
      return e.overwroteConflict ? 'Applied over a change' : 'Applied';
    case 'REVERTED':
      return 'Put back';
    case 'DISCARDED':
      return 'Discarded';
    case 'FAILED':
      return 'Failed';
  }
}

export function EditActivity() {
  const { edits, setEdits, items, isFinalised } = useLedger();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Settled edits stay listed only while they are still actionable or still
  // news. A reverted or discarded one is neither, so it drops out rather than
  // accumulating a log nobody reads on the screen where the work happens —
  // the durable record is the LedgerEdit row.
  const shown = edits.filter(
    (e) => e.status !== 'REVERTED' && e.status !== 'DISCARDED',
  );
  if (shown.length === 0) return null;

  const titleOf = (cardIds: string[]): string => {
    const names = cardIds
      .map((id) => items.find((i) => i.id === id)?.title)
      .filter((t): t is string => Boolean(t));
    if (names.length === 0) return 'a card that is no longer here';
    return names.length === 1 ? names[0]! : `${names[0]!} and ${names.length - 1} more`;
  };

  const run = async (id: string, fn: () => Promise<LedgerEditDTO>): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      const next = await fn();
      setEdits(edits.map((e) => (e.id === next.id ? next : e)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div
      className="mt-3 rounded-[10px] border border-line bg-surface px-4 py-3"
      data-testid="edit-activity"
    >
      <Eyebrow>Steered edits</Eyebrow>

      {error && (
        <p className="mt-1.5 text-[12px] text-brick" data-testid="edit-activity-error">
          {error}
        </p>
      )}

      <ul className="mt-2 flex flex-col gap-2.5">
        {shown.map((e) => {
          const delta = hoursDelta(e);
          return (
            <li
              key={e.id}
              className="border-t border-line-soft pt-2.5 first:border-t-0 first:pt-0"
              data-testid={`edit-${e.id}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="num text-[11px] font-bold tracking-[0.06em] text-ink-3 uppercase">
                  {e.roles.join(' ')}
                </span>
                <span className="text-[12.5px] text-ink-2">{titleOf(e.cardIds)}</span>
                <span
                  className={cn(
                    'num ml-auto text-[11.5px]',
                    e.status === 'FAILED' || e.status === 'PENDING_CONFLICT'
                      ? 'text-bronze-ink'
                      : 'text-ink-4',
                  )}
                  data-testid={`edit-status-${e.id}`}
                >
                  {statusWords(e)}
                </span>
              </div>

              {/* The instruction, so a list of edits reads as a list of
                  decisions rather than of events. */}
              <p className="mt-0.5 text-[11.5px] leading-snug text-ink-4">“{e.prompt}”</p>

              {isEditInFlight(e) && (
                <div className="mt-1.5 h-1 overflow-hidden rounded bg-line-soft">
                  <div
                    className="h-full bg-green transition-[width] duration-500"
                    style={{ width: `${Math.max(2, e.pct)}%` }}
                    data-testid={`edit-bar-${e.id}`}
                  />
                </div>
              )}

              {delta !== null && delta !== 0 && (
                <p className="num mt-0.5 text-[11.5px] text-ink-3">
                  {delta > 0 ? '+' : ''}
                  {delta}h{' '}
                  <span className="text-ink-4">
                    ({e.rowsBefore} line{e.rowsBefore === 1 ? '' : 's'} → {e.rowsAfter})
                  </span>
                </p>
              )}

              {e.reasoning && (
                <p className="mt-0.5 text-[11.5px] leading-snug text-ink-4">{e.reasoning}</p>
              )}

              {e.error && (
                <p className="mt-0.5 text-[11.5px] leading-snug text-brick">{e.error}</p>
              )}

              {/* The decision a background job could not ask for. */}
              {e.status === 'PENDING_CONFLICT' && !isFinalised && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busyId === e.id}
                    onClick={() => void run(e.id, () => approveLedgerEdit(e.id))}
                    data-testid={`edit-approve-${e.id}`}
                  >
                    Apply anyway
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="dashed"
                    disabled={busyId === e.id}
                    onClick={() => void run(e.id, () => discardLedgerEdit(e.id))}
                    data-testid={`edit-discard-${e.id}`}
                  >
                    Throw it away
                  </Button>
                  <span className="text-[11px] text-ink-4">
                    Applying overwrites the change that landed underneath it.
                  </span>
                </div>
              )}

              {isRevertible(e) && !isFinalised && (
                <div className="mt-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="dashed"
                    disabled={busyId === e.id}
                    onClick={() => void run(e.id, () => revertLedgerEdit(e.id))}
                    data-testid={`edit-revert-${e.id}`}
                  >
                    <Undo2 className="h-3 w-3" /> Put it back
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
