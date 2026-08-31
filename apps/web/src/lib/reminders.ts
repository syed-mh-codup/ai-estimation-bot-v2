/**
 * The daily deadline sweep: who is owed a nudge today, and the record that
 * stops them being nudged for the same thing twice.
 *
 * The arithmetic it acts on lives in lib/due-date.ts. This file is only the
 * part that touches the database and the mail sender.
 */
import type { PrismaClient, ReminderKind } from '@repo/db';
import { dueReminder } from './due-date';

/** What the sweep needs of a mail sender. Injected the way `notifyOwner` does
 *  it in inngest/functions.ts: the sweep's logic is worth exercising without
 *  reaching for SMTP. */
export type DueReminderSender = (n: {
  to: string;
  name?: string | null;
  title: string;
  estimateId: string;
  kind: ReminderKind;
  dueAt: Date;
  now: Date;
}) => Promise<{ sent: boolean }>;

/**
 * The most an ordinary sweep will handle. A ceiling, not a target: the whole
 * sweep is one Inngest step and a step has to fit inside Vercel's 300s Hobby
 * ceiling. Anything past it waits for tomorrow's run — ordered by due date, so
 * what waits is the least urgent.
 */
export const SWEEP_LIMIT = 200;

export type SweepResult = {
  considered: number;
  sent: { estimateId: string; kind: ReminderKind; to: string; delivered: boolean }[];
};

/**
 * Send the deadline reminders that are due, once each.
 *
 * Idempotency is the whole point. The loop runs inside one retriable Inngest
 * step, so a crash halfway through re-runs all of it: every estimate already
 * reminded is skipped by its EstimateReminder row, and that row is written per
 * estimate rather than batched at the end, so a retry can repeat at most the
 * single estimate that was in flight.
 *
 * Recipient is the custodian, falling back to the owner — including when the
 * custodian's account has since been disabled, because mailing somebody who
 * cannot sign in is the same as mailing nobody.
 */
export async function sweepDueReminders(
  db: PrismaClient,
  now: Date,
  send: DueReminderSender,
): Promise<SweepResult> {
  const candidates = await db.estimate.findMany({
    // FINALISED work has no deadline left to miss, which is also why the rail
    // stops offering the field once an estimate is finalised.
    where: { dueAt: { not: null }, status: { not: 'FINALISED' } },
    orderBy: { dueAt: 'asc' },
    take: SWEEP_LIMIT,
    select: {
      id: true,
      title: true,
      dueAt: true,
      owner: { select: { email: true, name: true } },
      custodian: { select: { email: true, name: true, disabledAt: true } },
      reminders: { select: { kind: true } },
    },
  });

  const sent: SweepResult['sent'] = [];

  for (const est of candidates) {
    if (!est.dueAt) continue;
    const kind = dueReminder(est.dueAt, now);
    if (!kind) continue;
    if (est.reminders.some((r) => r.kind === kind)) continue;

    const custodian = est.custodian && !est.custodian.disabledAt ? est.custodian : null;
    const recipient = custodian ?? est.owner;

    // Send first, record second. The sender never throws, so the only way to
    // land between the two is a hard crash — and for a deadline nudge a repeat
    // is an annoyance where a silent miss is the exact failure this feature
    // exists to prevent.
    const { sent: delivered } = await send({
      to: recipient.email,
      name: recipient.name,
      title: est.title,
      estimateId: est.id,
      kind,
      dueAt: est.dueAt,
      now,
    });

    // Upsert rather than create: two sweeps overlapping would otherwise race
    // into a unique violation and fail the step. The row already existing means
    // the work is done, so there is nothing to update.
    await db.estimateReminder.upsert({
      where: { estimateId_kind: { estimateId: est.id, kind } },
      create: { estimateId: est.id, kind, sentTo: recipient.email, delivered },
      update: {},
    });

    sent.push({ estimateId: est.id, kind, to: recipient.email, delivered });
  }

  return { considered: candidates.length, sent };
}
