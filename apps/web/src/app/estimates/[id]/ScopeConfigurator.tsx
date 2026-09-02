'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';

import { consequencesOf } from '@repo/shared';

import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/card';

import { resetScenarioToAsRun, saveScenarioPicks } from './scope-actions';
import {
  pushUndo,
  resolveToggle,
  saveStateOf,
  type Notice,
  type UndoStep,
} from './scope-interaction';
import {
  asRunPicks,
  graphFromDTO,
  resolveCards,
  totalsOf,
  type ResolvedCard,
  type ScenarioDTO,
  type ScopeGraphDTO,
} from './scope-dto';

/**
 * The scope configurator. AEH-235.
 *
 * A planning surface, deliberately not an editor. It never writes
 * `MenuItem.enabled` — the estimate screen is where a team decides what the
 * work is, and a client-facing what-if must not rewrite it underneath them.
 * What this persists is a scenario's pick set and nothing else.
 *
 * ## Why the whole pick set is a snapshot
 *
 * One click can change thirty rows. Undo is therefore the same mechanism as
 * revert-on-failure — a stack of previous pick sets — rather than two
 * mechanisms that have to agree. And writes are SERIALISED, one in flight at a
 * time with the rows disabled meanwhile: a half-applied cascade on screen in
 * front of a client is worse than a toggle that is briefly unresponsive.
 */

export function ScopeConfigurator({
  graph,
  scenario,
}: {
  graph: ScopeGraphDTO;
  scenario: ScenarioDTO;
}) {
  const [picks, setPicks] = useState<string[]>(scenario.picks);
  const [undoStack, setUndoStack] = useState<UndoStep[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const [pending, startTransition] = useTransition();

  // Captured inside the updater rather than read from render-time state: a
  // thirty-row cascade widens the window in which a stale closure would revert
  // to the wrong snapshot.
  const inFlight = useRef(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const walkable = useMemo(() => graphFromDTO(graph), [graph]);
  const foundation = useMemo(
    () => new Set(graph.cards.filter((c) => c.foundation).map((c) => c.id)),
    [graph],
  );
  const cards = useMemo(() => resolveCards(graph, picks), [graph, picks]);
  // One resolve for the whole screen. Asking each row for its own consequence
  // would re-resolve the selection per row — see `consequencesOf`.
  const consequences = useMemo(
    () => consequencesOf({ graph: walkable, picks, foundation }),
    [walkable, picks, foundation],
  );
  const totals = useMemo(() => totalsOf(cards), [cards]);
  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);
  const titleOf = useCallback((id: string) => byId.get(id)?.title ?? id, [byId]);

  /**
   * The one path every change takes: apply optimistically, persist, and either
   * confirm or put it all back.
   *
   * Toggling, undo and reset were three near-identical copies of this. They
   * had to agree on the revert granularity and on the saved signal, and three
   * copies of "agree" is how they stop agreeing.
   */
  const persist = useCallback(
    (args: {
      next: string[];
      previous: string[];
      /** Pushed onto the undo stack, or null for a change that is itself an undo. */
      undoLabel: string | null;
      server: () => Promise<unknown>;
      failure: string;
    }) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPicks(args.next);
      if (args.undoLabel !== null) {
        const label = args.undoLabel;
        setUndoStack((s) => pushUndo(s, { picks: args.previous, label }));
      }
      startTransition(async () => {
        try {
          await args.server();
          setError(null);
          // Stamped rather than a boolean, so a second save during the flash
          // restarts it instead of being swallowed by an already-true flag.
          setSavedAt(Date.now());
          if (savedTimer.current) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(() => setSavedAt(0), 2500);
        } catch (e) {
          // Whole-snapshot revert, which is the only correct granularity when a
          // single action changed an unknown number of rows.
          setPicks(args.previous);
          if (args.undoLabel !== null) setUndoStack((s) => s.slice(1));
          setError(e instanceof Error ? e.message : args.failure);
        } finally {
          inFlight.current = false;
        }
      });
    },
    [],
  );

  const state = { graph: walkable, picks, foundation };

  const onToggle = (card: ResolvedCard) => {
    const outcome = resolveToggle(state, card, titleOf);
    setNotice(outcome.notice);
    if (outcome.kind === 'refused') return;
    persist({
      next: outcome.picks,
      previous: picks,
      undoLabel: outcome.undoLabel,
      server: () => saveScenarioPicks(scenario.id, outcome.picks),
      failure: 'Could not save that change',
    });
  };

  const onUndo = () => {
    const [step, ...rest] = undoStack;
    if (!step || inFlight.current) return;
    setUndoStack(rest);
    setNotice({ text: `Undid: ${step.label}.`, kind: 'added' });
    persist({
      next: step.picks,
      previous: picks,
      // An undo does not push onto the stack — it pops off it, above.
      undoLabel: null,
      server: () => saveScenarioPicks(scenario.id, step.picks),
      failure: 'Could not undo that',
    });
  };

  const onReset = () => {
    setNotice({ text: 'Reset to the estimate as proposed.', kind: 'added' });
    persist({
      next: asRunPicks(graph.cards),
      previous: picks,
      undoLabel: 'reset to as proposed',
      // The server recomputes as-run rather than trusting what the client
      // worked out, so this is not `saveScenarioPicks` with the same list.
      server: () => resetScenarioToAsRun(scenario.id),
      failure: 'Could not reset',
    });
  };

  const saveState = saveStateOf({ pending, savedAt });
  const groups = useMemo(() => groupCards(cards), [cards]);

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex min-w-0 flex-col gap-3">
        {error && (
          <p
            data-testid="scope-error"
            className="rounded-[8px] border border-red/40 bg-red/5 px-3 py-2 text-[12.5px] text-red"
          >
            {error}
          </p>
        )}
        {notice && (
          <div
            data-testid="scope-notice"
            className="flex items-start justify-between gap-3 rounded-[8px] border border-line bg-surface-2 px-3 py-2"
          >
            <p className="text-[12.5px] text-ink-2">{notice.text}</p>
            {undoStack.length > 0 && (
              <Button variant="ghost" onClick={onUndo} data-testid="scope-undo" disabled={pending}>
                Undo
              </Button>
            )}
          </div>
        )}

        {groups.map(([label, rows]) => (
          <section key={label} className="rounded-[10px] border border-line bg-surface">
            <header className="flex items-baseline justify-between border-b border-line-soft px-4 py-2.5">
              <Eyebrow>{label}</Eyebrow>
              <span className="num text-[11px] text-ink-4">
                {rows.filter((r) => r.selected).length}/{rows.length} on
              </span>
            </header>
            <ul>
              {rows.map((card) => (
                <ScopeRow
                  key={card.id}
                  card={card}
                  titleOf={titleOf}
                  pending={pending}
                  wouldAdd={consequences.get(card.id)?.adds ?? []}
                  wouldRemove={consequences.get(card.id)?.removes ?? []}
                  onToggle={() => onToggle(card)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <aside className="flex flex-col gap-3.5 lg:sticky lg:top-4 max-lg:order-first">
        <div
          data-testid="scope-totals"
          className="rounded-[10px] border border-line bg-surface px-4 py-3.5"
        >
          <Eyebrow>Configured scope</Eyebrow>
          <p className="num mt-2 text-[26px] leading-none text-ink-1" data-testid="scope-hours">
            {totals.hours}h
          </p>
          <p className="mt-1.5 text-[12px] text-ink-3" data-testid="scope-modules">
            {totals.moduleCount} {totals.moduleCount === 1 ? 'module' : 'modules'} of{' '}
            {graph.cards.length}
          </p>
          {totals.cardsOff > 0 && (
            <p
              className="mt-2.5 border-t border-line-soft pt-2 text-[11.5px] text-ink-4"
              data-testid="scope-excluded"
            >
              {totals.cardsOff} switched off · {totals.excludedHours}h excluded
            </p>
          )}

          {/* Whether the numbers above are the saved ones.
              
              The toggles already disable during a write, but "nothing responds
              for a moment" is not the same as "this is being saved" — and in
              front of a client, a number that has visibly changed with no
              confirmation invites the question of whether it stuck. The height
              is reserved so appearing and clearing does not shift the totals. */}
          <p
            data-testid="scope-save-state"
            data-state={saveState}
            aria-live="polite"
            className="mt-2 flex h-4 items-center gap-1.5 text-[11px] text-ink-4"
          >
            {saveState === 'saving' ? (
              <>
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-4"
                />
                Saving…
              </>
            ) : saveState === 'saved' ? (
              <>
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-green" />
                Saved
              </>
            ) : null}
          </p>
        </div>

        <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
          <Eyebrow>Start from</Eyebrow>
          <div className="mt-2 flex flex-col gap-1.5">
            <Button variant="ghost" onClick={onReset} data-testid="scope-reset" disabled={pending}>
              As proposed
            </Button>
            <p className="text-[11.5px] leading-snug text-ink-4">
              Restores every module to the state the estimate was produced in. This is a planning
              view — it never changes the estimate itself.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}

/**
 * Group by phase, falling back to a single group.
 *
 * Phase is the only grouping the pipeline actually populates, and it populates
 * it thinly — most cards have none. So this is honest rather than clever: named
 * groups where they exist, one bucket where they do not. Generated grouping is
 * a separate piece of work.
 */
function groupCards(cards: ResolvedCard[]): Array<[string, ResolvedCard[]]> {
  const order = ['Foundation', 'Core', 'Enhancement'];
  const buckets = new Map<string, ResolvedCard[]>();
  for (const card of cards) {
    const key = card.phase ?? 'Unphased';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(card);
  }
  return [...buckets.entries()].sort(
    ([a], [b]) =>
      (order.indexOf(a) === -1 ? order.length : order.indexOf(a)) -
      (order.indexOf(b) === -1 ? order.length : order.indexOf(b)) || a.localeCompare(b),
  );
}

function ScopeRow({
  card,
  titleOf,
  wouldAdd,
  wouldRemove,
  pending,
  onToggle,
}: {
  card: ResolvedCard;
  titleOf: (id: string) => string;
  wouldAdd: string[];
  wouldRemove: string[];
  pending: boolean;
  onToggle: () => void;
}) {
  // The consequence, at the moment of the decision. The reference artifact
  // shows nothing here, so a click that removes 32 modules looks like a click
  // that removes one.
  // Both counts already exclude the card itself — they answer "and what else".
  const consequence =
    !card.selected && wouldAdd.length > 0
      ? `brings in ${wouldAdd.length} more`
      : card.selected && wouldRemove.length > 0
        ? `would also drop ${wouldRemove.length}`
        : null;

  return (
    <li
      data-testid={`scope-row-${card.id}`}
      data-selected={card.selected}
      data-origin={card.origin ?? 'OFF'}
      className={
        'flex items-center gap-3 border-b border-line-soft px-4 py-2 last:border-b-0 ' +
        (card.selected ? '' : 'bg-[repeating-linear-gradient(135deg,transparent,transparent_5px,rgba(148,143,129,0.05)_5px,rgba(148,143,129,0.05)_10px)]')
      }
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={pending}
        aria-pressed={card.selected}
        data-testid={`scope-toggle-${card.id}`}
        title={
          card.foundation
            ? 'Always included — nothing runs without it'
            : card.selected
              ? 'Switch off'
              : 'Switch on'
        }
        className={
          'grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border text-[10px] leading-none ' +
          (card.foundation
            ? 'cursor-not-allowed border-line bg-line-100 text-ink-4'
            : card.selected
              ? 'border-green bg-green/10 text-green'
              : 'border-line text-transparent hover:border-ink-4')
        }
      >
        {card.selected ? '✓' : ''}
      </button>

      <div className="min-w-0 flex-1">
        <p
          className={
            'truncate text-[13px] ' + (card.selected ? 'text-ink-1' : 'text-ink-4 line-through decoration-line')
          }
        >
          {card.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] text-ink-4">
          {card.foundation ? (
            <span data-testid={`scope-foundation-${card.id}`}>Always included</span>
          ) : card.needs.length > 0 ? (
            <>Needs {card.needs.map(titleOf).join(', ')}</>
          ) : (
            'No prerequisites'
          )}
          {consequence && <span className="text-ink-3"> · {consequence}</span>}
        </p>
      </div>

      {/* The provenance the reference artifact could not show: a module pulled
          in by a cascade is not one the client asked for. */}
      {card.origin === 'IMPLIED' && (
        <span
          data-testid={`scope-implied-${card.id}`}
          className="shrink-0 rounded-[3px] border border-line px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide text-ink-4"
        >
          Required
        </span>
      )}

      <span className="num shrink-0 text-[11.5px] text-ink-3">{card.taxedHours}h</span>
    </li>
  );
}
