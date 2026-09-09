'use client';

import { useState, useTransition } from 'react';
import { Lock, LockOpen, Plus, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { AskOracleButton } from './AskOracleButton';
import { useLedger } from './ledger-context';
import { StatementLockBadge } from './LockControls';
import type { StatementDTO } from './statement-dto';

/**
 * The narrative and the assumptions, as an editable list of ADDRESSABLE lines.
 *
 * It was a list of strings until AEH-238, identified by array position. It is a
 * list of rows now, and three affordances depend on that identity: a padlock
 * per line, a tick per line, and a prompt that rewrites what is ticked.
 *
 * ## Why an index is not enough
 *
 * A lock aimed at "assumption 4" would pin an array INDEX, which stops meaning
 * the same thing the moment somebody inserts a line above it. So every line
 * carries the id of its `EstimateStatement` row, and a line the person has just
 * added carries `null` until the save comes back with a real one — that is what
 * `id === null` means here, and it is why the controls that need an id are
 * hidden on a line that does not have one yet.
 *
 * ## The saving rule, which is easy to get wrong
 *
 * This still submits the WHOLE list on every blur, and the server reconciles it
 * by TEXT. A consequence worth knowing before changing anything here: rewording
 * a locked line is a delete plus a create as far as the reconcile can tell, so
 * the server refuses the save outright. That refusal is the guarantee; the
 * disabled textarea below is the courtesy that stops somebody reaching it.
 */
export function EditableList({
  estimateId,
  initialItems,
  action,
  isFinalised,
  addLabel,
  testid,
  askSubject,
  kind,
}: {
  estimateId: string;
  initialItems: StatementDTO[];
  action: (estimateId: string, items: string[]) => Promise<void>;
  isFinalised: boolean;
  addLabel: string;
  testid: string;
  /**
   * What these lines ARE, for the Oracle question seeded from one of them.
   * Narrative sentences and assumptions are the artifacts people trust least,
   * because nothing else on this page traces them back to the document.
   */
  askSubject: string;
  /** Which list this is. The statement axis has no role dimension — only this. */
  kind: 'NARRATIVE' | 'ASSUMPTION';
}) {
  const [items, setItems] = useState<StatementDTO[]>(initialItems);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const {
    locks,
    lockBusy,
    onLockStatement,
    statementKind,
    selectedStatementIds,
    toggleStatementSelected,
  } = useLedger();

  const persist = (next: StatementDTO[]) => {
    const prev = items;
    setItems(next);
    startTransition(async () => {
      try {
        await action(
          estimateId,
          next.map((it) => it.text),
        );
      } catch (e) {
        setItems(prev);
        setError(e instanceof Error ? e.message : 'Could not save');
      }
    });
  };

  const editAt = (i: number, value: string) =>
    setItems((prev) => prev.map((x, j) => (j === i ? { ...x, text: value } : x)));
  const commit = () => {
    setError(null);
    persist(items);
  };
  const removeAt = (i: number) => persist(items.filter((_, j) => j !== i));
  // A new line has no row yet, so no id. It gets one when the save returns and
  // the page is next drawn; until then it cannot be locked or ticked.
  const add = () =>
    setItems((prev) => [...prev, { id: null, text: '', provenance: 'HUMAN' }]);

  const lockOf = (id: string | null) => (id === null ? undefined : locks.statements[id]);
  const listLocked = locks.listsFullyLocked.includes(kind);
  const anyLocked = items.some((it) => lockOf(it.id) !== undefined);

  if (isFinalised) {
    return (
      <ul className="space-y-2" data-testid={testid}>
        {items.map((it, i) => (
          <li key={it.id ?? i} className="group flex items-start gap-2.5">
            <span
              className="mt-[9px] h-[5px] w-[5px] shrink-0 rounded-full bg-green-line"
              aria-hidden
            />
            {/* An assumption may well have its own line breaks in it, and this
                read-only view has to show the same shape the editor did. */}
            <span className="flex-1 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
              {it.text}
            </span>
            <AskOracleButton
              className="mt-1.5"
              label={`Ask Oracle where this ${askSubject} came from`}
              question={askOracleQuestion(askSubject, it.text)}
              testid={`${testid}-ask-${i}`}
            />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div data-testid={testid}>
      <div className="mb-1 flex items-center gap-1.5">
        <ListLockButton
          kind={kind}
          full={listLocked}
          partial={!listLocked && anyLocked}
          testid={testid}
          ids={items.map((it) => it.id).filter((id): id is string => id !== null)}
        />
        {anyLocked && (
          <span className="text-[11px] text-ink-4">
            {listLocked ? 'every line is locked' : 'some lines are locked'}
          </span>
        )}
      </div>

      <ul>
        {items.map((it, i) => {
          const lock = lockOf(it.id);
          const frozen = lock !== undefined;
          const ticked = it.id !== null && selectedStatementIds.includes(it.id);
          return (
            <li
              key={it.id ?? `new-${i}`}
              className={cn(
                'group flex items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface-2',
                ticked && 'bg-green/5',
              )}
            >
              {/* The tick IS the declaration. Only a line with a row behind it
                  can be in an envelope, so a just-added one shows the bullet
                  it always did. */}
              {it.id !== null && !frozen ? (
                <input
                  type="checkbox"
                  checked={ticked}
                  onChange={() => toggleStatementSelected(it.id!, kind)}
                  aria-label={`Select this ${askSubject} for an AI revision`}
                  className="mt-[7px] h-3 w-3 shrink-0 accent-green"
                  data-testid={`${testid}-tick-${i}`}
                />
              ) : (
                <span
                  className="mt-[9px] h-[5px] w-[5px] shrink-0 rounded-full bg-green-line group-hover:bg-green"
                  aria-hidden
                />
              )}

              {/* `field-sizing: content` is what makes a long or multi-line entry
                  readable: the box is as tall as what's in it, so nothing has to
                  be scrolled inside a one-row window to be read. `rows={1}` is
                  the floor an empty entry sits at, and the fallback in a browser
                  that doesn't do content sizing yet. */}
              <textarea
                value={it.text}
                rows={1}
                disabled={frozen}
                onChange={(e) => editAt(i, e.target.value)}
                onBlur={commit}
                className={cn(
                  'field-sizing-content -mx-1.5 -my-0.5 min-w-0 flex-1 resize-none rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[13.5px] leading-relaxed text-ink-2 focus:outline-none',
                  frozen
                    ? 'cursor-not-allowed text-ink-3'
                    : 'hover:border-line hover:bg-surface focus:border-green focus:bg-surface',
                )}
                data-testid={`${testid}-item-${i}`}
              />

              {/* Three states, like the line items': the crew wrote it, a person
                  typed it, or a person steered and the Scribe wrote the words. */}
              {it.provenance !== 'CREW' && (
                <span
                  className="num mt-1 shrink-0 rounded border border-line px-1 text-[9.5px] font-bold tracking-[0.06em] text-ink-4 uppercase"
                  title={
                    it.provenance === 'HUMAN'
                      ? 'Typed by hand, not written by the crew.'
                      : 'Rewritten by the Scribe inside an envelope somebody declared.'
                  }
                  data-testid={`${testid}-provenance-${i}`}
                >
                  {it.provenance === 'HUMAN' ? 'edited' : 'steered'}
                </span>
              )}

              {it.id !== null &&
                (frozen ? (
                  <StatementLockBadge statementId={it.id} estimateId={estimateId} />
                ) : (
                  <button
                    type="button"
                    disabled={lockBusy}
                    onClick={() => onLockStatement({ scope: 'STATEMENT', id: it.id! })}
                    title="Lock this line — freezes its wording, for people and for the AI."
                    aria-label={`Lock this ${askSubject}`}
                    className="mt-1 shrink-0 px-0.5 text-line opacity-0 group-hover:text-ink-4 group-hover:opacity-100 disabled:opacity-50"
                    data-testid={`${testid}-lock-${i}`}
                  >
                    <LockOpen className="h-3 w-3" aria-hidden />
                  </button>
                ))}

              <AskOracleButton
                className="mt-1"
                label={`Ask Oracle where this ${askSubject} came from`}
                question={askOracleQuestion(askSubject, it.text)}
                testid={`${testid}-ask-${i}`}
              />
              <button
                type="button"
                onClick={() => removeAt(i)}
                disabled={frozen}
                title={frozen ? `Locked by ${lock.lockedByName}` : 'Remove'}
                aria-label="Remove"
                className={cn(
                  'mt-0.5 shrink-0 p-0.5 text-ink-4',
                  frozen ? 'cursor-not-allowed opacity-30' : 'opacity-0 group-hover:opacity-100 hover:text-brick',
                )}
                data-testid={`${testid}-remove-${i}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      <Button
        variant="dashed"
        size="xs"
        className="mt-1.5"
        onClick={add}
        data-testid={`${testid}-add`}
      >
        <Plus className="h-3 w-3" /> {addLabel}
      </Button>
      {error && <p className="mt-1.5 text-xs font-medium text-brick">{error}</p>}

      {/* Only under the list the selection belongs to. Ticking in the other
          list moves the selection there, so exactly one bar is ever open. */}
      {statementKind === kind && selectedStatementIds.length > 0 && (
        <StatementEditBar kind={kind} askSubject={askSubject} testid={testid} />
      )}
    </div>
  );
}

/**
 * The whole-list padlock. Three states, for the reason `CardLockButton` has
 * three: a list can be partly frozen, and a plain open padlock over four locked
 * assumptions would surprise somebody whose save is then refused.
 */
function ListLockButton({
  kind,
  full,
  partial,
  testid,
  /** This list's statement ids, so the override question is asked of THIS list. */
  ids,
}: {
  kind: 'NARRATIVE' | 'ASSUMPTION';
  full: boolean;
  partial: boolean;
  testid: string;
  ids: string[];
}) {
  const { lockBusy, onLockStatement, onUnlockStatement, locks, viewerId } = useLedger();
  const [armed, setArmed] = useState(false);
  const anyLocked = full || partial;
  // Scoped to this list's own ids. `locks.statements` is the estimate-wide map
  // with both kinds merged, so scanning all of it armed the assumptions
  // padlock over a colleague's lock on a NARRATIVE line — a confirmation about
  // a lock in a different document — and, worse, skipped the confirmation when
  // the only foreign lock lived in the other list. `CardLockButton` scopes to
  // its own card's rows for exactly this reason.
  const holdsOthers = ids.some((id) => {
    const l = locks.statements[id];
    return l !== undefined && l.lockedById !== viewerId;
  });
  const target = { scope: 'STATEMENT_LIST' as const, kind };

  return (
    <button
      type="button"
      disabled={lockBusy}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!anyLocked) {
          onLockStatement(target);
          return;
        }
        if (holdsOthers && !armed) {
          setArmed(true);
          return;
        }
        onUnlockStatement(target, armed);
        setArmed(false);
      }}
      title={
        armed
          ? 'Click again to override a colleague’s lock on these lines.'
          : full
            ? 'Every line here is locked. Click to unlock.'
            : partial
              ? 'Some lines here are locked. Click to unlock them.'
              : 'Lock this whole list — freezes the wording, for people and for the AI.'
      }
      aria-label={anyLocked ? 'Unlock this list' : 'Lock this list'}
      className={cn(
        'shrink-0 px-1 disabled:opacity-50',
        armed ? 'text-brick' : full ? 'text-bronze-ink' : partial ? 'text-bronze-ink/60' : 'text-line hover:text-ink-4',
      )}
      data-testid={`${testid}-list-lock`}
    >
      {anyLocked ? (
        <Lock className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <LockOpen className="h-3.5 w-3.5" aria-hidden />
      )}
    </button>
  );
}

/**
 * The statement envelope's control surface.
 *
 * Deliberately a sibling of `EditBar` rather than a mode of it. The hours bar
 * carries a role axis and a re-price/reshape choice, and neither exists here: a
 * statement is one sentence and the only thing that can happen to it is that
 * the words change. A shared component would have spent most of itself hiding
 * controls that mean nothing on this axis.
 */
function StatementEditBar({
  kind,
  askSubject,
  testid,
}: {
  kind: 'NARRATIVE' | 'ASSUMPTION';
  askSubject: string;
  testid: string;
}) {
  const { selectedStatementIds, clearStatementSelection, onSteerStatements, editBusy } = useLedger();
  const [prompt, setPrompt] = useState('');
  const n = selectedStatementIds.length;
  const ready = n > 0 && prompt.trim().length > 0 && !editBusy;

  return (
    <div
      className="mt-2 rounded-[10px] border border-green/40 bg-surface px-3 py-2.5"
      data-testid={`${testid}-edit-bar`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="eyebrow text-ink-4">Rewrite</span>
        <span className="num text-[12px] text-ink-2" data-testid={`${testid}-edit-scope`}>
          {n} {askSubject}
          {n === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={clearStatementSelection}
          className="ml-auto flex items-center gap-1 text-[11.5px] text-ink-4 hover:text-ink-2"
          data-testid={`${testid}-edit-clear`}
        >
          <X className="h-3 w-3" aria-hidden /> Clear
        </button>
      </div>

      <div className="mt-2 flex items-start gap-2">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline. Same rule as the hours bar.
            if (e.key === 'Enter' && !e.shiftKey && ready) {
              e.preventDefault();
              void onSteerStatements(prompt).then(() => setPrompt(''));
            }
          }}
          rows={2}
          placeholder={
            kind === 'NARRATIVE'
              ? 'Say this in one sentence, and drop the jargon.'
              : 'These two say the same thing — merge them.'
          }
          aria-label="What should change about the ticked lines"
          className="min-w-0 flex-1 resize-y rounded border border-line bg-surface px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-4 focus:border-green focus:outline-none"
          data-testid={`${testid}-edit-prompt`}
        />
        <Button
          type="button"
          size="sm"
          disabled={!ready}
          onClick={() => void onSteerStatements(prompt).then(() => setPrompt(''))}
          data-testid={`${testid}-edit-submit`}
        >
          <Sparkles className="h-3 w-3" /> {editBusy ? 'Starting…' : 'Rewrite'}
        </Button>
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-ink-4">
        Only the ticked lines can change. The Scribe reads the rest of the estimate — the cards, the
        hours, both lists — so the wording fits the work, but it cannot change an hour or a card.
      </p>
    </div>
  );
}

function askOracleQuestion(subject: string, line: string): string {
  return `Where did this ${subject} come from?\n\n"${line}"\n\nQuote what in the source material supports it, or say plainly if nothing does.`;
}
