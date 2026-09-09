import { describe, expect, it, vi } from 'vitest';

import { createSerialSaver } from './serial-save';

/**
 * AEH-238. The saving contract for a whole-list editor.
 *
 * The assumptions editor wrote the entire list on every change, so deleting
 * four lines fired four writes at once over the same rows and the last one
 * delivered won. The reporter hit it twice: "I delete multiple, refresh, and
 * only one is gone."
 *
 * These are the invariants that stop it recurring, and each one is a sentence
 * about what a person sees rather than about the implementation:
 *
 *   never two writers at once      no race to lose
 *   the last write carries the
 *     latest state                 the screen and the database agree at rest
 *   a burst costs one trailing
 *     write, not N                 which is also what stopped the 485-row
 *                                  timeout being reachable by mashing delete
 *   a failure rolls back and
 *     does not re-push             a rejected change stays rejected
 */

/**
 * Let the microtask queue drain.
 *
 * Needed because settling a send only makes the NEXT one start — `whenIdle`
 * would then wait for that trailing write, which the test has not settled yet.
 * The first version of this file awaited `whenIdle` there and deadlocked on
 * itself.
 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A send that resolves when the test says so. */
function deferredSend<T>() {
  const calls: T[] = [];
  const resolvers: Array<(err?: unknown) => void> = [];
  const send = vi.fn((value: T) => {
    calls.push(value);
    return new Promise<void>((resolve, reject) => {
      resolvers.push((err) => (err === undefined ? resolve() : reject(err)));
    });
  });
  return {
    send,
    calls,
    /** Complete the Nth outstanding send. */
    settle: (index = 0, err?: unknown) => {
      const r = resolvers[index];
      if (!r) throw new Error(`no outstanding send at ${index}`);
      r(err);
    },
    outstanding: () => resolvers.length,
  };
}

describe('createSerialSaver', () => {
  it('never has two writes in flight at once', async () => {
    let value = 'a';
    const { send, settle } = deferredSend<string>();
    const saver = createSerialSaver<string>({
      read: () => value,
      send,
      onSaved: () => {},
      onFailed: () => {},
    });

    saver.schedule();
    value = 'b';
    saver.schedule();
    value = 'c';
    saver.schedule();

    // Three asks, ONE writer. This is the whole point: the old code would have
    // had three concurrent whole-list writes over the same rows.
    expect(send).toHaveBeenCalledTimes(1);

    settle(0);
    await flush();

    // And exactly one more, carrying the state as it ended up — not 'b', which
    // was already superseded when the second write became possible.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe('c');

    settle(1);
    await saver.whenIdle();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('costs ONE trailing write however many changes arrive during the first', async () => {
    let value = 0;
    const { send, settle } = deferredSend<number>();
    const saver = createSerialSaver<number>({
      read: () => value,
      send,
      onSaved: () => {},
      onFailed: () => {},
    });

    saver.schedule();
    // Twenty rapid deletions, the shape the reporter was making by hand.
    for (let i = 1; i <= 20; i += 1) {
      value = i;
      saver.schedule();
    }
    settle(0);
    await flush();
    settle(1);
    await saver.whenIdle();

    // Twenty-one asks, two writes. The old code would have made twenty-one
    // concurrent whole-list writes — which on a 485-row list is also how the
    // transaction timeout became reachable by mashing delete.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]?.[0]).toBe(20);
  });

  it('reads the value when the write STARTS, not when it was asked for', async () => {
    let value = 'first';
    const { send, settle } = deferredSend<string>();
    const saver = createSerialSaver<string>({
      read: () => value,
      send,
      onSaved: () => {},
      onFailed: () => {},
    });

    saver.schedule();
    settle(0);
    await saver.whenIdle();
    expect(send.mock.calls[0]?.[0]).toBe('first');

    // A change while nothing is in flight goes straight out, at its new value.
    value = 'second';
    saver.schedule();
    await flush();
    settle(1);
    await saver.whenIdle();
    expect(send.mock.calls[1]?.[0]).toBe('second');
  });

  it('reports a failure with the value that did NOT land', async () => {
    const { send, settle } = deferredSend<string>();
    const onFailed = vi.fn();
    const onSaved = vi.fn();
    const saver = createSerialSaver<string>({
      read: () => 'rejected',
      send,
      onSaved,
      onFailed,
    });

    saver.schedule();
    settle(0, new Error('locked'));
    await saver.whenIdle();

    expect(onSaved).not.toHaveBeenCalled();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed.mock.calls[0]?.[1]).toBe('rejected');
  });

  it('does not re-push a queued change after a failure', async () => {
    let value = 'a';
    const { send, settle } = deferredSend<string>();
    const saver = createSerialSaver<string>({
      read: () => value,
      send,
      onSaved: () => {},
      onFailed: () => {
        // What the component does: roll the list back to what the server has.
        value = 'server';
      },
    });

    saver.schedule();
    value = 'b';
    saver.schedule(); // queued behind the one that is about to fail
    settle(0, new Error('refused'));
    await saver.whenIdle();

    // The queued write is dropped. Sending it would push the rejected change
    // straight back up over the rollback the caller just did.
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('is idle immediately when nothing has been scheduled', async () => {
    const { send } = deferredSend<string>();
    const saver = createSerialSaver<string>({
      read: () => 'x',
      send,
      onSaved: () => {},
      onFailed: () => {},
    });
    await saver.whenIdle();
    expect(send).not.toHaveBeenCalled();
  });
});
