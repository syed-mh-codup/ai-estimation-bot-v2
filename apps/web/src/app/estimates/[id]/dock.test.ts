import { describe, it, expect } from 'vitest';
import { DOCK_CLOSED, DOCK_TABS, nextDock, type DockState } from './dock';

const OPEN_ON = (tab: DockState['tab']): DockState => ({ open: true, tab });

describe('the dock tabs', () => {
  it('are a closed set, Oracle first', () => {
    expect(DOCK_TABS[0]).toBe('oracle');
    expect(new Set(DOCK_TABS).size).toBe(DOCK_TABS.length);
  });

  it('start closed on Oracle, which is what the server renders', () => {
    expect(DOCK_CLOSED).toEqual({ open: false, tab: 'oracle' });
  });
});

describe('nextDock', () => {
  it('opens on the tab asked for, whatever was showing', () => {
    expect(nextDock(DOCK_CLOSED, { kind: 'open', tab: 'artifacts' })).toEqual(OPEN_ON('artifacts'));
    expect(nextDock(OPEN_ON('activity'), { kind: 'open', tab: 'oracle' })).toEqual(
      OPEN_ON('oracle'),
    );
  });

  /**
   * The e2e contract, and the reason this is a function rather than three
   * `setState` calls: a quoted span gets the panel out of its own way by
   * closing the dock, and `oracle.spec.ts` asserts the panel is then hidden.
   */
  it('closes without forgetting which tab it was on', () => {
    const closed = nextDock(OPEN_ON('activity'), { kind: 'close' });
    expect(closed.open).toBe(false);
    expect(closed.tab).toBe('activity');
  });

  it('is a no-op when closing an already closed dock', () => {
    const state = DOCK_CLOSED;
    // Identity, not equality: the store skips notifying on an unchanged state,
    // and `useSyncExternalStore` re-renders every subscriber if this lies.
    expect(nextDock(state, { kind: 'close' })).toBe(state);
  });

  describe('toggle — what a notch does', () => {
    it('opens on the picked tab from closed', () => {
      expect(nextDock(DOCK_CLOSED, { kind: 'toggle', tab: 'artifacts' })).toEqual(
        OPEN_ON('artifacts'),
      );
    });

    it('closes when the tab already showing is picked again', () => {
      expect(nextDock(OPEN_ON('artifacts'), { kind: 'toggle', tab: 'artifacts' })).toEqual({
        open: false,
        tab: 'artifacts',
      });
    });

    it('switches rather than closing when a different tab is picked', () => {
      expect(nextDock(OPEN_ON('artifacts'), { kind: 'toggle', tab: 'activity' })).toEqual(
        OPEN_ON('activity'),
      );
    });

    it('reopens a dock closed on that same tab', () => {
      const closedOnActivity: DockState = { open: false, tab: 'activity' };
      expect(nextDock(closedOnActivity, { kind: 'toggle', tab: 'activity' })).toEqual(
        OPEN_ON('activity'),
      );
    });
  });

  it('never invents a tab that is not in the set', () => {
    let state: DockState = DOCK_CLOSED;
    for (const tab of DOCK_TABS) {
      state = nextDock(state, { kind: 'toggle', tab });
      expect(DOCK_TABS).toContain(state.tab);
      state = nextDock(state, { kind: 'close' });
      expect(DOCK_TABS).toContain(state.tab);
    }
  });
});
