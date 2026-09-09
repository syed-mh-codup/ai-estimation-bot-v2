/**
 * One-at-a-time saving for an editor that writes a WHOLE list. AEH-238.
 *
 * ## The bug this exists to prevent
 *
 * The assumptions editor saved the entire list on every change. Deleting four
 * lines therefore fired four whole-list writes, all in flight together, all
 * over the same rows — and the one that survived was whichever the network
 * happened to deliver last. The reporter saw it as "I delete multiple, refresh,
 * and only one is gone".
 *
 * Firing per change is the wrong shape for a whole-list write. The right shape
 * is: at most one in flight, and whatever the list has become when that one
 * returns gets written next. A burst of edits then costs ONE trailing write and
 * converges on exactly what is on screen.
 *
 * ## Why this is not in the component
 *
 * Because it is a concurrency contract, and a concurrency contract that cannot
 * be tested is a concurrency contract that will break again. There is no DOM
 * renderer in this test setup, so as long as the sequencing lived inside a
 * React component nothing could assert it. Out here it is nine lines of state
 * and `serial-save.test.ts` can drive it with deferred promises.
 *
 * ## The reading it deliberately does NOT take
 *
 * It does not queue every scheduled save. Two edits while one write is in
 * flight are not two more writes — they are one, of the later state. Anything
 * else would send stale payloads the newer ones only overwrite.
 */

export type SerialSaver = {
  /** Ask for the current value to be written. Coalesces while one is in flight. */
  schedule: () => void;
  /** Resolves when nothing is in flight and nothing is pending. For tests. */
  whenIdle: () => Promise<void>;
};

export function createSerialSaver<T>(args: {
  /** The value to send, read at the moment a write actually starts. */
  read: () => T;
  send: (value: T) => Promise<void>;
  /** The send succeeded. `value` is what the server now holds. */
  onSaved: (value: T) => void;
  /** The send threw. `value` is what was attempted and did NOT land. */
  onFailed: (error: unknown, value: T) => void;
}): SerialSaver {
  const { read, send, onSaved, onFailed } = args;

  let inFlight = false;
  let pending = false;
  let idleWaiters: Array<() => void> = [];

  const settleIdle = (): void => {
    if (inFlight || pending) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  };

  const run = async (): Promise<void> => {
    inFlight = true;
    pending = false;
    // Read HERE, not when `schedule` was called: the point is to send the
    // list as it is now, which may be several edits further on.
    const value = read();
    try {
      await send(value);
      onSaved(value);
    } catch (e) {
      onFailed(e, value);
      // A failure discards what was queued behind it. The caller has just
      // rolled the list back to what the server accepted, so writing the
      // pending state would push the rejected change straight back up.
      pending = false;
    } finally {
      inFlight = false;
      if (pending) void run();
      else settleIdle();
    }
  };

  return {
    schedule: () => {
      if (inFlight) {
        pending = true;
        return;
      }
      void run();
    },
    whenIdle: () =>
      new Promise<void>((resolve) => {
        if (!inFlight && !pending) {
          resolve();
          return;
        }
        idleWaiters.push(resolve);
      }),
  };
}
