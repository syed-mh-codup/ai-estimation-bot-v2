import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@repo/db';
import { sweepDueReminders, SWEEP_LIMIT } from './reminders';

/**
 * The sweep's job is not "send email" — it is "send each nudge exactly once,
 * even when the step it runs in is retried". These tests pin the once-each part
 * and who the once goes to; the day arithmetic it delegates to is pinned
 * separately in due-date.test.ts.
 */

const due = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date('2026-09-12T04:00:00.000Z'); // 9am PKT on the 12th

type Candidate = {
  id: string;
  title: string;
  dueAt: Date | null;
  owner: { email: string; name: string | null };
  custodian: { email: string; name: string | null; disabledAt: Date | null } | null;
  reminders: { kind: string }[];
};

const findMany = vi.fn();
const upsert = vi.fn();

/** Only the two calls the sweep makes. Anything else should fail loudly. */
const db = {
  estimate: { findMany },
  estimateReminder: { upsert },
} as unknown as PrismaClient;

const send = vi.fn();

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    id: 'est-1',
    title: 'Acme portal',
    dueAt: due('2026-09-12'),
    owner: { email: 'owner@codup.co', name: 'Owen' },
    custodian: null,
    reminders: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
  send.mockResolvedValue({ sent: true });
});

describe('AEH-240: the daily deadline sweep', () => {
  it('only ever looks at unfinalised estimates that have a deadline', async () => {
    findMany.mockResolvedValue([]);
    await sweepDueReminders(db, NOW, send);

    const args = findMany.mock.calls[0]![0];
    expect(args.where).toEqual({ dueAt: { not: null }, status: { not: 'FINALISED' } });
    // Bounded, and the oldest deadlines win the budget — what gets deferred to
    // tomorrow is the least urgent, never the most.
    expect(args.take).toBe(SWEEP_LIMIT);
    expect(args.orderBy).toEqual({ dueAt: 'asc' });
  });

  it('sends the beat that is owed and records it', async () => {
    findMany.mockResolvedValue([candidate()]);
    const result = await sweepDueReminders(db, NOW, send);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({
      to: 'owner@codup.co',
      kind: 'DUE_TODAY',
      title: 'Acme portal',
      estimateId: 'est-1',
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { estimateId_kind: { estimateId: 'est-1', kind: 'DUE_TODAY' } },
      create: { estimateId: 'est-1', kind: 'DUE_TODAY', sentTo: 'owner@codup.co', delivered: true },
      update: {},
    });
    expect(result.sent).toEqual([
      { estimateId: 'est-1', kind: 'DUE_TODAY', to: 'owner@codup.co', delivered: true },
    ]);
  });

  it('does not send a beat that has already gone out', async () => {
    // This is the retry case. A step that crashed after ten sends re-runs the
    // whole loop; those ten are protected by their rows, and nothing else is.
    findMany.mockResolvedValue([candidate({ reminders: [{ kind: 'DUE_TODAY' }] })]);
    const result = await sweepDueReminders(db, NOW, send);

    expect(send).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(result.sent).toEqual([]);
  });

  it('still sends a later beat when an earlier one is on record', async () => {
    findMany.mockResolvedValue([candidate({ reminders: [{ kind: 'DUE_SOON' }] })]);
    await sweepDueReminders(db, NOW, send);

    expect(send.mock.calls[0]![0]).toMatchObject({ kind: 'DUE_TODAY' });
  });

  it('says nothing about a deadline that is still far off', async () => {
    findMany.mockResolvedValue([candidate({ dueAt: due('2026-10-30') })]);
    const result = await sweepDueReminders(db, NOW, send);

    expect(send).not.toHaveBeenCalled();
    expect(result.considered).toBe(1);
    expect(result.sent).toEqual([]);
  });

  it('nudges the custodian, not the owner, when there is one', async () => {
    findMany.mockResolvedValue([
      candidate({ custodian: { email: 'cust@codup.co', name: 'Casey', disabledAt: null } }),
    ]);
    await sweepDueReminders(db, NOW, send);

    expect(send.mock.calls[0]![0]).toMatchObject({
      to: 'cust@codup.co',
      name: 'Casey',
      recipient: 'custodian',
    });
  });

  it('tells the sender which branch it took, so the copy can be honest', async () => {
    // The owner receiving a nudge by default must not be told they are the
    // custodian — they are not, and the fix is for somebody to become one.
    findMany.mockResolvedValue([candidate()]);
    await sweepDueReminders(db, NOW, send);

    expect(send.mock.calls[0]![0]).toMatchObject({ to: 'owner@codup.co', recipient: 'owner' });
  });

  it('falls back to the owner when the custodian has been disabled', async () => {
    // Mailing somebody who can no longer sign in is the same as mailing nobody,
    // and a deadline with nobody watching it is the failure this feature exists
    // to prevent. The picker excludes disabled accounts; this covers the ones
    // disabled after they were named.
    findMany.mockResolvedValue([
      candidate({
        custodian: { email: 'gone@codup.co', name: 'Gone', disabledAt: new Date('2026-09-01') },
      }),
    ]);
    await sweepDueReminders(db, NOW, send);

    expect(send.mock.calls[0]![0]).toMatchObject({ to: 'owner@codup.co', recipient: 'owner' });
  });

  it('records the nudge even when the send did not go anywhere', async () => {
    // SMTP is optional here, so `sent: false` is the normal local state. Not
    // recording it would re-try forever and then deliver three months of
    // backlog the moment SMTP came back.
    send.mockResolvedValue({ sent: false });
    findMany.mockResolvedValue([candidate()]);
    await sweepDueReminders(db, NOW, send);

    expect(upsert.mock.calls[0]![0].create).toMatchObject({ delivered: false });
  });

  it('records each estimate as it goes, not in one batch at the end', async () => {
    // If the writes were batched, a crash on estimate three would re-send one
    // and two on retry. Interleaving is what bounds a retry to a single repeat.
    const order: string[] = [];
    send.mockImplementation(async (n: { estimateId: string }) => {
      order.push(`send:${n.estimateId}`);
      return { sent: true };
    });
    upsert.mockImplementation(async (a: { create: { estimateId: string } }) => {
      order.push(`record:${a.create.estimateId}`);
      return {};
    });
    findMany.mockResolvedValue([
      candidate({ id: 'a' }),
      candidate({ id: 'b' }),
      candidate({ id: 'c' }),
    ]);

    await sweepDueReminders(db, NOW, send);

    expect(order).toEqual([
      'send:a',
      'record:a',
      'send:b',
      'record:b',
      'send:c',
      'record:c',
    ]);
  });
});
