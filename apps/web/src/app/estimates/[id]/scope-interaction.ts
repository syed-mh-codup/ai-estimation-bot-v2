import { turnOff, turnOn, type SelectionChange, type SelectionState } from '@repo/shared';

/**
 * What one click on the configurator means — pure. AEH-235.
 *
 * Extracted from `ScopeConfigurator` because it was all trapped in a component,
 * and a component in this repo cannot be tested: vitest runs `environment:
 * 'node'`, the include pattern is `*.test.ts`, and there is no jsdom or
 * testing-library. So the only cover this logic had was Playwright, which is
 * minutes per run — and the notice copy, the pluralisation, the undo bounds and
 * the save states are all things worth checking in milliseconds.
 *
 * Nothing here touches React or the DOM. The component is now the wiring: it
 * calls these, holds the results in state, and renders them.
 */

export type NoticeKind = 'added' | 'removed' | 'refused';
export type Notice = { text: string; kind: NoticeKind };

export type UndoStep = { picks: string[]; label: string };

/** The most undo history worth keeping. Beyond this it is not undo, it is a log. */
export const UNDO_LIMIT = 10;

/** A card as the interaction layer needs to see it. */
export type ToggleTarget = {
  id: string;
  title: string;
  selected: boolean;
  foundation: boolean;
};

export type ToggleOutcome =
  | { kind: 'refused'; notice: Notice }
  | {
      kind: 'applied';
      notice: Notice;
      /** The new durable pick set to persist. */
      picks: string[];
      /** For the undo stack. */
      undoLabel: string;
      change: SelectionChange;
    };

/**
 * Resolve a click into what to say and what to store.
 *
 * The notice is the whole point of the off-cascade. The reference artifact this
 * feature was specified against removes dependents silently, and measured
 * against its own data one click can remove 32 of 45 modules — so the text
 * below names them, and names how many, because "switched off" alone would be
 * a lie about what just happened.
 */
export function resolveToggle(
  state: SelectionState,
  card: ToggleTarget,
  titleOf: (id: string) => string,
): ToggleOutcome {
  if (card.foundation) {
    return {
      kind: 'refused',
      notice: {
        text: `${card.title} is always included — nothing runs without it.`,
        kind: 'refused',
      },
    };
  }

  const change = card.selected ? turnOff(state, card.id) : turnOn(state, card.id);
  if (change.refused) {
    return {
      kind: 'refused',
      notice: {
        text:
          change.refused === 'FOUNDATION'
            ? `${card.title} is always included — nothing runs without it.`
            : `${card.title} is no longer part of this estimate. Reload the page.`,
        kind: 'refused',
      },
    };
  }

  const picks = [...change.picks];

  if (card.selected) {
    return {
      kind: 'applied',
      picks,
      change,
      undoLabel: `switched off ${card.title}`,
      notice: {
        kind: 'removed',
        text:
          change.removed.length > 0
            ? `${card.title} switched off. ${change.removed.length} other ${plural(
                change.removed.length,
                'module',
              )} went with it: ${change.removed.map(titleOf).join(', ')}.`
            : `${card.title} switched off.`,
      },
    };
  }

  return {
    kind: 'applied',
    picks,
    change,
    undoLabel: `switched on ${card.title}`,
    notice: {
      kind: 'added',
      text:
        change.added.length > 0
          ? `${card.title} switched on, and it needs ${change.added.length} more: ${change.added
              .map(titleOf)
              .join(', ')}.`
          : `${card.title} switched on.`,
    },
  };
}

/** Push an entry, newest first, bounded. */
export function pushUndo(stack: UndoStep[], step: UndoStep): UndoStep[] {
  return [step, ...stack].slice(0, UNDO_LIMIT);
}

export type SaveState = 'saving' | 'saved' | 'idle';

/**
 * What the save indicator should read.
 *
 * `savedAt` is a timestamp rather than a boolean so that a second save during
 * the confirmation window restarts it instead of being swallowed by a flag that
 * is already true — which would leave "Saved" showing from the *previous*
 * change while a new one is in flight.
 *
 * `saving` outranks a recent `savedAt` for the same reason: mid-write, what the
 * screen must say is that the numbers are not settled yet.
 */
export function saveStateOf(args: { pending: boolean; savedAt: number }): SaveState {
  if (args.pending) return 'saving';
  return args.savedAt > 0 ? 'saved' : 'idle';
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
