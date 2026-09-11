'use client';

import { useSyncExternalStore } from 'react';

/**
 * Which panel the Inspect dock is showing, and whether it is showing anything.
 *
 * A store outside React rather than state inside the dock, for the same reason
 * `oracle-bus` exists: the things that open the dock are scattered across the
 * page and several sit on the far side of `LedgerProvider`, which remounts its
 * whole subtree whenever a run finishes. The ⌘K handler, a quotation that has
 * to get the panel out of its own way, and the edits notch inside the ledger
 * all move one piece of state, and two copies of it would drift within a
 * session — which is exactly how an open conversation gets lost.
 *
 * Deliberately NOT persisted. A dock that reopens itself on the next estimate
 * because you once looked at a diagnostic is a dock you have to close before
 * you can read the page, every time. AEH-377.
 */
export const DOCK_TABS = ['oracle', 'artifacts', 'diagnostics', 'activity', 'admin'] as const;
export type DockTab = (typeof DOCK_TABS)[number];

export type DockState = { open: boolean; tab: DockTab };

export type DockAction =
  | { kind: 'open'; tab: DockTab }
  | { kind: 'close' }
  /** What a notch does: show this tab, or close if it is the one showing. */
  | { kind: 'toggle'; tab: DockTab };

export const DOCK_CLOSED: DockState = { open: false, tab: 'oracle' };

/**
 * Where `EditActivity` renders its list.
 *
 * The one panel that cannot simply be handed to the dock as children: it reads
 * `useLedger`, so it has to mount inside `LedgerProvider`, and the dock mounts
 * outside it so a run finishing cannot wipe an open conversation. The portal
 * spans the boundary and this is the element it aims at.
 */
export const ACTIVITY_SLOT = 'dock-slot-activity';

/**
 * The whole of the dock's behaviour, as a function.
 *
 * Pure so the one rule that is easy to get backwards is assertable: picking the
 * tab already showing closes the dock, picking a different one switches to it
 * without closing. The rest of this file is subscription plumbing.
 */
export function nextDock(state: DockState, action: DockAction): DockState {
  switch (action.kind) {
    case 'open':
      return { open: true, tab: action.tab };
    case 'close':
      // The tab is kept, so reopening lands where you left off within a
      // session. Only `open` changes.
      return state.open ? { ...state, open: false } : state;
    case 'toggle':
      return state.open && state.tab === action.tab
        ? { ...state, open: false }
        : { open: true, tab: action.tab };
  }
}

let state: DockState = DOCK_CLOSED;
const listeners = new Set<() => void>();

function dispatch(action: DockAction) {
  const next = nextDock(state, action);
  // Referential equality is the contract `useSyncExternalStore` relies on:
  // a fresh object for an unchanged state re-renders every subscriber.
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export const openDock = (tab: DockTab) => dispatch({ kind: 'open', tab });
export const closeDock = () => dispatch({ kind: 'close' });
export const toggleDock = (tab: DockTab) => dispatch({ kind: 'toggle', tab });

export function useDock(): DockState {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => state,
    // The server has no dock. Returning the live object here would make the
    // first client render disagree with the markup it is hydrating.
    () => DOCK_CLOSED,
  );
}
