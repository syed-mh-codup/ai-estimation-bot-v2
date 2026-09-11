'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PanelRight, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useLedger } from './ledger-context';
import { ACTIVITY_SLOT, openDock, useDock } from './dock';
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
      return e.revertedByName ? `Put back by ${e.revertedByName}` : 'Put back';
    case 'DISCARDED':
      return 'Discarded';
    case 'FAILED':
      return 'Failed';
  }
}

/**
 * The tab that opens the activity sheet.
 *
 * The list used to be an inline panel and it grew past what the ledger could
 * spare: a whole-estimate re-price is one edit PER CARD, so on a thirty-card
 * estimate the panel was taller than the thing it described. It is a
 * right-hand sheet now, and this is its handle — a fixed tab on the right
 * edge, directly above Oracle's and deliberately the same shape. Two edges of
 * the same drawer rather than two unrelated buttons.
 *
 * The counts come from every edit the poll returned, not from what the list
 * renders. That is the other half of the same complaint: the panel showed
 * eight rows of thirty-four and nothing said so, so "did my bulk edit actually
 * start" was a question whose answer was off the bottom of a list.
 *
 * It mounts inside `LedgerProvider` and has to — everything it counts comes
 * from `useLedger` — but it SHOWS in the Inspect dock, which mounts outside it
 * so a run finishing cannot wipe an open conversation. A portal is what spans
 * that: the component stays where its data is and the list renders where the
 * reader expects it, in the tab beside Oracle rather than in a flyout of its
 * own. AEH-377.
 */
export function EditActivity() {
  const { edits, editCounts } = useLedger();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const { open, tab } = useDock();
  const showing = open && tab === 'activity';

  // After the dock has painted its panel, not before: the element does not
  // exist until the tab is the one on screen.
  useEffect(() => {
    setSlot(showing ? document.getElementById(ACTIVITY_SLOT) : null);
  }, [showing]);

  if (editCounts.total === 0 && edits.length === 0) return null;

  // From the counts, not from `edits`. The list is a capped page — a
  // whole-estimate re-price is one edit per card — so counting what is
  // rendered is how "8 of 34" became "8", with nothing saying so.
  const { running, queued, pendingConflict: waiting, failed } = editCounts;
  const total = Math.max(editCounts.total, edits.length);
  const inFlight = running + queued;

  // Ordered so the most actionable thing is first. A parked conflict is a
  // question somebody has to answer; the rest is progress.
  const parts = [
    waiting > 0 ? `${waiting} waiting on you` : null,
    running > 0 ? `${running} running` : null,
    queued > 0 ? `${queued} queued` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter((p): p is string => p !== null);

  return (
    <>
      {/* A summary line in the ledger rather than a floating tab of its own.
          What it says is the part that matters — "3 waiting on you" is a
          question somebody has to answer, and it was previously legible only
          after opening a panel to find out. */}
      <button
        type="button"
        onClick={() => openDock('activity')}
        aria-label={`Steered edits: ${total}${parts.length ? `, ${parts.join(', ')}` : ''}`}
        className={cn(
          'mt-2.5 flex h-8 w-full items-center gap-2 rounded-md border px-2.5 text-left transition-colors',
          'focus-visible:ring-2 focus-visible:ring-green focus-visible:outline-none',
          waiting > 0 || failed > 0
            ? 'border-bronze-line bg-bronze-tint hover:border-bronze-ink'
            : 'border-line bg-surface hover:border-green-line hover:bg-green-tint',
        )}
        data-testid="edit-activity-open"
      >
        <PanelRight className="h-3.5 w-3.5 shrink-0 text-ink-4" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">
          Edits
          <span className="num ml-2 text-[11px] font-normal text-ink-4">
            {parts.length > 0 ? parts.join(' · ') : total}
          </span>
        </span>
        {inFlight > 0 && (
          <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-green" aria-hidden />
        )}
      </button>

      {/* Into the dock, from inside the provider whose data this needs. */}
      {slot ? createPortal(<EditActivityList />, slot) : null}
    </>
  );
}

/** The list itself, which now has a sheet's worth of room to be read in. */
function EditActivityList() {
  const { edits, editCounts: counts, setEdits, items, isFinalised } = useLedger();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A settled edit stays listed, muted, rather than vanishing. An entry that
  // disappears the moment you put it back is disorienting — you cannot tell
  // whether the revert worked or the panel lost track of it.
  //
  // Everything the poll returned is shown now, where an inline panel could
  // only afford eight. The cap that remains is `take` in `listLedgerEdits`,
  // which is a query bound rather than a rendering one, and the durable record
  // is the LedgerEdit row either way.
  const shown = edits;
  const settled = (e: LedgerEditDTO): boolean =>
    e.status === 'REVERTED' || e.status === 'DISCARDED';

  /**
   * What an edit was aimed at, in one phrase.
   *
   * A statement revision is asked FIRST, because it pins no cards at all: its
   * write set is `statementIds` and `pinnedCardIds` is empty by construction.
   * Read as a card list, that came out as "a card that is no longer here" —
   * every assumption rewrite in the panel reading as an edit against something
   * deleted. The data to say it properly was already on the DTO and had no
   * consumer.
   */
  const subjectOf = (e: LedgerEditDTO): string => {
    if (e.mode === 'REVISE_STATEMENTS') {
      const n = e.statementIds.length;
      const what = e.scope === 'STATEMENT_LIST' ? 'the whole list' : `${n} line${n === 1 ? '' : 's'}`;
      // The kind is not on the DTO, and inventing "assumption" or "narrative"
      // from a scope word would be a guess. `declaredScope` is what is known.
      return `${what} of prose`;
    }
    const names = e.cardIds
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
    <div className="flex min-h-0 flex-col" data-testid="edit-activity">
      {/* A plain heading, not a `DialogTitle`: this is a panel of the page
          now rather than the contents of a sheet, and Radix's title has to be
          inside a dialog root to mean anything. */}
      <div className="-mx-3.5 -mt-3.5 mb-3.5 border-b border-line px-4 py-3.5">
        <h2 className="font-serif text-[17px] font-medium text-ink">Steered edits</h2>
        <p className="mt-0.5 text-[11.5px] text-ink-4">
          What was asked for, what it did, and what can be put back.
          {/* Said plainly when the list is a page of something larger, because
              a silent cap is what made a thirty-card steer look like it had
              barely started. */}
          {counts.total > shown.length && (
            <>
              {' '}
              Showing the most recent <span className="num">{shown.length}</span> of{' '}
              <span className="num">{counts.total}</span>.
            </>
          )}
        </p>
      </div>

      {error && (
        <p className="px-4 pt-2.5 text-[12px] text-brick" data-testid="edit-activity-error">
          {error}
        </p>
      )}

      <ul className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3">
        {shown.map((e) => {
          const delta = hoursDelta(e);
          return (
            <li
              key={e.id}
              className={cn(
                'border-t border-line-soft pt-2.5 first:border-t-0 first:pt-0',
                settled(e) && 'opacity-55',
              )}
              data-testid={`edit-${e.id}`}
            >
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="num text-[11px] font-bold tracking-[0.06em] text-ink-3 uppercase">
                  {/* A statement revision has no roles — a sentence is not
                      DEV or QA work — so it says what it is rather than
                      rendering an empty chip. */}
                  {e.mode === 'REVISE_STATEMENTS' ? 'Prose' : e.roles.join(' ')}
                </span>
                <span className="text-[12.5px] text-ink-2">{subjectOf(e)}</span>
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
                  {/* When, not just what. An edit list with no times cannot
                      answer "is this the one I just ran". */}
                  {(e.revertedAt ?? e.appliedAt) && (
                    <span className="text-ink-4">
                      {' '}
                      {new Date((e.revertedAt ?? e.appliedAt)!).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
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

              {e.reasoning && <Reasoning text={e.reasoning} editId={e.id} />}

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

/**
 * The model's argument for what it did, made readable.
 *
 * It arrives as one string and was rendered as one paragraph, which turned the
 * most substantive thing on this panel into a wall nobody read. It is not
 * shapeless, though — the engine collates it as one entry per slice, newline
 * separated, each of the form `Card title (ROLE): what it decided`. So the
 * structure to render was already in the text and only needed respecting:
 * split on the newlines, and lift that prefix out as a label.
 *
 * Folded shut past the first two entries. A whole-estimate re-price collates
 * one entry per card per role, and forty of those unfolded is the same wall in
 * a different shape — the fold exists because the first lines are the summary
 * and the rest is the evidence you open when you doubt it.
 */
function Reasoning({ text, editId }: { text: string; editId: string }) {
  const entries = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (entries.length === 0) return null;

  // `Card (ROLE): body` — the shape `runLedgerEdit` writes. A line that does
  // not match is rendered whole rather than forced into a label it has none
  // of: the Curator's and the Scribe's notes are plain prose and arrive that
  // way.
  const parse = (line: string): { label: string | null; body: string } => {
    const m = /^(.{1,80}?\s\((?:DEV|QA|PM|BA)\)):\s*(.+)$/.exec(line);
    return m ? { label: m[1]!, body: m[2]! } : { label: null, body: line };
  };

  const FOLD_AT = 2;
  const head = entries.slice(0, FOLD_AT);
  const rest = entries.slice(FOLD_AT);

  const render = (line: string, i: number) => {
    const { label, body } = parse(line);
    return (
      <li key={i} className="text-[11.5px] leading-snug text-ink-4">
        {label && <span className="font-medium text-ink-3">{label}</span>}
        {label ? ' \u2014 ' : ''}
        {body}
      </li>
    );
  };

  return (
    <div className="mt-1" data-testid={`edit-reasoning-${editId}`}>
      <ul className="space-y-1">{head.map(render)}</ul>
      {rest.length > 0 && (
        <details className="group mt-1">
          <summary className="cursor-pointer list-none text-[11px] text-ink-3 hover:text-green">
            <span className="group-open:hidden">
              {rest.length} more {rest.length === 1 ? 'note' : 'notes'}
            </span>
            <span className="hidden group-open:inline">Fewer</span>
          </summary>
          <ul className="mt-1 space-y-1">{rest.map(render)}</ul>
        </details>
      )}
    </div>
  );
}
